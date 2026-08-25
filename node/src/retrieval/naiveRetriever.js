// The naive RAG baseline: embed the question, take the top-k nearest chunks by
// cosine distance, hand them to the shared answer generator. No graph, no
// entity resolution, no traversal -- this is the "just do vector search"
// system that Graph RAG has to beat in order to have justified its cost.
//
// Deliberately unoptimized, and that is the whole point. It would be easy to
// add a reranker, deduplicate the 50-word chunk overlaps, expand the query, or
// filter by source document -- and every one of those would make the baseline
// stronger and the comparison less honest, because none of them are what
// "naive RAG" means. A baseline that has been quietly tuned is not a baseline.
// Improvements belong in a third, named strategy, not smuggled in here.
//
// Nothing in this file depends on the graph, so it runs against je_chunks
// alone -- which has been complete and populated since ingestion, long before
// entity extraction finished.

import * as lancedb from "@lancedb/lancedb";
import { LANCEDB_DIR, LANCEDB_CHUNKS_TABLE, RETRIEVAL_TOP_K, BGE_QUERY_PREFIX } from "../config.js";
import { embedChunks } from "../processFile.js";

let lanceDbConnection = null;
async function getLanceDb() {
  if (!lanceDbConnection) {
    lanceDbConnection = await lancedb.connect(LANCEDB_DIR);
  }
  return lanceDbConnection;
}

// Query embedding, shared with the graph retriever so both strategies embed
// questions identically -- if they differed, the "same embedding model" premise
// of the comparison would be false in the one place it matters most.
//
// The BGE instruction prefix that used to be hardcoded here now lives in
// config.js as BGE_QUERY_PREFIX and defaults to OFF. It was added on BAAI's
// documentation and measured harmful on this corpus: it drove the document
// that answers "what is the obiter dicta in this case?" from rank #22 to #80
// of 3,338. See the config comment for the full numbers.
export async function embedQuery(question) {
  const [vector] = await embedChunks([BGE_QUERY_PREFIX + question]);
  return vector;
}

/**
 * Top-k chunks for one question, nearest-first by cosine distance.
 *
 * No vector index is built on je_chunks: at 3,338 rows a brute-force scan is
 * milliseconds, and an ANN index would introduce approximation error into the
 * one part of this comparison that should be exact.
 *
 * @param {string} question
 * @param {number} [k=RETRIEVAL_TOP_K]
 * @returns {Promise<Array<{chunk_id, source_file, page_start, page_end, text, distance}>>}
 */
export async function retrieveNaive(question, k = RETRIEVAL_TOP_K) {
  const db = await getLanceDb();
  const table = await db.openTable(LANCEDB_CHUNKS_TABLE);

  const vector = await embedQuery(question);

  // select() omits the 1024-dim vector column -- there is no use for it
  // downstream and pulling k of them back per question is pure overhead.
  // _distance is listed explicitly rather than relied on: LanceDB currently
  // auto-appends it to a projected search and warns that it will stop doing so.
  const rows = await table
    .search(vector)
    .distanceType("cosine")
    .select(["chunk_id", "source_file", "page_start", "page_end", "text", "_distance"])
    .limit(k)
    .toArray();

  return rows.map((r) => ({
    chunk_id: r.chunk_id,
    source_file: r.source_file,
    page_start: r.page_start,
    page_end: r.page_end,
    text: r.text,
    // Kept for the eval report rather than for the answer: cosine distance is
    // how you tell "retrieved the right passage confidently" apart from
    // "returned k rows because k rows were asked for", which is what vector
    // search always does no matter how irrelevant the corpus is to the query.
    distance: r._distance,
  }));
}
