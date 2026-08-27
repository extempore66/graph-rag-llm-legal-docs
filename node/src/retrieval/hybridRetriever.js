// Multi-channel retrieval. Four independent channels each search the WHOLE
// corpus, and their ranked lists are fused. Deliberately not retrieve-then-
// rerank: a reranker can only reorder what stage one already returned, so
// anything the first stage ranks badly is unrecoverable. Every channel here
// gets to nominate from all 3,338 chunks.
//
// Each channel exists because a measured question defeated the others:
//
//   vector    "Who is Alfredo Rodriguez?"      -- one passage names him; that
//             chunk is #1 by cosine and nothing else finds it as cleanly.
//
//   density   "What is the obiter dicta?"      -- answered by a whole oral-
//             argument transcript whose 102 chunks are all moderately relevant
//             and none outstanding. Best-chunk ranks it #14; counting how many
//             of its chunks reach the top pool ranks it #2.
//
//   lexical   "What is the obiter dicta?"      -- the corpus's quoted judicial
//             dicta ("the Court notes that...") sit at #329-#2970 by cosine but
//             are #1-#4 of only 6 matches once the query's jargon is expanded
//             into the literal phrasing a filing uses.
//
//   graph     "filings mentioning both Maxwell -- a conjunction no single query vector can
//             and Epstein"                        express, since embedding the phrase yields
//             one point resembling a blend of the two rather than the set containing both.
//             Also reaches chunks that use a surface form the question did not:
//             coreference expansion turns a hit on "Ms. Giuffre" into the whole
//             876-chunk family. Added last, after being measured standalone.
//
// The three are not merely complementary, they are inversely correlated:
// density ranked the obiter document #2 and the Rodriguez deposition #12, while
// best-chunk did the exact reverse. That is why this is a union and not a
// cleverer single scorer -- there isn't one.
//
// Same architecture Step 4 arrived at independently (dedupCandidates.js unions
// a Jaro-Winkler channel with an embedding channel), reached here from the
// opposite end of the pipeline.

import * as lancedb from "@lancedb/lancedb";
import {
  LANCEDB_DIR,
  LANCEDB_CHUNKS_TABLE,
  RETRIEVAL_TOP_K,
  CHANNEL_POOL,
  DENSITY_POOL,
  RRF_K,
  USE_QUERY_EXPANSION,
} from "../config.js";
import { embedQuery } from "./naiveRetriever.js";
import { expandQuery } from "./queryExpansion.js";
import { graphCandidates } from "./graphRetriever.js";

let lanceDbConnection = null;
async function getTable() {
  if (!lanceDbConnection) lanceDbConnection = await lancedb.connect(LANCEDB_DIR);
  return lanceDbConnection.openTable(LANCEDB_CHUNKS_TABLE);
}

// The whole corpus, loaded once per process and kept. 3,338 chunks of text is a
// few tens of MB and the lexical channel needs all of it in memory anyway; a
// per-query reload would dominate the cost of everything else here.
let corpusCache = null;
async function getCorpus() {
  if (corpusCache) return corpusCache;
  const table = await getTable();
  const rows = await table
    .query()
    .select(["chunk_id", "source_file", "page_start", "page_end", "text"])
    .toArray();
  corpusCache = rows.map((r) => ({
    chunk_id: r.chunk_id,
    source_file: r.source_file,
    page_start: r.page_start,
    page_end: r.page_end,
    text: r.text,
  }));
  return corpusCache;
}

// ---------------------------------------------------------------------------
// Lexical channel: BM25, computed in-process.
//
// Deliberately NOT a LanceDB FTS index. Building one writes to je_chunks, and
// that table is being read by a live multi-hour extraction run -- an index
// build is not worth risking a 16-hour job over. At 3,338 documents an
// in-memory BM25 is milliseconds, and the index rebuilds in well under a second
// on first use. A real FTS index is the right production answer once nothing
// else is touching the table.
// ---------------------------------------------------------------------------
let bm25 = null;

function tokenize(text) {
  return text.toLowerCase().match(/[a-z][a-z'-]{1,}/g) ?? [];
}

function buildBm25(corpus) {
  const df = new Map(); // token -> how many chunks contain it
  const docs = corpus.map((c) => {
    const tokens = tokenize(c.text);
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    return { tf, len: tokens.length };
  });
  const avgLen = docs.reduce((a, d) => a + d.len, 0) / (docs.length || 1);
  return { df, docs, avgLen, N: docs.length };
}

// Standard BM25 with the usual k1/b. Rare terms dominate, which is exactly the
// behaviour wanted here: an expanded query contributes phrases like "obiter"
// and "dictum" that appear in almost no chunk, and those are the discriminating
// signal -- while "the" and "court", which appear everywhere, contribute
// almost nothing through the IDF term.
function bm25Search(query, limit, k1 = 1.5, b = 0.75) {
  const terms = tokenize(query);
  const scores = new Float64Array(bm25.N);
  for (const term of terms) {
    const n = bm25.df.get(term);
    if (!n) continue;
    const idf = Math.log(1 + (bm25.N - n + 0.5) / (n + 0.5));
    for (let i = 0; i < bm25.N; i++) {
      const f = bm25.docs[i].tf.get(term);
      if (!f) continue;
      const norm = f * (k1 + 1) / (f + k1 * (1 - b + b * (bm25.docs[i].len / bm25.avgLen)));
      scores[i] += idf * norm;
    }
  }
  return Array.from(scores)
    .map((s, i) => ({ i, s }))
    .filter((x) => x.s > 0)
    .sort((a, b2) => b2.s - a.s)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Fusion: Reciprocal Rank Fusion.
//
// Chosen over score-blending because the three channels produce incomparable
// numbers -- cosine distance (lower is better, ~0.3-0.5 here), a chunk count
// (small integers), and an unbounded BM25 score. Normalising those onto a
// common scale means inventing weights, which is exactly the arbitrary tuning
// this project has avoided elsewhere. RRF only reads each channel's ORDER, so
// no scale reconciliation is needed and no channel can dominate by having
// numerically larger scores.
// ---------------------------------------------------------------------------
function rankFuse(channelLists) {
  const fused = new Map();
  for (const [channel, ids] of Object.entries(channelLists)) {
    ids.forEach((chunkId, rank) => {
      const entry = fused.get(chunkId) || { chunk_id: chunkId, score: 0, channels: [] };
      entry.score += 1 / (RRF_K + rank + 1);
      entry.channels.push(`${channel}#${rank + 1}`);
      fused.set(chunkId, entry);
    });
  }
  return [...fused.values()].sort((a, b) => b.score - a.score);
}

/**
 * Retrieve top-k chunks using all three channels.
 *
 * Returns the same shape as retrieveNaive so answerGenerator.js consumes either
 * without knowing which produced it -- that interchangeability is what keeps the
 * naive-vs-hybrid-vs-graph comparison honest.
 *
 * Each returned chunk carries `channels`, naming which channel(s) nominated it
 * and at what rank. That is the diagnostic the eval needs: a channel that never
 * contributes a chunk that survives fusion is a channel that has not earned its
 * place, and should be removed rather than kept for symmetry.
 */
export async function retrieveHybrid(question, k = RETRIEVAL_TOP_K) {
  const [corpus, table] = await Promise.all([getCorpus(), getTable()]);
  if (!bm25) bm25 = buildBm25(corpus);
  const byId = new Map(corpus.map((c) => [c.chunk_id, c]));

  // Graph runs concurrently with query expansion: both are independent of the
  // embedding below and of each other, and graph traversal measured 30-91 ms,
  // so serialising them would add latency for no reason.
  //
  // A traversal failure must not take the whole retrieval down. The other three
  // channels are fully functional without it, so a thrown error degrades this
  // to the previously-measured three-channel behaviour and records why, rather
  // than failing a query that four-fifths of the machinery could still answer.
  const [expansion, graph] = await Promise.all([
    // A failed expansion is survivable -- the lexical channel falls back to the
    // raw question below -- but it was previously invisible, and silence is how
    // the num_ctx clip went unnoticed for a whole eval run.
    //
    // It fails more than one might assume. Measured 2026-08-27 across eight
    // demo questions, four came back unparseable: the model loops generating
    // synonyms, runs to num_predict, and the JSON ends mid-string. All four are
    // ENUMERATIVE questions ("who were the defense attorneys", "which courts
    // appear", "what did the FBI do") -- the prompt asks for related phrasings
    // and such a question gives it no natural place to stop. Deterministic at
    // temperature 0, so those questions fail every time, and raising the cap to
    // 900 did not help.
    USE_QUERY_EXPANSION
      ? expandQuery(question).catch((err) => {
          console.warn(`[hybrid] query expansion failed, lexical falls back to the raw question: ${err.message}`);
          return null;
        })
      : Promise.resolve(null),
    graphCandidates(question, CHANNEL_POOL).catch((err) => ({
      chunk_ids: [],
      paths: new Map(),
      graph_path: { fallback: true, reason: `graph channel failed: ${err.message}`, link_mode: "none", categories: [], linked_entities: [] },
    })),
  ]);

  // One embedding, reused by both vector-based channels.
  const vector = await embedQuery(question);
  const ranked = await table
    .search(vector)
    .distanceType("cosine")
    .select(["chunk_id", "source_file", "_distance"])
    .limit(Math.max(DENSITY_POOL, CHANNEL_POOL))
    .toArray();

  // Channel 1 -- best chunks by cosine.
  const vectorIds = ranked.slice(0, CHANNEL_POOL).map((r) => r.chunk_id);

  // Channel 2 -- documents with the most chunks in the pool, represented by
  // their own best chunks. Note it nominates CHUNKS, not documents: fusion
  // works on one unit, and the answer generator needs passages regardless.
  const docCounts = new Map();
  for (const r of ranked.slice(0, DENSITY_POOL)) {
    const d = docCounts.get(r.source_file) || { n: 0, chunks: [] };
    d.n++;
    d.chunks.push(r.chunk_id);
    docCounts.set(r.source_file, d);
  }
  const densityIds = [...docCounts.entries()]
    .sort((a, b) => b[1].n - a[1].n)
    .slice(0, Math.ceil(k / 2))
    .flatMap(([, d]) => d.chunks.slice(0, 3));

  // Channel 3 -- BM25 over the expanded query. Falls back to the raw question
  // when expansion is off or failed, which is weak but never wrong.
  const lexicalQuery = expansion
    ? `${question} ${expansion.expanded_query} ${expansion.hypothetical_passage}`
    : question;
  const lexicalIds = bm25Search(lexicalQuery, CHANNEL_POOL).map((x) => corpus[x.i].chunk_id);

  // Channel 4 -- entity traversal. Filtered against the LanceDB corpus because
  // the two stores are not perfectly in lockstep: a handful of chunks exist as
  // graph anchors in Arango without a corresponding LanceDB row, and every
  // other channel draws its ids FROM LanceDB so cannot produce one. Unfiltered,
  // such an id would survive fusion and hydrate to undefined -- a row with no
  // text, silently handed to the answer generator.
  const graphIds = graph.chunk_ids.filter((id) => byId.has(id));

  const distanceById = new Map(ranked.map((r) => [r.chunk_id, r._distance]));

  // Reserved slots for the vector channel, and the reason is a measured
  // regression rather than caution. The first version fused all three channels
  // with equal weight, which fixed "what is the obiter dicta" (the oral-argument
  // transcript finally reached slot 7) and simultaneously BROKE "who is Alfredo
  // Rodriguez" -- the deposition that answers it, ranked #3 by plain cosine,
  // fell out of the top 8 entirely because density ranks that same document #12
  // and outvoted the channel that was right.
  //
  // Equal-weight fusion is only sound when channels are independent. These are
  // inversely correlated by construction, so half the slots are reserved for
  // the plain cosine ranking. That makes hybrid a strict improvement on naive:
  // it can ADD what the other channels find, never subtract what vector search
  // already had. The remaining slots are fused as before.
  //
  // A principled version would weight channels per question rather than fixing
  // the split -- vector spread is a usable signal for that (0.0804 on the
  // Rodriguez question vs 0.0206 on the obiter one, a 4x separation between
  // "found something specific" and "returned k rows because k were asked for").
  // Not built yet: it needs the eval's question set to tune against, and
  // guessing at it now would be exactly the arbitrary threshold this project
  // keeps refusing to invent.
  const reserved = Math.floor(k / 2);
  const guaranteed = vectorIds.slice(0, reserved);
  const guaranteedSet = new Set(guaranteed);

  const fusedRest = rankFuse({ vector: vectorIds, density: densityIds, lexical: lexicalIds, graph: graphIds })
    .filter((f) => !guaranteedSet.has(f.chunk_id));

  const results = [
    ...guaranteed.map((id, i) => ({ chunk_id: id, score: null, channels: [`vector#${i + 1}`, "reserved"] })),
    ...fusedRest,
  ]
    .slice(0, k)
    .map((f) => ({
      ...byId.get(f.chunk_id),
      distance: distanceById.get(f.chunk_id) ?? null,
      fusion_score: f.score,
      channels: f.channels,
      // Provenance from the graph channel, where it has any. Undefined for a
      // chunk the traversal never reached -- which is most of them, and is
      // itself informative: a row with channel tags but no path was found by
      // similarity or keywords alone.
      //
      // Note this is attached AFTER fusion, so it appears on a chunk the graph
      // nominated even when another channel outranked it. That is correct: the
      // question the panel answers is "how was this passage reached", and
      // "the graph reached it too" is part of the answer.
      path: graph.paths?.get(f.chunk_id) ?? null,
    }));

  // Carried out so the eval and the query page can tell WHY graph contributed
  // nothing to a given answer -- an unanchored question is a different fact
  // from a traversal that ran and lost the fusion, and only this distinguishes
  // them. `nominated` is what the channel actually put to the vote after the
  // LanceDB filter above.
  results.graph_path = { ...graph.graph_path, nominated: graphIds.length };
  return results;
}
