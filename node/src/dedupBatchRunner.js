// Steps 4-6 -- walks every chunk in je_raw_extractions not yet processed
// for dedup, and for each of its entities: finds candidates (Step 4), gets
// an LLM judgment if any candidates were found (Step 5), and writes the
// result (Step 6) -- either upserting onto a matched entity, creating a
// genuinely new one, or creating a new one plus flagging possible-duplicate
// edges for anything judged "unsure".
//
// Entities are resolved with bounded concurrency (DEDUP_CONCURRENCY, see
// config.js) instead of strictly sequentially. This reopens a real race --
// two concurrently-resolved entities that are actually the same real-world
// person can each miss the other (both see an empty candidate list before
// either's write lands) and end up as two separate je_entities nodes. That
// race is accepted deliberately here, not fixed with locking: parallelize
// for speed, then run a separate cleanup pass afterward to merge whatever
// duplicates it produced. Confirmed with the user 2026-08-18 after
// measuring ~31s/chunk sequential (multi-day for the full backlog).
//
// Resumable at chunk granularity, same as before: a chunk is marked
// dedup_processed only once every one of its entities succeeded, tracked
// here across out-of-order concurrent completions rather than a simple
// end-of-loop check. An interrupted run retries the whole chunk it was
// mid-way through, not just the remaining entities -- same "acceptable,
// simpler than per-entity tracking" tradeoff used elsewhere in this project.

import fs from "node:fs";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { LANCEDB_DIR, LANCEDB_CHUNKS_TABLE, PROJECT_ROOT, DEDUP_CONCURRENCY } from "./config.js";
import { getUnprocessedForDedup, markDedupProcessed } from "./rawExtractions.js";
import {
  ensureEntitiesCollections,
  createEntity,
  writeMentionedInEdge,
  writePossibleDuplicateEdge,
} from "./entities.js";
import { writeEntityMention, pruneEntityMentions } from "./entityMentions.js";
import { findCandidates, buildMentionEmbedding } from "./dedupCandidates.js";
import { judgeCandidates } from "./dedupJudgment.js";
import { withLock, entityLockKey } from "./asyncLock.js";

// Optional cap for testing against a small slice before committing to the
// full run -- e.g. `node src/dedupBatchRunner.js 10`. Omit for the real run.
const limit = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;

const logsDir = path.join(PROJECT_ROOT, "node", "logs");
fs.mkdirSync(logsDir, { recursive: true });
const failuresLogPath = path.join(logsDir, "dedup_failures.jsonl");
fs.writeFileSync(failuresLogPath, "");

function logFailure(chunkId, entityIndex, entityName, err) {
  const line = JSON.stringify({
    chunk_id: chunkId,
    entity_index: entityIndex,
    entity_name: entityName,
    error: err.message,
    failed_at: new Date().toISOString(),
  });
  fs.appendFileSync(failuresLogPath, line + "\n");
}

// One entity mention through Steps 4-6. Returns the entity_id it ended up
// attached to (matched or newly created).
async function processEntity(entity, chunk, chunkText) {
  const chunkFacts = { docket_numbers: chunk.docket_numbers, dates: chunk.dates };

  // Embedding is computed outside the lock on purpose: it's the slowest step
  // that touches nothing shared, so holding the lock across it would serialise
  // same-name mentions for no correctness gain.
  const mentionEmbedding = await buildMentionEmbedding(entity, chunkText);

  // Everything from "look for an existing match" through "create if there
  // wasn't one" is one critical section per entity name+type. findCandidates
  // MUST be inside it -- that's the read half of the check-then-act, and
  // leaving it outside would preserve the exact race this closes (worker A and
  // worker B both look, both see nothing, both create). Different names never
  // contend, so in practice only repeat mentions of the same person serialise.
  //
  // The LLM judgment sits inside the lock too, which is the real cost here.
  // Accepted deliberately: correctness of the read is what makes the write
  // safe, and a candidate list fetched before the lock could be stale by the
  // time judgment finishes.
  const { entityId, matchedEntityId, unsureCandidateIds } = await withLock(
    entityLockKey(entity.name, entity.type),
    async () => {
      const candidates = await findCandidates(entity, mentionEmbedding);

      let matchedEntityId = null;
      let unsureCandidateIds = [];

      if (candidates.length > 0) {
        const judgments = await judgeCandidates(entity, chunkFacts, candidates);
        const same = judgments.find((j) => j.verdict === "same");
        if (same) {
          matchedEntityId = same.entity_id;
        } else {
          unsureCandidateIds = judgments.filter((j) => j.verdict === "unsure").map((j) => j.entity_id);
        }
      }

      const entityId =
        matchedEntityId ?? (await createEntity({ name: entity.name, type: entity.type }));

      return { entityId, matchedEntityId, unsureCandidateIds };
    }
  );

  if (!matchedEntityId) {
    for (const candidateId of unsureCandidateIds) {
      await writePossibleDuplicateEdge(entityId, candidateId, "Step 5 judgment: unsure");
    }
  }

  await writeMentionedInEdge(entityId, chunk._key, {
    role: entity.candidate_role,
    textual_evidence: entity.textual_evidence,
    confidence: entity.confidence,
  });

  if (mentionEmbedding) {
    await writeEntityMention({
      entity_id: entityId,
      mention_text: entity.name,
      context_snippet: mentionEmbedding.snippet,
      vector: mentionEmbedding.vector,
      entity_type: entity.type,
      chunk_id: chunk._key,
    });
  }

  return entityId;
}

// Runs `worker` over every item in `items`, at most `concurrency` at a time.
// No external dependency -- a fixed-size pool that pulls the next item as
// soon as a slot frees up, rather than chunking items into fixed batches
// (which would idle a slot whenever one item in a batch runs long).
function runWithConcurrency(items, concurrency, worker) {
  return new Promise((resolve, reject) => {
    if (items.length === 0) return resolve();
    let nextIndex = 0;
    let inFlight = 0;
    let settled = 0;
    let failed = false;

    function launchNext() {
      if (failed) return;
      while (inFlight < concurrency && nextIndex < items.length) {
        const item = items[nextIndex++];
        inFlight++;
        worker(item)
          .catch((err) => {
            failed = true;
            reject(err);
          })
          .finally(() => {
            inFlight--;
            settled++;
            if (!failed) {
              if (settled === items.length) resolve();
              else launchNext();
            }
          });
      }
    }
    launchNext();
  });
}

await ensureEntitiesCollections();

const lanceDb = await lancedb.connect(LANCEDB_DIR);
const chunksTable = await lanceDb.openTable(LANCEDB_CHUNKS_TABLE);

// Memoized per-chunk text fetch -- multiple entities from the same chunk
// run concurrently and all need this, but it should only hit LanceDB once
// per chunk, not once per entity.
const chunkTextCache = new Map();
function getChunkText(chunkKey) {
  if (!chunkTextCache.has(chunkKey)) {
    const escaped = chunkKey.replace(/'/g, "''");
    chunkTextCache.set(
      chunkKey,
      chunksTable
        .query()
        .where(`chunk_id = '${escaped}'`)
        .limit(1)
        .toArray()
        .then((rows) => (rows.length > 0 ? rows[0].text : null))
    );
  }
  return chunkTextCache.get(chunkKey);
}

const chunks = await getUnprocessedForDedup();
const totalToAttempt = Math.min(chunks.length, limit);
const chunksToAttempt = chunks.slice(0, totalToAttempt);
console.log(
  `Found ${chunks.length} unprocessed chunks for dedup${limit < Infinity ? ` (processing first ${limit})` : ""}. Concurrency: ${DEDUP_CONCURRENCY}.`
);

// Per-chunk completion tracking -- entities from different chunks complete
// in whatever order the concurrency pool finishes them, so "is this chunk
// fully done" can't just be an end-of-loop check like the sequential
// version used; it's tracked per chunk as entities finish.
const chunkState = new Map();
let chunksDone = 0;

const jobs = [];
for (const chunk of chunksToAttempt) {
  if (chunk.entities.length === 0) {
    chunkState.set(chunk._key, { remaining: 0, ok: true });
    continue;
  }
  chunkState.set(chunk._key, { remaining: chunk.entities.length, ok: true });
  for (let i = 0; i < chunk.entities.length; i++) {
    jobs.push({ chunk, entityIndex: i });
  }
}

let entitiesProcessed = 0;
let entitiesFailed = 0;
const start = Date.now();

async function finishChunkIfDone(chunkKey) {
  const state = chunkState.get(chunkKey);
  if (state.remaining > 0) return;
  chunksDone++;
  if (state.ok) await markDedupProcessed(chunkKey);
  console.log(`[${chunksDone}/${chunksToAttempt.length}] ${chunkKey} -- done${state.ok ? "" : " (with failures)"}`);
}

// Chunks with zero entities were marked "ok" above with remaining already
// at 0 -- flush them through markDedupProcessed before the job pool starts.
for (const chunk of chunksToAttempt) {
  if (chunk.entities.length === 0) await finishChunkIfDone(chunk._key);
}

await runWithConcurrency(jobs, DEDUP_CONCURRENCY, async ({ chunk, entityIndex }) => {
  const entity = chunk.entities[entityIndex];
  try {
    const chunkText = await getChunkText(chunk._key);
    if (chunkText === null) {
      throw new Error("chunk not found in LanceDB je_chunks");
    }
    await processEntity(entity, chunk, chunkText);
    entitiesProcessed++;
  } catch (err) {
    entitiesFailed++;
    chunkState.get(chunk._key).ok = false;
    logFailure(chunk._key, entityIndex, entity.name, err);
    console.error(`[FAILED] ${chunk._key} entity ${entityIndex} (${entity.name}): ${err.message}`);
  }
  const state = chunkState.get(chunk._key);
  state.remaining--;
  await finishChunkIfDone(chunk._key);
});

// Safe here and nowhere earlier: runWithConcurrency has resolved, so every
// worker is finished and this process is the table's only remaining user.
const pruned = await pruneEntityMentions();
if (pruned) {
  console.log(
    `[lance] reclaimed ${(pruned.bytesRemoved / 1e6).toFixed(0)} MB across ` +
      `${pruned.versionsRemoved} superseded version(s)`
  );
}

const elapsedMin = ((Date.now() - start) / 60000).toFixed(1);
console.log(
  `\nDone in ${elapsedMin} min. Chunks processed: ${chunksDone}, entities processed: ${entitiesProcessed}, entity failures: ${entitiesFailed}.`
);
if (entitiesFailed > 0) {
  console.log(`Chunks with failures were left un-flagged as dedup_processed and will retry in full on the next run. Detail in ${failuresLogPath}.`);
}
