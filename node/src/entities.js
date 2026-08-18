// Persistence layer for Steps 4-6's ArangoDB-side collections: je_entities
// (node), je_mentioned_in (edge, entity -> chunk), je_possible_duplicates
// (edge, entity -> entity, Step 5's "unsure" outcome). Mirrors
// rawExtractions.js's separation of "what gets written" from "how it gets
// computed" (dedupCandidates.js/dedupJudgment.js do the actual logic).

import { Database, aql } from "arangojs";
import {
  ARANGO_URL,
  ARANGO_DB,
  ARANGO_USER,
  ARANGO_PASSWORD,
  ARANGO_CHUNKS_COLLECTION,
  ARANGO_ENTITIES_COLLECTION,
  ARANGO_MENTIONED_IN_COLLECTION,
  ARANGO_POSSIBLE_DUPLICATES_COLLECTION,
} from "./config.js";

const db = new Database({
  url: ARANGO_URL,
  databaseName: ARANGO_DB,
  auth: { username: ARANGO_USER, password: ARANGO_PASSWORD },
});
const entitiesCollection = db.collection(ARANGO_ENTITIES_COLLECTION);
const mentionedInCollection = db.collection(ARANGO_MENTIONED_IN_COLLECTION);
const possibleDuplicatesCollection = db.collection(ARANGO_POSSIBLE_DUPLICATES_COLLECTION);
let collectionsReady = false;

// je_mentioned_in and je_possible_duplicates are true ArangoDB edge
// collections (createEdgeCollection, not create) -- that's what gives
// _from/_to their automatic index for free, and what makes traversal
// queries ("all mentions of entity X") fast without any manual indexing
// work. The persistent index on je_entities.type exists because Step 4's
// Jaro-Winkler channel has to pull every entity of a given type into memory
// to compare in JS (confirmed: ArangoDB 3.12 has no built-in
// JARO_WINKLER_SIMILARITY AQL function) -- scoping that pull by type keeps
// it from growing against the whole collection as more types accumulate.
export async function ensureEntitiesCollections() {
  if (collectionsReady) return;
  if (!(await entitiesCollection.exists())) {
    await entitiesCollection.create();
    await entitiesCollection.ensureIndex({ type: "persistent", fields: ["type"] });
  }
  if (!(await mentionedInCollection.exists())) {
    await db.createEdgeCollection(ARANGO_MENTIONED_IN_COLLECTION);
  }
  if (!(await possibleDuplicatesCollection.exists())) {
    await db.createEdgeCollection(ARANGO_POSSIBLE_DUPLICATES_COLLECTION);
  }
  collectionsReady = true;
}

// je_entities nodes stay deliberately thin -- name + type only. Role,
// textual evidence, and confidence are per-mention facts that live on the
// je_mentioned_in edge instead, so merging entities never blurs or
// overwrites the evidence trail (see _project_step_by_step_plan.md, Step
// 3-6 design session).
export async function createEntity({ name, type }) {
  const { _key } = await entitiesCollection.save({ name, type });
  return _key;
}

// Write order matters: the entity (new or existing) must already exist
// before this edge references its entity_id, so callers always create/
// resolve the entity first and only then call this -- never the reverse,
// which would risk an edge pointing at nothing.
export async function writeMentionedInEdge(entityId, chunkId, { role, textual_evidence, confidence }) {
  await mentionedInCollection.save({
    _from: `${ARANGO_ENTITIES_COLLECTION}/${entityId}`,
    _to: `${ARANGO_CHUNKS_COLLECTION}/${chunkId}`,
    role,
    textual_evidence,
    confidence,
  });
}

// Step 5's "unsure" outcome -- never auto-merged (a false merge is worse
// than a missed one for legal-accuracy reasons), written instead as a
// flagged edge between the newly-created entity and the candidate it was
// unsure about, for a future human-review pass (Phase 2, not built yet --
// nothing reads `status` today, this just makes the flag durable).
export async function writePossibleDuplicateEdge(newEntityId, candidateEntityId, reason) {
  await possibleDuplicatesCollection.save({
    _from: `${ARANGO_ENTITIES_COLLECTION}/${newEntityId}`,
    _to: `${ARANGO_ENTITIES_COLLECTION}/${candidateEntityId}`,
    reason,
    flagged_at: new Date().toISOString(),
    status: "pending_review",
  });
}

// Used by Step 5 to get a candidate's stored name/type when the embedding
// channel surfaced it (that channel only returns entity_id, not name --
// see entityMentions.js's searchSimilarMentions) -- the LLM needs the
// actual name to judge same/different, not just a snippet.
export async function getEntity(entityId) {
  try {
    return await entitiesCollection.document(entityId);
  } catch (err) {
    if (err.isArangoError && err.errorNum === 1202) return null; // document not found
    throw err;
  }
}

// Feeds Step 4's Jaro-Winkler channel -- every existing entity name of the
// given type, pulled into memory for in-process comparison (see the
// ensureEntitiesCollections comment above for why this can't run in AQL).
export async function getEntitiesByType(type) {
  const cursor = await db.query(aql`
    FOR e IN ${entitiesCollection}
      FILTER e.type == ${type}
      RETURN { _key: e._key, name: e.name }
  `);
  return cursor.all();
}

// Looks up the specific je_mentioned_in edge for one (entity, chunk) pair --
// used by Step 5 to pull a candidate's role for the *specific* past mention
// that matched, not its whole mention history (see dedupJudgment.js).
export async function getMentionedInEdge(entityId, chunkId) {
  const cursor = await db.query(aql`
    FOR edge IN ${mentionedInCollection}
      FILTER edge._from == ${`${ARANGO_ENTITIES_COLLECTION}/${entityId}`}
      FILTER edge._to == ${`${ARANGO_CHUNKS_COLLECTION}/${chunkId}`}
      LIMIT 1
      RETURN edge
  `);
  const results = await cursor.all();
  return results[0] || null;
}
