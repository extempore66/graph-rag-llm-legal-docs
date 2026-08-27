// The third retrieval strategy: reach chunks through the entity graph rather
// than through embedding similarity.
//
// The premise of the whole comparison is that all three strategies select from
// the SAME 3,338 chunks and hand them to the SAME answer generator -- only the
// selection path differs. ArangoDB's je_chunks holds no text and no vector
// (verified: _key, source_file, page_start, page_end, chunk_index, word_count);
// it is a set of graph anchors whose _key equals LanceDB's chunk_id. So the
// graph does not own a second copy of the corpus, it owns a second index over
// the same one.
//
// What this buys, concretely, is recall that similarity cannot reach:
//   Ms. Giuffre 592 + Virginia L. Giuffre 294 + Plaintiff Giuffre 3
//   + Ms. Virginia Roberts Giuffre 1  =  890 mentions, one person, 876 chunks.
// "Ms. Giuffre" scores 0.617 against "Virginia Giuffre" on name similarity --
// below the 0.85 threshold Step 4 needed -- so Step 7's je_same_as edges are
// the only thing that connects them, and no embedding reliably does.
//
// Every result carries the path that produced it (see buildPath). That is not
// decoration: a chunk arrived at by traversal can say WHY it was selected and
// what else was reachable, which is the one thing vector search structurally
// cannot report. The UI depends on it and it is near-impossible to
// reconstruct after the fact, so it is produced during traversal.

import * as lancedb from "@lancedb/lancedb";
import { Database, aql } from "arangojs";
import {
  ARANGO_URL, ARANGO_DB, ARANGO_USER, ARANGO_PASSWORD,
  LANCEDB_DIR, LANCEDB_CHUNKS_TABLE, RETRIEVAL_TOP_K,
} from "../config.js";
import { tokenize, looksGeneric } from "../nameUtils.js";
import { retrieveNaive } from "./naiveRetriever.js";

// How many question-matched entities to traverse from. Past a handful the
// tail is noise -- a question mentioning six distinct people is rare, and an
// uncapped list lets one weak token match drag in hundreds of chunks.
const MAX_LINKED_ENTITIES = 8;

// Chunks pulled into the ranking pool before truncation to k. Generous
// because ranking is the cheap part; the traversal already happened.
const CHUNK_POOL = 200;

// How many edge-evidence entries to keep per chunk. Enough to show that a
// passage was reached several ways; short enough that 200 chunks of them is
// a few kilobytes rather than a few megabytes.
const MAX_EVIDENCE_PER_CHUNK = 4;

const db = new Database({
  url: ARANGO_URL, databaseName: ARANGO_DB,
  auth: { username: ARANGO_USER, password: ARANGO_PASSWORD },
});

let lanceDbConnection = null;
async function getLanceDb() {
  if (!lanceDbConnection) lanceDbConnection = await lancedb.connect(LANCEDB_DIR);
  return lanceDbConnection;
}

// The entity index is loaded once and reused. 2,014 entities is small enough
// to hold in memory, and re-reading it per question would dominate the
// latency of a strategy whose whole point is that traversal is cheap.
let entityIndex = null;
async function getEntityIndex() {
  if (entityIndex) return entityIndex;
  const cursor = await db.query(aql`
    FOR e IN je_entities
      LET m = LENGTH(FOR x IN je_mentioned_in FILTER x._from == e._id RETURN 1)
      RETURN { key: e._key, name: e.name, type: e.type, mentions: m }
  `);
  const rows = await cursor.all();
  entityIndex = rows.map((r) => ({ ...r, tokens: tokenize(r.name) }));
  return entityIndex;
}

// Category words that name an entity TYPE rather than an entity. Measured
// need: on the first three-way eval, graph retrieval fell back on 14 of 35
// questions, concentrated in completeness_counting (4/5) and aggregation
// (3/5) -- because "which courts appear in this corpus" and "how many people
// are identified as attorneys" name no entity at all. Name matching cannot
// help; type matching can.
//
// NOTE these are matched against the RAW question, not tokenize() output.
// tokenize() deliberately strips "court", "attorney", "counsel", "judge" and
// "company" as NON_IDENTIFYING_TOKENS, because inside a *name* they carry no
// identity -- "Peter Guirguis, Esq." is not a duplicate of "Bradley Edwards,
// ESQ." on the strength of "esq". Inside a *question* the same word is the
// whole signal. Same word, opposite role, so it must be read before stripping.
//
// Judges map to "court": in this corpus the extractor types "The Honorable
// Loretta A. Preska" as court, not person. Mapping them to person would
// silently return nothing.
//
// PERSON IS DELIBERATELY ABSENT, and this was measured rather than assumed.
// Mapping "attorneys"/"people"/"witnesses" to type person selects from 916
// entities -- 45% of the graph -- so ranking by mention count returns the case
// principals: "how many people are identified as attorneys" anchored on
// Jeffrey Epstein, Ms. Giuffre and Ghislaine Maxwell, none of them attorneys.
// Role data cannot rescue it either: 29 mentions carry role "counsel" against
// 18,576 with none. Vector search does better here, because signature blocks
// contain both the word "attorney" and the actual names, so those questions
// are left to fall back. A type is only useful for anchoring when it is small
// and well defined (court 112, organization 481) -- not when it is the bulk of
// the graph.
const CATEGORY_TERMS = new Map([
  ["court", "court"], ["courts", "court"], ["tribunal", "court"],
  ["judge", "court"], ["judges", "court"], ["judiciary", "court"],
  ["firm", "organization"], ["firms", "organization"],
  ["company", "organization"], ["companies", "organization"],
  ["organization", "organization"], ["organizations", "organization"],
  ["agency", "organization"], ["agencies", "organization"],
  ["locations", "location"], ["places", "location"], ["cities", "location"],
  ["facilities", "facility"], ["properties", "facility"], ["residences", "facility"],
]);

// How many entities a single category contributes. Unbounded would mean all
// 916 persons for any question containing "people". Ranked by mention count,
// so the well-attested entities anchor the traversal and one-mention
// extraction noise does not.
const MAX_TYPE_ENTITIES = 25;

export function detectCategories(question) {
  const words = question.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  const types = new Set();
  for (const w of words) {
    const t = CATEGORY_TERMS.get(w);
    if (t) types.add(t);
  }
  return [...types];
}

/**
 * Entities selected by TYPE rather than by name, for questions that describe a
 * category instead of naming a member of it.
 */
export function linkByType(types, index) {
  const out = [];
  for (const type of types) {
    const ofType = index
      .filter((e) => e.type === type && !looksGeneric(e.name))
      .sort((a, b) => b.mentions - a.mentions)
      .slice(0, MAX_TYPE_ENTITIES);
    out.push(...ofType.map((e) => ({ ...e, overlap: 0, coverage: 0, via_type: type })));
  }
  return out;
}

/**
 * Deterministic entity linking: which known entities does this question name?
 *
 * Deliberately NOT an LLM call. When graph retrieval returns something
 * surprising, the first question is always "why did it go there?", and
 * "because the model decided" is not an answer anyone can act on. Token
 * overlap is inspectable, instant, and reuses tokenize() -- the same
 * normalisation (titles, ranks, corporate suffixes and court scaffolding
 * stripped) that the dedup guard was tuned on, so "Detective Joseph Recarey"
 * and "Mr. Recarey" both reduce to {joseph, recarey} / {recarey}.
 *
 * Overlap is scored in both directions on purpose. Entity-tokens-inside-the-
 * question handles the ordinary case ("what did Ghislaine Maxwell say"), while
 * question-tokens-inside-the-entity is what makes counting questions work at
 * all: "how many Jane Doe plaintiffs" must reach "Jane Doe 102", whose tokens
 * are a superset of the question's, not a subset.
 */
export function linkEntities(question, index) {
  const qTokens = tokenize(question);
  if (qTokens.size === 0) return [];

  const scored = [];
  for (const ent of index) {
    if (ent.tokens.size === 0) continue;
    // A generic name ("Defendant", "Plaintiff's counsel") matching on its one
    // structural token would anchor a traversal on nothing at all.
    if (looksGeneric(ent.name)) continue;

    let overlap = 0;
    for (const t of ent.tokens) if (qTokens.has(t)) overlap++;
    if (overlap === 0) continue;

    // A multi-token name must match on more than one token. One shared token
    // between two multi-token names is a coincidence, not a reference: asking
    // about "Detective Joseph Recarey" pulled in "Dr. Joseph Heaney" on
    // {joseph} alone, and asking about Virginia Giuffre pulled in her
    // relative "Robert Giuffre" on {giuffre}. Single-token entities are
    // exempt because one token is all they have -- "Ms. Maxwell" reduces to
    // {maxwell}, and requiring two would make the largest nodes unreachable.
    if (ent.tokens.size > 1 && overlap < 2) continue;

    // Coverage of the ENTITY's own tokens, so "Maxwell" (1 of 1 matched)
    // is not beaten by a 5-token name that happened to share one word.
    const coverage = overlap / ent.tokens.size;
    scored.push({ ...ent, overlap, coverage });
  }

  // Coverage first, then how well attested the entity is: between two equally
  // good name matches the one mentioned 534 times is the one the question
  // almost certainly meant, not the one mentioned twice.
  scored.sort((a, b) => b.coverage - a.coverage || b.mentions - a.mentions);
  return scored.slice(0, MAX_LINKED_ENTITIES);
}

/**
 * One hop out over je_same_as, so a match on any surface form reaches the
 * whole family. This is the step that turns a hit on "Ms. Giuffre" into
 * access to all 876 chunks rather than the 592 that use that one spelling.
 */
async function expandFamilies(keys) {
  if (keys.length === 0) return [];
  const ids = keys.map((k) => `je_entities/${k}`);
  const cursor = await db.query(aql`
    FOR id IN ${ids}
      LET seed = DOCUMENT(id)
      FILTER seed != null
      LET sibs = (FOR s IN 1..1 OUTBOUND id je_same_as RETURN { key: s._key, name: s.name })
      RETURN { seed: { key: seed._key, name: seed.name }, siblings: sibs }
  `);
  return cursor.all();
}

/**
 * Every chunk reachable from a set of entities, with the entity that reached
 * it. Ranking happens in JS rather than AQL because the ordering rule is a
 * judgement about relevance, and it belongs where it can be read and changed
 * next to the comment explaining it.
 *
 * NO LIMIT, and that is a deliberate reversal. This query used to carry
 * `LIMIT CHUNK_POOL * 10` as a guard on the ranking pool, but an AQL LIMIT
 * inside a nested FOR cuts the COMBINED stream, not each inner loop -- so the
 * first entity's edges consumed the whole budget and later entities were not
 * merely under-sampled, they contributed nothing.
 *
 * Measured 2026-08-27 on the Giuffre/Maxwell/Epstein set (44 keys after family
 * expansion):
 *
 *   LIMIT 2000   edges 2000  chunks 1567  entities reached  6   10.4 ms
 *   LIMIT 5000   edges 4004  chunks 2577  entities reached 44   12.4 ms
 *   no LIMIT     edges 4004  chunks 2577  entities reached 44   12.4 ms
 *
 * Six of forty-four. The cap cost 38 entities to save 2 ms.
 *
 * The absolute worst case is bounded by the collection itself: traversing from
 * EVERY entity in the graph (2,014 of them) returns all 19,009 edges in 46.8
 * ms. There is no runaway to protect against at this corpus size, and
 * downstream is bounded anyway -- rankChunks slices to CHUNK_POOL.
 *
 * If je_mentioned_in ever grows by orders of magnitude this needs revisiting,
 * and the fix then is a per-entity budget (a LIMIT inside a subquery per id),
 * not a shared one. A shared cap cannot be made fair.
 */
async function chunksForEntities(keys) {
  if (keys.length === 0) return [];
  const ids = keys.map((k) => `je_entities/${k}`);
  const cursor = await db.query(aql`
    FOR id IN ${ids}
      FOR edge IN je_mentioned_in
        FILTER edge._from == id
        RETURN {
          entity_key: PARSE_IDENTIFIER(edge._from).key,
          chunk_id: PARSE_IDENTIFIER(edge._to).key,
          role: edge.role,
          textual_evidence: edge.textual_evidence
        }
  `);
  return cursor.all();
}

/**
 * The TRUE reach of a set of entities: how many mentions they have, and how
 * many distinct chunks those mentions land in.
 *
 * Separate from chunksForEntities because that query is capped at
 * CHUNK_POOL * 10 edges -- a deliberate bound on the ranking pool, since
 * ranking beyond a few hundred candidates changes nothing. But the cap also
 * silently bounded the number the UI reported as "reachable": for a heavily
 * mentioned entity the count came back at whatever the cap allowed, which made
 * a ceiling look like a measurement.
 *
 * This query has no LIMIT, and returns only two integers. It is what the
 * "1,770 reachable" style claim now rests on.
 */
async function countReachable(keys) {
  if (keys.length === 0) return { mentions: 0, chunks: 0 };
  const ids = keys.map((k) => `je_entities/${k}`);
  const cursor = await db.query(aql`
    LET touched = (
      FOR id IN ${ids}
        FOR edge IN je_mentioned_in
          FILTER edge._from == id
          RETURN edge._to
    )
    RETURN { mentions: LENGTH(touched), chunks: LENGTH(UNIQUE(touched)) }
  `);
  const [row] = await cursor.all();
  return row ?? { mentions: 0, chunks: 0 };
}

/**
 * Chunks ranked by how much of the question's entity set they actually cover.
 *
 * Distinct entities first, mention count second. A chunk naming both people a
 * two-person question asked about is more use than one naming the more common
 * of them five times -- which is exactly the conjunction ("filings mentioning
 * both Maxwell and Epstein") that a single query vector cannot express, since
 * embedding "Maxwell and Epstein" yields one point resembling a blend of the
 * two rather than the set containing both.
 */
function rankChunks(edges, seedKeyByFamilyKey) {
  const byChunk = new Map();
  for (const e of edges) {
    if (!byChunk.has(e.chunk_id)) {
      byChunk.set(e.chunk_id, { chunk_id: e.chunk_id, seeds: new Set(), mentions: 0, evidence: [] });
    }
    const row = byChunk.get(e.chunk_id);
    // Credit the SEED entity, not the family member: two surface forms of one
    // person in a chunk is one person, and counting it as two would rank
    // heavily-aliased entities above genuine multi-entity matches.
    row.seeds.add(seedKeyByFamilyKey.get(e.entity_key) ?? e.entity_key);
    row.mentions++;
    // Named `evidence`, not `via`: this is the payload carried on each
    // je_mentioned_in edge -- who was named, in what role, and the words that
    // said so. `via` previously meant this here and ALSO meant "matched
    // entities" in the UI label, which is two meanings for one word inside one
    // object. Capped at 4 because a heavily mentioned entity can hit one chunk
    // many times, and this is held for CHUNK_POOL chunks at once.
    if (row.evidence.length < MAX_EVIDENCE_PER_CHUNK) {
      row.evidence.push({ entity_key: e.entity_key, role: e.role, quote: e.textual_evidence });
    }
  }
  return [...byChunk.values()]
    .sort((a, b) => b.seeds.size - a.seeds.size || b.mentions - a.mentions || a.chunk_id.localeCompare(b.chunk_id))
    .slice(0, CHUNK_POOL);
}

// Text and page metadata live only in LanceDB, so the final hydrate is a
// lookup by chunk_id -- the join key verified equal to Arango's _key.
async function hydrate(chunkIds) {
  if (chunkIds.length === 0) return new Map();
  const table = await (await getLanceDb()).openTable(LANCEDB_CHUNKS_TABLE);
  const quoted = chunkIds.map((id) => `"${id}"`).join(", ");
  const rows = await table
    .query()
    .where(`chunk_id IN (${quoted})`)
    .select(["chunk_id", "source_file", "page_start", "page_end", "text"])
    .toArray();
  return new Map(rows.map((r) => [r.chunk_id, r]));
}

/**
 * Graph retrieval for one question.
 *
 * Returns the same shape as retrieveNaive so runEval and answerGenerator need
 * no special case, plus a `path` on each row and a `graph_path` summary on the
 * array itself.
 *
 * Falls back to vector search when the question names no known entity -- and
 * says so via graph_path.fallback rather than hiding it. A strategy that
 * silently returned nothing on such questions would look artificially precise
 * in the eval while being useless in the product; one that fell back quietly
 * would take credit for the vector channel's work. The fallback rate is
 * itself a finding: it measures how much of a question set is entity-shaped.
 *
 * @param {string} question
 * @param {number} [k=RETRIEVAL_TOP_K]
 */
/**
 * Link, expand and rank -- everything up to the point where the two consumers
 * diverge. Shared rather than duplicated because retrieveGraph (the standalone
 * strategy) and graphCandidates (the hybrid channel) must resolve a question
 * IDENTICALLY. If the two drifted apart, the eval comparing them would be
 * measuring the drift rather than the effect of fusion.
 *
 * Returns { anchored: false } when the question names no known entity and
 * matches no recognised category. What to do about that is the caller's
 * decision, and the two callers make opposite ones -- see each.
 */
async function resolveGraph(question) {
  const index = await getEntityIndex();
  const named = linkEntities(question, index);

  // Type linking supplements name linking only when name linking came back
  // weak. A question that clearly names two or more entities is already
  // anchored, and adding 25 entities of a type would swamp it -- "what did
  // Ghislaine Maxwell tell the court" should traverse Maxwell, not every
  // court in the corpus.
  const categories = named.length < 2 ? detectCategories(question) : [];
  const typed = categories.length ? linkByType(categories, index) : [];
  const seen = new Set(named.map((e) => e.key));
  const linked = [...named, ...typed.filter((e) => !seen.has(e.key))];
  const linkMode = named.length && typed.length ? "name+type" : typed.length ? "type" : "name";

  if (linked.length === 0) return { anchored: false, categories };

  const families = await expandFamilies(linked.map((l) => l.key));

  // Family member -> seed, so ranking can credit the person rather than the
  // spelling (see rankChunks).
  const seedKeyByFamilyKey = new Map();
  const allKeys = [];
  for (const fam of families) {
    seedKeyByFamilyKey.set(fam.seed.key, fam.seed.key);
    allKeys.push(fam.seed.key);
    for (const s of fam.siblings) {
      seedKeyByFamilyKey.set(s.key, fam.seed.key);
      allKeys.push(s.key);
    }
  }

  // The pool query and the true-reach count are independent, so they run
  // together: the pool is capped and feeds ranking, the count is uncapped and
  // feeds what the UI reports.
  const uniqueKeys = [...new Set(allKeys)];
  const [edges, reach] = await Promise.all([
    chunksForEntities(uniqueKeys),
    countReachable(uniqueKeys),
  ]);

  return {
    anchored: true,
    index,
    linked,
    linkMode,
    categories,
    families,
    edges,
    reach,
    ranked: rankChunks(edges, seedKeyByFamilyKey),
  };
}

// The provenance record, built once so both consumers report the traversal the
// same way. `returned` differs between them (one hydrates k rows, the other
// nominates a pool), so it is passed in rather than derived.
/**
 * The per-chunk provenance record: why this chunk was selected, and the words
 * on the edges that selected it.
 *
 * Shared by retrieveGraph and graphCandidates for the same reason resolveGraph
 * is shared -- two copies of this would drift, and the two consumers would
 * then disagree about what the same traversal found.
 */
function buildPath(r, nameByKey) {
  return {
    matched_entities: [...r.seeds].map((key) => nameByKey.get(key) ?? key),
    entity_count: r.seeds.size,
    mention_count: r.mentions,
    evidence: r.evidence.map((v) => ({ ...v, entity_name: nameByKey.get(v.entity_key) ?? v.entity_key })),
  };
}

function buildGraphPath(g, returned) {
  return {
    fallback: false,
    link_mode: g.linkMode,
    categories: g.categories,
    linked_entities: g.linked.map((l) => ({
      name: l.name,
      type: l.type,
      mentions: l.mentions,
      coverage: Number(l.coverage.toFixed(2)),
    })),
    families: g.families.map((f) => ({ seed: f.seed.name, variants: f.siblings.map((s) => s.name) })),
    // From the uncapped count query, not from the capped ranking pool. These
    // two used to be the same number and they were not the same fact.
    reachable_chunks: g.reach.chunks,
    reachable_mentions: g.reach.mentions,
    // How many of those chunks reached the ranker. Now always equal to
    // reachable_chunks, since the traversal is uncapped -- kept as a separate
    // field because it is the number that would diverge first if a cap ever
    // came back, and a silent divergence is exactly what went wrong before.
    pool_chunks: new Set(g.edges.map((e) => e.chunk_id)).size,
    returned,
  };
}

const NO_ANCHOR_REASON = "question names no known entity and no recognised category";

/**
 * Graph retrieval for one question.
 *
 * Returns the same shape as retrieveNaive so runEval and answerGenerator need
 * no special case, plus a `path` on each row and a `graph_path` summary on the
 * array itself.
 *
 * Falls back to vector search when the question names no known entity -- and
 * says so via graph_path.fallback rather than hiding it. A strategy that
 * silently returned nothing on such questions would look artificially precise
 * in the eval while being useless in the product; one that fell back quietly
 * would take credit for the vector channel's work. The fallback rate is
 * itself a finding: it measures how much of a question set is entity-shaped.
 *
 * @param {string} question
 * @param {number} [k=RETRIEVAL_TOP_K]
 */
export async function retrieveGraph(question, k = RETRIEVAL_TOP_K) {
  const g = await resolveGraph(question);

  if (!g.anchored) {
    const rows = await retrieveNaive(question, k);
    rows.graph_path = { fallback: true, reason: NO_ANCHOR_REASON, link_mode: "none", categories: g.categories, linked_entities: [] };
    return rows;
  }

  const top = g.ranked.slice(0, k);
  const textById = await hydrate(top.map((r) => r.chunk_id));

  const nameByKey = new Map(g.index.map((e) => [e.key, e.name]));
  const results = top
    .map((r) => {
      const row = textById.get(r.chunk_id);
      if (!row) return null; // chunk in the graph but absent from LanceDB
      return {
        chunk_id: r.chunk_id,
        source_file: row.source_file,
        page_start: row.page_start,
        page_end: row.page_end,
        text: row.text,
        // No cosine distance exists here: this chunk was not selected by
        // similarity. Null rather than 0, which would read as "perfect match".
        distance: null,
        path: buildPath(r, nameByKey),
      };
    })
    .filter(Boolean);

  results.graph_path = buildGraphPath(g, results.length);
  return results;
}

/**
 * The same traversal, exposed as a nomination list for hybrid fusion.
 *
 * Returns chunk_ids in graph rank order and nothing else -- no text, no page
 * metadata. The fusing caller already holds the whole corpus in memory and
 * hydrates the survivors itself, so hydrating here would be work thrown away
 * for every chunk that loses the fusion.
 *
 * The critical difference from retrieveGraph: an unanchored question yields an
 * EMPTY list, never a vector fallback. Falling back here would feed the vector
 * ranking into RRF a second time under a different channel name, which is not
 * a fallback but double-counting -- it would silently double the vector
 * channel's voting weight on exactly the questions where graph contributes
 * nothing. An empty channel abstains, and the other three decide.
 *
 * @param {string} question
 * @param {number} limit  how many chunk_ids to nominate
 */
export async function graphCandidates(question, limit) {
  const g = await resolveGraph(question);
  if (!g.anchored) {
    return {
      chunk_ids: [],
      graph_path: { fallback: true, reason: NO_ANCHOR_REASON, link_mode: "none", categories: g.categories, linked_entities: [] },
    };
  }
  const top = g.ranked.slice(0, limit);
  const nameByKey = new Map(g.index.map((e) => [e.key, e.name]));

  // Paths for every nominated chunk, keyed by chunk_id. Hybrid attaches these
  // to whichever chunks survive fusion.
  //
  // Previously this function returned ids alone, so the provenance the
  // traversal had already computed was discarded at the channel boundary: the
  // graph strategy could show WHY a chunk was selected and hybrid could not,
  // even though both ran the identical traversal. Cheap to carry -- these are
  // already in memory, and only k of them are ever rendered.
  const paths = new Map(top.map((r) => [r.chunk_id, buildPath(r, nameByKey)]));

  return { chunk_ids: top.map((r) => r.chunk_id), paths, graph_path: buildGraphPath(g, top.length) };
}
