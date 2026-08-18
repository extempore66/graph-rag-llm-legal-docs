// E.3 -- walks every chunk in je_chunks (LanceDB) and runs Step 3's
// extraction (entityExtraction.js) against each one, persisting raw
// results into je_raw_extractions. This is Step 3's *only* job -- Steps
// 4-6 (dedup, judgment, merge) are a separate, later pass that will read
// from je_raw_extractions instead of recomputing extraction.
//
// Runs strictly sequentially, on purpose -- Ollama is one local instance
// on one machine, and concurrent LLM calls against it serialize on the
// GPU/CPU regardless of how many "workers" issue them. A worker pool here
// would add complexity for zero real speedup, unlike Step 1's bounded
// concurrency, which genuinely parallelized process I/O across separate
// Python subprocesses.
//
// Resumable by design: skips any chunk that already has a
// je_raw_extractions record, so an interrupted run (this is a multi-hour
// job across 3,575 chunks) can just be restarted rather than losing
// completed -- and expensive, each LLM call takes real wall-clock time --
// work.

import fs from "node:fs";
import path from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { LANCEDB_DIR, LANCEDB_CHUNKS_TABLE, PROJECT_ROOT } from "./config.js";
import { extractChunkEntities } from "./entityExtraction.js";
import { ensureRawExtractionsCollection, hasRawExtraction, writeRawExtraction } from "./rawExtractions.js";

// Optional cap for testing against a small slice before committing to the
// full run -- e.g. `node src/extractionBatchRunner.js 5`. Omit for the
// real, full-corpus run.
const limit = process.argv[2] ? parseInt(process.argv[2], 10) : Infinity;

// Failure log: operational/debugging detail, not real project data, so a
// plain local file rather than a new ArangoDB collection -- writing
// failures into je_raw_extractions itself would break resumability, since
// a failed record would look "done" and never get retried on the next run.
// Truncated fresh at the start of every run (not appended across runs) --
// a chunk that failed last time but succeeded on this run's retry should
// not still show up as failed here, since that would be actively
// misleading. Written incrementally as failures happen, not batched at
// the end, so a killed/interrupted run still preserves whatever failed
// before the interruption.
const logsDir = path.join(PROJECT_ROOT, "node", "logs");
fs.mkdirSync(logsDir, { recursive: true });
const failuresLogPath = path.join(logsDir, "extraction_failures.jsonl");
fs.writeFileSync(failuresLogPath, "");

function logFailure(chunk, err) {
  const line = JSON.stringify({
    chunk_id: chunk.chunk_id,
    source_file: chunk.source_file,
    chunk_index: chunk.chunk_index,
    error: err.message,
    failed_at: new Date().toISOString(),
  });
  fs.appendFileSync(failuresLogPath, line + "\n");
}

await ensureRawExtractionsCollection();

const db = await lancedb.connect(LANCEDB_DIR);
const table = await db.openTable(LANCEDB_CHUNKS_TABLE);
const chunks = await table.query().toArray();

const totalToAttempt = Math.min(chunks.length, limit);
console.log(`Found ${chunks.length} chunks in ${LANCEDB_CHUNKS_TABLE}${limit < Infinity ? ` (processing first ${limit})` : ""}.`);

let processed = 0;
let skipped = 0;
let failed = 0;
const failedChunkIds = [];
const start = Date.now();

for (const chunk of chunks) {
  if (processed + skipped + failed >= limit) break;

  if (await hasRawExtraction(chunk.chunk_id)) {
    skipped++;
    continue;
  }

  try {
    const extraction = await extractChunkEntities(chunk.text);
    await writeRawExtraction(chunk.chunk_id, { source_file: chunk.source_file, chunk_index: chunk.chunk_index }, extraction);
    processed++;
    const needsReview = extraction.entities.some((e) => e.confidence === "resolved_from_context");
    console.log(
      `[${processed + skipped + failed}/${totalToAttempt}] ${chunk.chunk_id} -- ` +
        `${extraction.entities.length} entities, ${extraction.docket_numbers.length} docket#, ` +
        `${extraction.dates.length} dates${needsReview ? " [needs_review]" : ""}`
    );
  } catch (err) {
    failed++;
    failedChunkIds.push(chunk.chunk_id);
    logFailure(chunk, err);
    console.error(`[FAILED] ${chunk.chunk_id}: ${err.message}`);
  }
}

const elapsedMin = ((Date.now() - start) / 60000).toFixed(1);
console.log(`\nDone in ${elapsedMin} min. Processed: ${processed}, skipped (already done): ${skipped}, failed: ${failed}.`);
if (failedChunkIds.length > 0) {
  console.log(`Failed chunk_ids (safe to re-run this script -- these will be retried, completed ones skipped). Full detail in ${failuresLogPath}:`);
  console.log(failedChunkIds.join(", "));
}
