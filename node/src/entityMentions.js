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
import { LANCEDB_DIR, LANCEDB_ENTITY_MENTIONS_TABLE } from "./config.js";

let lanceDbConnection = null;
async function getLanceDb() {
  if (!lanceDbConnection) {
    lanceDbConnection = await lancedb.connect(LANCEDB_DIR);
  }
  return lanceDbConnection;
}

// Same lazy-create pattern as processFile.js's writeLanceRows -- LanceDB
// infers a table's schema from its first batch of rows, so creation and
// insertion are the same call the first time, plain add() after that.
export async function writeEntityMention(row) {
  const db = await getLanceDb();
  const tableNames = await db.tableNames();
  if (tableNames.includes(LANCEDB_ENTITY_MENTIONS_TABLE)) {
    const table = await db.openTable(LANCEDB_ENTITY_MENTIONS_TABLE);
    await table.add([row]);
  } else {
    await db.createTable(LANCEDB_ENTITY_MENTIONS_TABLE, [row]);
  }
}

// Step 4's embedding channel: cosine similarity over context_snippet
// vectors, scoped to entityType so a person mention is never compared
// against a court or org mention. Returns [] if the table doesn't exist yet
// (the very first mention of the very first entity has nothing to compare
// against) rather than erroring.
export async function searchSimilarMentions(vector, entityType, limit) {
  const db = await getLanceDb();
  const tableNames = await db.tableNames();
  if (!tableNames.includes(LANCEDB_ENTITY_MENTIONS_TABLE)) {
    return [];
  }
  const table = await db.openTable(LANCEDB_ENTITY_MENTIONS_TABLE);
  const escapedType = entityType.replace(/'/g, "''");
  return table
    .search(vector)
    .distanceType("cosine")
    .where(`entity_type = '${escapedType}'`)
    .limit(limit)
    .toArray();
}
