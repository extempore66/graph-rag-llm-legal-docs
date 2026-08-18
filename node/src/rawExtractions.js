// Persistence layer for je_raw_extractions -- Step 3's raw, per-chunk
// output. Kept as its own thin module, mirroring processFile.js's
// separation of "what gets written" from "how it gets computed"
// (entityExtraction.js does the actual extraction work).

import { Database, aql } from "arangojs";
import {
  ARANGO_URL,
  ARANGO_DB,
  ARANGO_USER,
  ARANGO_PASSWORD,
  ARANGO_RAW_EXTRACTIONS_COLLECTION,
  EXTRACTION_MODEL,
} from "./config.js";

const db = new Database({
  url: ARANGO_URL,
  databaseName: ARANGO_DB,
  auth: { username: ARANGO_USER, password: ARANGO_PASSWORD },
});
const collection = db.collection(ARANGO_RAW_EXTRACTIONS_COLLECTION);
let collectionReady = false;

export async function ensureRawExtractionsCollection() {
  if (collectionReady) return;
  if (!(await collection.exists())) {
    await collection.create();
  }
  collectionReady = true;
}

// Used by the batch runner to skip chunks that already have a result --
// what makes the runner resumable rather than needing a clean restart
// after any interruption.
export async function hasRawExtraction(chunkId) {
  return collection.documentExists(chunkId);
}

// Used by Step 5 (dedupJudgment.js) to pull a candidate's chunk-level facts
// (docket_numbers, dates) for the *specific* chunk a matched mention came
// from -- not the candidate entity's whole history, just this one mention's
// context, alongside the role looked up via getMentionedInEdge.
export async function getRawExtraction(chunkId) {
  try {
    return await collection.document(chunkId);
  } catch (err) {
    if (err.isArangoError && err.errorNum === 1202) return null; // document not found
    throw err;
  }
}

// Steps 4-6's outer loop: every chunk not yet run through dedup, in one
// pull -- same "resumable by skipping what's already done" shape as
// hasRawExtraction, just chunk-level instead of a single boolean check
// since the dedup batch runner needs the whole document (entities array,
// docket_numbers/dates) to work with, not just a yes/no.
export async function getUnprocessedForDedup() {
  const cursor = await db.query(aql`
    FOR d IN ${collection}
      FILTER d.dedup_processed != true
      RETURN d
  `);
  return cursor.all();
}

// Marks a chunk done for dedup once every entity in it has been through
// Steps 4-6. Partial update (not overwriteMode: "replace") so this never
// touches the entities/docket_numbers/dates/etc. already on the document --
// only adds this one flag.
export async function markDedupProcessed(chunkId) {
  await collection.update(chunkId, { dedup_processed: true });
}

// needs_review is computed once, here, at write time -- true if ANY
// entity in the chunk came back "resolved_from_context" rather than
// "explicit". Precomputing this as a flat boolean means Steps 4-6 (or a
// future review UI) can cheaply query "show me everything uncertain"
// without scanning into the nested entities array every time.
export async function writeRawExtraction(chunkId, meta, extraction) {
  const needsReview = extraction.entities.some((e) => e.confidence === "resolved_from_context");
  await collection.save(
    {
      _key: chunkId,
      source_file: meta.source_file,
      chunk_index: meta.chunk_index,
      docket_numbers: extraction.docket_numbers,
      dates: extraction.dates,
      entities: extraction.entities,
      needs_review: needsReview,
      extracted_at: new Date().toISOString(),
      model: EXTRACTION_MODEL,
    },
    { overwriteMode: "replace" }
  );
}
