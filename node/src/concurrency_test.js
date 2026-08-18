// N.5 -- fire ~10 uploads at the server nearly simultaneously and confirm
// results actually come back correctly under real concurrent load. The
// concurrency *bound itself* (never more than UPLOAD_CONCURRENCY in flight)
// is verified by watching the server's own "[pool] start/done" console
// output while this runs -- this script proves the requests all still
// succeed, not just that the server doesn't crash.
//
// Requires the server to already be running (`npm start`) in another
// process -- this script is just an HTTP client.

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

const SAMPLE_DIR = path.join(PROJECT_ROOT, "shabosan_epstein_files");
const SERVER_URL = "http://localhost:3000/upload";
const NUM_FILES = 10;

const sampleFiles = fs
  .readdirSync(SAMPLE_DIR)
  .filter((name) => name.endsWith(".pdf"))
  .slice(0, NUM_FILES)
  .map((name) => path.join(SAMPLE_DIR, name));

async function uploadFile(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append("file", new Blob([fileBuffer]), path.basename(filePath));

  const start = Date.now();
  const response = await fetch(SERVER_URL, { method: "POST", body: form });
  const elapsedSeconds = (Date.now() - start) / 1000;
  const body = await response.json();

  return { file: path.basename(filePath), status: response.status, elapsedSeconds, body };
}

console.log(`Firing ${sampleFiles.length} uploads at ${SERVER_URL} concurrently...\n`);
const overallStart = Date.now();

// Promise.all fires every request at essentially the same instant -- this
// is deliberately the "worst case" for the concurrency limiter, exactly
// what real users hitting the batch-upload UI at once would look like.
const results = await Promise.all(sampleFiles.map(uploadFile));

const overallElapsedSeconds = (Date.now() - overallStart) / 1000;

console.log(`\nAll ${results.length} requests completed in ${overallElapsedSeconds.toFixed(1)}s\n`);
for (const r of results) {
  const detail = r.status === 200 ? `chunks=${r.body.chunk_count}` : `error="${r.body.error?.slice(0, 80)}"`;
  console.log(`  ${r.file}: HTTP ${r.status}, ${r.elapsedSeconds.toFixed(1)}s, ${detail}`);
}

const failures = results.filter((r) => r.status !== 200);
console.log(`\nFailures: ${failures.length}/${results.length}`);
