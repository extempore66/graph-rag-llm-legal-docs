// E.2 verification -- pulls real chunks straight out of LanceDB (the actual
// ingested corpus, not a hand-picked scratch sample) and runs them through
// the real entityExtraction.js module, confirming the permanent Node
// implementation reproduces what E.1's scratch testing proved out.

import * as lancedb from "@lancedb/lancedb";
import { LANCEDB_DIR, LANCEDB_CHUNKS_TABLE } from "./config.js";
import { extractChunkEntities } from "./entityExtraction.js";

const db = await lancedb.connect(LANCEDB_DIR);
const table = await db.openTable(LANCEDB_CHUNKS_TABLE);
const rows = await table.query().limit(2000).toArray();

// Same entity-dense selection heuristic used during E.1's scratch testing,
// so results are directly comparable -- plus one chunk chosen at random to
// sanity-check the common case (few or no entities), not just the dense one.
const dense = rows.filter((r) => /defendant|plaintiff|counsel/i.test(r.text) && r.text.length > 800);
const picks = [dense[5], dense[12], rows[Math.floor(Math.random() * rows.length)]];

for (const [i, chunk] of picks.entries()) {
  console.log(`\n=== chunk ${i} (${chunk.source_file} #${chunk.chunk_index}) ===`);
  const start = Date.now();
  const result = await extractChunkEntities(chunk.text);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`elapsed: ${elapsed}s`);
  console.log("docket_numbers:", result.docket_numbers);
  console.log("dates:", result.dates);
  console.log(`entities (${result.entities.length}):`);
  console.log(JSON.stringify(result.entities, null, 2));
}
