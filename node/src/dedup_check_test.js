// Verification script for the delete-then-add hardening in processFile.js
// (added 2026-08-17, after N.7): confirms re-uploading the same file
// replaces its LanceDB rows instead of duplicating them. Not part of the
// N.1-N.8 build sequence itself and disposable at any time -- kept
// deliberately, though, as a record that this specific behavior was
// actually verified against a real running server rather than just
// reasoned about, the same standard applied to every other build step in
// this project. Usage: run the server, upload a file once or twice, then
// `node --env-file=.env src/dedup_check_test.js <source_file>` to see its
// current LanceDB row count.

import * as lancedb from "@lancedb/lancedb";
import { LANCEDB_DIR, LANCEDB_CHUNKS_TABLE } from "./config.js";

const sourceFile = process.argv[2];
if (!sourceFile) {
  console.error("usage: node dedup_check_test.js <source_file>");
  process.exit(1);
}

const db = await lancedb.connect(LANCEDB_DIR);
const table = await db.openTable(LANCEDB_CHUNKS_TABLE);
const rows = await table.query().where(`source_file = '${sourceFile}'`).toArray();
console.log(`${sourceFile}: ${rows.length} row(s) in LanceDB`);
