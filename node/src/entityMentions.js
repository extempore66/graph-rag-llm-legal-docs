// Persistence layer for je_entity_mentions (LanceDB) -- Step 4's per-mention
// context-snippet vectors, one row per mention rather than per entity, so a
// candidate search compares against an entity's whole cloud of phrasing
// instead of one blurred average vector (see
// _project_step_by_step_plan.md, Step 4).
//
// Includes chunk_id, which the original design doc didn't list -- added
// because without it, a candidate mention surfaced by searchSimilarMentions
// can't be traced back to which specific je_mentioned_in edge (for role) or
// which specific chunk (for docket/date context) it came from, and Step 5
// needs both to judge a candidate on real facts rather than just the
// snippet text alone.

import * as lancedb from "@lancedb/lancedb";
import { LANCEDB_DIR, LANCEDB_ENTITY_MENTIONS_TABLE, comparableTypes } from "./config.js";

let lanceDbConnection = null;
async function getLanceDb() {
  if (!lanceDbConnection) {
    lanceDbConnection = await lancedb.connect(LANCEDB_DIR);
  }
  return lanceDbConnection;
}

// Lazy-create, same idea as processFile.js's writeLanceRows -- LanceDB infers
// a table's schema from its first batch of rows, so creation and insertion are
// the same call the first time, plain add() after that.
//
// The original version did `tableNames()` then openTable-or-createTable, which
// is check-then-act and raced under DEDUP_CONCURRENCY=3. On a cold start (empty
// table, three workers arriving at once) tableNames() could report the table
// present while its `_versions` directory was still uncommitted, and openTable
// blew up with "exists but could not be loaded (it may be corrupt or
// incomplete)". Cost one chunk on each of the two full runs -- survivable,
// because the chunk stays un-flagged and retries, but it's noise in the
// failure log and it makes a clean zero-failure run impossible.
//
// Fixed with an in-process creation lock rather than a retry loop. All three
// workers live in one Node process, so a single shared promise is sufficient:
// whoever arrives first decides whether the table needs creating, everyone else
// awaits that same decision instead of racing it. seedRow tracks the one row
// that gets consumed as the creation batch, so its owner doesn't add it twice;
// if the table turned out to already exist, seedRow is cleared and that caller
// adds normally like everyone else. On failure the lock resets rather than
// staying permanently rejected, so a later mention can still retry.
let tableReady = null;
let seedRow = null;

// Periodic compaction. Lance is a versioned, immutable format: every write
// creates a new fragment file plus a new *manifest*, and a manifest is a full
// snapshot of the fragment list rather than a delta -- that's what makes
// opening a table one read with no replay. The cost is that manifest N is
// O(N) bytes, so N single-row appends write O(N^2) total.
//
// Measured on the v3 run, which wrote one row per call with no compaction:
// 17,557 mentions produced 16,459 versions, 129 MB of actual vectors, and
// 11 GB of manifests. The size curve was exactly linear (version 1 = 4 KB,
// version 5,000 = 572 KB, version 16,459 = 1.4 MB), and 85 bytes/fragment
// x 16,459^2 / 2 reproduces the 11 GB to within rounding.
//
// The disk is the cheap part. The real cost is per-operation and it *grows
// with progress*: by the end of that run every append was reading and
// rewriting a 1.4 MB manifest to store a 4 KB vector, openTable reparsed it
// on every write and every search, and searchSimilarMentions brute-force
// scanned 16,459 separate fragment files per lookup. That is the shape of a
// pass whose per-chunk cost climbs steadily -- which v3's did.
//
// Compaction merges the accumulated small fragments into one large one, so
// the next manifest is small again. That converts total manifest volume from
// O(N^2) to O(N x interval), and caps search fan-out at `interval` files
// instead of letting it grow unbounded.
//
// Deliberately NOT passing cleanupOlderThan/deleteUnverified. Pruning old
// versions looks like the obvious fix and isn't: LanceDB refuses to delete
// files younger than 7 days unless deleteUnverified is set, because they may
// belong to an in-progress transaction -- and every file here is minutes old,
// so a prune would reclaim essentially nothing. Setting deleteUnverified
// would reclaim it and can corrupt the dataset if anything else is mid-write,
// which under DEDUP_CONCURRENCY=3 is true by construction. Compaction alone
// stops the growth; a one-shot prune is safe only after the run ends, when
// nothing is writing.
const OPTIMIZE_EVERY_N_WRITES = 500;
let writesSinceOptimize = 0;
let optimizeInFlight = null;

async function maybeOptimize(table) {
  if (++writesSinceOptimize < OPTIMIZE_EVERY_N_WRITES) return;
  // Another worker is already compacting -- skip rather than queue. Under
  // DEDUP_CONCURRENCY=3 all three workers cross the threshold at nearly the
  // same moment, and running three overlapping compactions of the same
  // dataset buys nothing and invites commit conflicts.
  if (optimizeInFlight) return;

  // Reset before awaiting, not after: the other two workers keep writing
  // while this compaction runs, and they should start counting toward the
  // *next* interval rather than re-triggering this one.
  writesSinceOptimize = 0;
  const started = Date.now();
  optimizeInFlight = table
    .optimize()
    .then((stats) => {
      const secs = ((Date.now() - started) / 1000).toFixed(1);
      console.log(
        `  [lance] compacted ${stats.compaction.fragmentsRemoved} fragment(s) ` +
          `into ${stats.compaction.fragmentsAdded} in ${secs}s`
      );
    })
    // Compaction is an optimization, never a correctness requirement: the
    // data is already committed by the time we get here. A failure must not
    // fail the mention write that happened to trigger it.
    .catch((err) => console.warn(`  [lance] compaction skipped: ${err.message}`))
    .finally(() => {
      optimizeInFlight = null;
    });

  // Awaited rather than fire-and-forget, so one worker pauses for the
  // duration and the pass gets natural backpressure instead of stacking
  // background work the runner never observes.
  await optimizeInFlight;
}

export async function writeEntityMention(row) {
  const db = await getLanceDb();

  if (!tableReady) {
    seedRow = row;
    tableReady = (async () => {
      try {
        await db.openTable(LANCEDB_ENTITY_MENTIONS_TABLE);
        seedRow = null; // already existed -- nobody's row was consumed
      } catch {
        await db.createTable(LANCEDB_ENTITY_MENTIONS_TABLE, [seedRow]);
      }
    })().catch((err) => {
      tableReady = null;
      seedRow = null;
      throw err;
    });
  }
  await tableReady;

  if (seedRow === row) return; // this row was written as the creation batch

  const table = await db.openTable(LANCEDB_ENTITY_MENTIONS_TABLE);
  await table.add([row]);
  await maybeOptimize(table);
}

// End-of-run reclaim. Periodic compaction keeps the *live* fragment list
// short, but superseded fragments and manifests stay on disk -- a full run
// leaves ~1 GB of dead copies behind for ~60 MB of live data.
//
// deleteUnverified is required because Lance protects files under 7 days old
// (they may belong to an in-progress transaction) and every file here is hours
// old. That flag is unsafe with a concurrent writer, so this must only ever be
// called once the worker pool has drained -- see the call site in
// dedupBatchRunner.js. Nothing else writes this table: Step 7 doesn't touch it.
//
// Best-effort: reclaiming disk is housekeeping, never a reason to fail a run
// whose real work already committed.
export async function pruneEntityMentions() {
  const db = await getLanceDb();
  let table;
  try {
    table = await db.openTable(LANCEDB_ENTITY_MENTIONS_TABLE);
  } catch {
    return null; // nothing was written this run
  }
  try {
    const stats = await table.optimize({ cleanupOlderThan: new Date(), deleteUnverified: true });
    return { bytesRemoved: stats.prune.bytesRemoved, versionsRemoved: stats.prune.oldVersionsRemoved };
  } catch (err) {
    console.warn(`  [lance] prune skipped: ${err.message}`);
    return null;
  }
}

// Step 4's embedding channel: cosine similarity over context_snippet vectors,
// scoped to entityType's comparable-type group so a person mention is never
// compared against a place or an institution -- while a place mistyped as
// "court" can still match itself typed "location". Returns [] if the table
// doesn't exist yet (the very first mention of the very first entity has
// nothing to compare against) rather than erroring.
// The open is inside the try for the same cold-start reason as
// writeEntityMention above: tableNames() reporting the table present is not a
// guarantee that openTable will succeed a moment later. On this read path
// "not loadable yet" and "doesn't exist yet" have the same correct answer --
// no candidates -- so both collapse into returning [], and Jaro-Winkler still
// runs. Deliberately not distinguishing the two: this races only on the very
// first mentions of a cold run, when there is genuinely nothing to find.
export async function searchSimilarMentions(vector, entityType, limit) {
  const db = await getLanceDb();
  let table;
  try {
    table = await db.openTable(LANCEDB_ENTITY_MENTIONS_TABLE);
  } catch {
    return [];
  }
  // Scoped to the comparable-type group, not the exact type -- same reason as
  // getEntitiesByType in entities.js: a place mistyped as "court" in one chunk
  // must still be able to match itself typed "location" in another.
  const typeList = comparableTypes(entityType)
    .map((t) => `'${t.replace(/'/g, "''")}'`)
    .join(", ");
  return table
    .search(vector)
    .distanceType("cosine")
    .where(`entity_type IN (${typeList})`)
    .limit(limit)
    .toArray();
}
