// Shared "process one file" pipeline: extract+chunk+embed (Python
// subprocess) -> write chunks+vectors to LanceDB -> write thin
// cross-reference records to ArangoDB. This is Step 1's complete Node-side
// logic, factored into one function so both the single-file upload
// endpoint (N.4) and the later worker pool (N.5) call the exact same
// proven code, instead of two copies of the same pipeline.

import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Database } from "arangojs";
import {
  LANCEDB_DIR,
  LANCEDB_CHUNKS_TABLE,
  ARANGO_CHUNKS_COLLECTION,
  ARANGO_URL,
  ARANGO_DB,
  ARANGO_USER,
  ARANGO_PASSWORD,
  OLLAMA_URL,
  EMBEDDING_MODEL,
} from "./config.js";
import { runExtractAndChunk } from "./pythonExtractor.js";
import { buildChunkId } from "./chunkId.js";

// Embeds every chunk of one file in a single Ollama call rather than one
// call per chunk -- /api/embed accepts a batch `input` array and returns
// `embeddings` in the same order, so one round trip per file is enough
// regardless of chunk count. This is a deterministic vector-encoding
// operation, not a judgment call (unlike Step 3's extraction), so it has no
// prompt/schema of its own -- just text in, vectors out.
// Exported so dedupCandidates.js (Step 4) can reuse the exact same
// embedding call for context snippets -- same model, same endpoint, same
// batching shape, just called with different text.
export async function embedChunks(chunkTexts) {
  const response = await fetch(`${OLLAMA_URL}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBEDDING_MODEL, input: chunkTexts }),
  });

  if (!response.ok) {
    throw new Error(`Ollama /api/embed returned HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  return body.embeddings;
}

// One shared ArangoDB connection, reused across every call rather than
// reconnecting per file.
const arangoDb = new Database({
  url: ARANGO_URL,
  databaseName: ARANGO_DB,
  auth: { username: ARANGO_USER, password: ARANGO_PASSWORD },
});
const arangoCollection = arangoDb.collection(ARANGO_CHUNKS_COLLECTION);
let arangoCollectionReady = false;

async function ensureArangoCollection() {
  if (arangoCollectionReady) return;
  if (!(await arangoCollection.exists())) {
    await arangoCollection.create();
  }
  arangoCollectionReady = true;
}

// One shared LanceDB connection too.
let lanceDbConnection = null;
async function getLanceDb() {
  if (!lanceDbConnection) {
    lanceDbConnection = await lancedb.connect(LANCEDB_DIR);
  }
  return lanceDbConnection;
}

async function writeLanceRows(sourceFileName, rows) {
  const db = await getLanceDb();
  const tableNames = await db.tableNames();
  if (tableNames.includes(LANCEDB_CHUNKS_TABLE)) {
    const table = await db.openTable(LANCEDB_CHUNKS_TABLE);
    // Delete-then-add per source file, not a plain append. LanceDB has no
    // primary key / upsert, so re-processing the same file (a retried
    // upload, or accidentally running the same folder twice) would
    // otherwise leave old duplicate rows behind forever instead of being
    // replaced. This makes LanceDB's behavior match ArangoDB's
    // saveAll(..., {overwriteMode: "replace"}) below -- re-running a file
    // is always safe here, never additive.
    // The quote-escaping is defensive: source_file is normally a plain
    // court-filing filename, but it's still a string being built into a
    // SQL-like filter rather than passed as a parameter.
    const escapedSourceFile = sourceFileName.replace(/'/g, "''");
    await table.delete(`source_file = '${escapedSourceFile}'`);
    await table.add(rows);
  } else {
    // LanceDB infers the table's schema from the first batch of rows, so
    // creation and insertion are the same call when the table doesn't
    // exist yet -- nothing to delete on a brand-new table.
    await db.createTable(LANCEDB_CHUNKS_TABLE, rows);
  }
}

// Run one PDF through the full Step 1 pipeline and return a small summary
// (not the full chunk data -- callers that need that read it back from
// storage instead).
//
// filePath is wherever the file actually sits on disk right now (which,
// under concurrent uploads, is a collision-safe temp name multer generated
// -- never the original filename, to avoid two simultaneous uploads
// colliding on disk). displayName is the human-meaningful original
// filename, used for chunk_id/source_file instead -- passing it separately
// like this means the physical file never needs renaming at all, which is
// what actually makes this safe under concurrency.
export async function processFile(filePath, displayName = null) {
  const result = await runExtractAndChunk(filePath);

  // Store just the filename, never a full path, in either database. Paths
  // are transient/environment-specific -- a temp upload directory that
  // gets deleted right after processing, or a local backlog folder that
  // only exists on this one machine -- while the filename itself is the
  // stable, meaningful piece of provenance (and matches what chunk_id is
  // already built from).
  const sourceFileName = displayName || path.basename(result.source_file);

  const vectors = await embedChunks(result.chunks.map((chunk) => chunk.text));

  const lanceRows = result.chunks.map((chunk, i) => ({
    chunk_id: buildChunkId(sourceFileName, chunk.chunk_index),
    vector: vectors[i],
    text: chunk.text,
    source_file: sourceFileName,
    page_start: chunk.page_start,
    page_end: chunk.page_end,
    chunk_index: chunk.chunk_index,
    word_count: chunk.word_count,
  }));

  const arangoRecords = result.chunks.map((chunk) => ({
    _key: buildChunkId(sourceFileName, chunk.chunk_index),
    source_file: sourceFileName,
    page_start: chunk.page_start,
    page_end: chunk.page_end,
    chunk_index: chunk.chunk_index,
    word_count: chunk.word_count,
  }));

  await ensureArangoCollection();

  // Write LanceDB first, ArangoDB second. If this process dies between the
  // two writes, the failure mode is always "chunk exists in the vector
  // store, graph reference not written yet" (safe, re-processable), never
  // the reverse -- see _project_step_by_step_plan.md, chunk<->graph
  // linking pattern, for why that ordering matters.
  await writeLanceRows(sourceFileName, lanceRows);
  await arangoCollection.saveAll(arangoRecords, { overwriteMode: "replace" });

  return {
    source_file: sourceFileName,
    total_words: result.total_words,
    chunk_count: result.chunk_count,
  };
}
