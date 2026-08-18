// N.2 -- prove chunks can be written into LanceDB and read back correctly,
// for one hardcoded file, before wiring in Express/concurrency/ArangoDB.
//
// Verification strategy: after inserting a file's chunks, run a vector
// search using one chunk's OWN vector as the query. Its nearest neighbor
// should be itself (near-zero distance) -- a simple, convincing check that
// the vectors actually round-tripped through LanceDB correctly, not just
// that the insert call didn't throw.

import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { PROJECT_ROOT, LANCEDB_DIR, LANCEDB_CHUNKS_TABLE } from "./config.js";
import { runExtractAndChunk } from "./pythonExtractor.js";
import { buildChunkId } from "./chunkId.js";

const SAMPLE_PDF = path.join(
  PROJECT_ROOT,
  "shabosan_epstein_files",
  "gov.uscourts.nysd.447706.1321.0.pdf"
);
const TABLE_NAME = LANCEDB_CHUNKS_TABLE;

// 1. Run the already-proven Python pipeline for one file.
const result = await runExtractAndChunk(SAMPLE_PDF);
console.log(`Extracted ${result.chunk_count} chunks from ${result.source_file}`);

// 2. Shape each chunk into the row LanceDB will store. chunk_id is built
// here via the one shared function -- this is the same ID that will later
// get written into ArangoDB's `chunks` collection as its _key, which is
// the entire point of the chunk<->graph linking design.
const rows = result.chunks.map((chunk) => ({
  chunk_id: buildChunkId(result.source_file, chunk.chunk_index),
  vector: chunk.vector,
  text: chunk.text,
  source_file: result.source_file,
  page_start: chunk.page_start,
  page_end: chunk.page_end,
  chunk_index: chunk.chunk_index,
  word_count: chunk.word_count,
}));

// 3. Connect to a local on-disk LanceDB (just a directory -- no server to
// run, matching why we picked LanceDB over Chroma for this single-user,
// single-machine setup).
const db = await lancedb.connect(LANCEDB_DIR);

// Start fresh each run so this test script is repeatable -- drop the table
// if a previous run already created it, ignore the error if it doesn't
// exist yet.
try {
  await db.dropTable(TABLE_NAME);
} catch {
  // table didn't exist yet -- nothing to drop, that's fine
}

const table = await db.createTable(TABLE_NAME, rows);
console.log(`Wrote ${rows.length} rows into LanceDB table "${TABLE_NAME}"`);

// 4. Verify: search using the first chunk's own vector. It should come
// back as its own nearest neighbor.
const queryVector = rows[0].vector;
const searchResults = await table.vectorSearch(queryVector).limit(3).toArray();

console.log("\nVector search using chunk 0's own vector as the query:");
for (const row of searchResults) {
  console.log(
    `  chunk_id=${row.chunk_id}  distance=${row._distance.toFixed(6)}  text preview="${row.text.slice(0, 60)}..."`
  );
}

const topMatch = searchResults[0];
const selfMatchOk = topMatch.chunk_id === rows[0].chunk_id && topMatch._distance < 1e-4;
console.log(`\nSelf-match check (top result is chunk 0, near-zero distance): ${selfMatchOk ? "PASS" : "FAIL"}`);
