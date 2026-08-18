// N.3 -- prove the chunk_id linking pattern actually works across both
// databases, not just in theory. Writes the thin `je_chunks` records into
// ArangoDB, then cross-checks that the exact same chunk_ids already sitting
// in LanceDB (written by N.2, for this same sample file) line up exactly.
//
// Run with: node --env-file=.env src/arango_test.js
// (Node's built-in --env-file flag, no dotenv package needed.)

import path from "node:path";
import { Database } from "arangojs";
import * as lancedb from "@lancedb/lancedb";
import {
  PROJECT_ROOT,
  LANCEDB_DIR,
  LANCEDB_CHUNKS_TABLE,
  ARANGO_CHUNKS_COLLECTION,
  ARANGO_URL,
  ARANGO_DB,
  ARANGO_USER,
  ARANGO_PASSWORD,
} from "./config.js";
import { runExtractAndChunk } from "./pythonExtractor.js";
import { buildChunkId } from "./chunkId.js";

const SAMPLE_PDF = path.join(
  PROJECT_ROOT,
  "shabosan_epstein_files",
  "gov.uscourts.nysd.447706.1321.0.pdf"
);
const CHUNKS_COLLECTION = ARANGO_CHUNKS_COLLECTION;

// 1. Connect to the already-existing ArangoDB database (we don't create the
// database itself -- that's already set up -- just the collection).
const db = new Database({
  url: ARANGO_URL,
  databaseName: ARANGO_DB,
  auth: {
    username: ARANGO_USER,
    password: ARANGO_PASSWORD,
  },
});

// 2. Make sure je_chunks exists. Safe to run repeatedly -- only creates it
// the first time.
const collection = db.collection(CHUNKS_COLLECTION);
if (!(await collection.exists())) {
  await collection.create();
  console.log(`Created collection "${CHUNKS_COLLECTION}"`);
} else {
  console.log(`Collection "${CHUNKS_COLLECTION}" already exists`);
}

// 3. Run the same proven Python pipeline for the same sample file N.2 used,
// so the chunk_ids we write here should exactly match what's already in
// LanceDB.
const result = await runExtractAndChunk(SAMPLE_PDF);

// 4. Build the thin ArangoDB records -- deliberately no text/vector here,
// this collection's only job is being the cross-reference anchor (see
// _project_step_by_step_plan.md, "chunk<->graph linking pattern").
const arangoRecords = result.chunks.map((chunk) => ({
  _key: buildChunkId(result.source_file, chunk.chunk_index),
  source_file: result.source_file,
  page_start: chunk.page_start,
  page_end: chunk.page_end,
  chunk_index: chunk.chunk_index,
  word_count: chunk.word_count,
}));

// overwriteMode: "replace" makes this idempotent -- rerunning the script
// updates existing records instead of erroring on duplicate _key.
await collection.saveAll(arangoRecords, { overwriteMode: "replace" });
console.log(`Wrote ${arangoRecords.length} records into "${CHUNKS_COLLECTION}"`);

const arangoChunkIds = new Set(arangoRecords.map((r) => r._key));

// 5. Cross-check against LanceDB: open the table N.2 already populated for
// this same file, pull back every chunk_id it has, and compare sets.
const lanceDb = await lancedb.connect(LANCEDB_DIR);
const lanceTable = await lanceDb.openTable(LANCEDB_CHUNKS_TABLE);
const lanceRows = await lanceTable.query().toArray();
const lanceChunkIds = new Set(
  lanceRows
    .filter((row) => row.source_file === result.source_file)
    .map((row) => row.chunk_id)
);

console.log("\nchunk_ids in ArangoDB:", [...arangoChunkIds].sort());
console.log("chunk_ids in LanceDB:  ", [...lanceChunkIds].sort());

const setsMatch =
  arangoChunkIds.size === lanceChunkIds.size &&
  [...arangoChunkIds].every((id) => lanceChunkIds.has(id));

console.log(`\nCross-database chunk_id match check: ${setsMatch ? "PASS" : "FAIL"}`);
