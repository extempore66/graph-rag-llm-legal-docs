// N.1 -- prove the Node <-> Python handoff works, in isolation, before
// anything else (Express, uploads, database writes) depends on it.
//
// Spawns extract_and_chunk.py as a subprocess for one hardcoded sample file
// (via the shared pythonExtractor module), reads back the JSON it prints to
// stdout, and logs a summary.

import path from "node:path";
import { PROJECT_ROOT } from "./config.js";
import { runExtractAndChunk } from "./pythonExtractor.js";

const SAMPLE_PDF = path.join(
  PROJECT_ROOT,
  "shabosan_epstein_files",
  "gov.uscourts.nysd.447706.1321.0.pdf"
);

const result = await runExtractAndChunk(SAMPLE_PDF);

console.log("Handoff succeeded.");
console.log("source_file:", result.source_file);
console.log("total_words:", result.total_words);
console.log("chunk_count:", result.chunk_count);
console.log("first chunk vector dims:", result.chunks[0].vector.length);
console.log("first chunk text preview:", result.chunks[0].text.slice(0, 120));
