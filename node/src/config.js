// Centralized, environment-derived configuration. Every script that needs
// to know where infrastructure lives (ArangoDB connection details, where
// LanceDB stores its data) imports from here instead of reading
// process.env or hardcoding a path directly -- one place to change instead
// of several, and it's what makes this deployable rather than tied to one
// machine's layout.
//
// Values come from process.env, populated by Node's built-in
// --env-file=.env flag (see node/.env.example for the expected shape).

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

export const ARANGO_URL = process.env.ARANGO_URL;
export const ARANGO_DB = process.env.ARANGO_DB;
export const ARANGO_USER = process.env.ARANGO_USER;
export const ARANGO_PASSWORD = process.env.ARANGO_PASSWORD;

// LanceDB has no server to connect to -- a "database" is just a directory
// on disk. LANCEDB_DIR is optional in .env; if unset, defaults to a
// project-local folder, which is fine for local development but is exactly
// the kind of thing a real deployment would want to override (e.g. to
// point at a persistent volume instead of the app's own working directory).
export const LANCEDB_DIR = process.env.LANCEDB_DIR
  ? path.resolve(PROJECT_ROOT, process.env.LANCEDB_DIR)
  : path.join(PROJECT_ROOT, "data", "lancedb");

// Collection/table names, all in one place per the project's "je_" naming
// convention -- confirmed with the user before creation, not picked
// unilaterally (see _project_step_by_step_plan.md).
export const ARANGO_CHUNKS_COLLECTION = "je_chunks";
export const LANCEDB_CHUNKS_TABLE = "je_chunks";

// Step 3's raw, per-chunk extraction output -- confirmed with the user
// 2026-08-17 before creation, same as every other collection/table name
// here. Exists because Steps 4-6 (dedup/judgment/merge) aren't built yet;
// this is where Step 3's batch runner persists results so that expensive
// LLM extraction work never has to be redone once Steps 4-6 do exist.
// Env-overridable so a schema/prompt change can be trial-run into a scratch
// collection (ARANGO_RAW_EXTRACTIONS_COLLECTION=je_raw_extractions_test) and
// inspected before the real 3,569-chunk extraction is destroyed.
export const ARANGO_RAW_EXTRACTIONS_COLLECTION =
  process.env.ARANGO_RAW_EXTRACTIONS_COLLECTION || "je_raw_extractions";

// Ollama's own HTTP endpoint. No server-side auth/deployment concerns here
// (it's always localhost in this project's single-machine setup) but kept
// env-overridable anyway, same pattern as everything else in this file.
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// The model Step 3's entity extraction uses -- confirmed via real
// side-by-side testing against deepseek-r1:14b (faster and better recall,
// see _project_step_by_step_plan.md's E.1 build log entry) rather than
// picked by default.
export const EXTRACTION_MODEL = process.env.EXTRACTION_MODEL || "qwen3:8b";

// Step 1's chunk-embedding model, reused as-is for Step 4's mention-context
// embeddings later -- a BERT-based model (512-token input cap, see
// extract_and_chunk.py's CHUNK_SIZE_WORDS comment for why chunks are sized
// under that ceiling) rather than an LLM, since embedding is a fixed
// vector-encoding operation, not a judgment call.
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || "bge-large";

// How many files the server will actually process at once, regardless of
// how many upload requests arrive concurrently. 4 by default -- the low end
// of the 4-8 range decided earlier, conservative because Step 1's embedding
// calls already share this one machine's single Ollama instance (Step 3's
// entity-extraction calls will need their own, separate concurrency
// consideration later, per the phase-separation notes above).
export const UPLOAD_CONCURRENCY = process.env.UPLOAD_CONCURRENCY
  ? parseInt(process.env.UPLOAD_CONCURRENCY, 10)
  : 4;

// Steps 4-6 (dedup candidate generation, LLM judgment, merge/write) -- names
// confirmed with the user 2026-08-18, same je_ convention as everything else.
// je_entities/je_mentioned_in were in the original design; je_possible_duplicates
// is a necessary addition (the design only said "a flagged possible-duplicate
// edge" without naming a collection for it) for Step 5's "unsure" outcome.
export const ARANGO_ENTITIES_COLLECTION =
  process.env.ARANGO_ENTITIES_COLLECTION || "je_entities";
export const ARANGO_MENTIONED_IN_COLLECTION = "je_mentioned_in";
export const ARANGO_POSSIBLE_DUPLICATES_COLLECTION = "je_possible_duplicates";
export const LANCEDB_ENTITY_MENTIONS_TABLE = "je_entity_mentions";

// How many words on each side of a located mention go into its context
// snippet (Step 4's embedding channel). Fixed word-count window, not
// sentence-aware -- deliberately dumb since sentence-boundary detection on
// this corpus's PDF-extracted text isn't reliable (see the garbled-text
// finding), and Step 5's LLM judgment is the real correctness safety net
// regardless of snippet quality. Confirmed with the user 2026-08-18.
export const SNIPPET_WINDOW_WORDS = process.env.SNIPPET_WINDOW_WORDS
  ? parseInt(process.env.SNIPPET_WINDOW_WORDS, 10)
  : 15;

// Minimum Jaro-Winkler score (0-1) for an existing je_entities name to count
// as a Step 4 candidate against a new mention's bare name. Confirmed with
// the user 2026-08-18.
export const JARO_WINKLER_THRESHOLD = process.env.JARO_WINKLER_THRESHOLD
  ? parseFloat(process.env.JARO_WINKLER_THRESHOLD)
  : 0.85;

// How many entities dedupBatchRunner.js resolves concurrently. The strictly
// sequential version (one entity at a time) made ~31s/chunk against the real
// corpus -- multi-day territory for the full 3,549-chunk backlog. Running
// entities concurrently reopens a real race (two workers independently
// resolving the same not-yet-created real entity at once, both missing each
// other and creating duplicates -- a "late arrival" collision) that the
// sequential version avoided only as a side effect of never overlapping.
// Accepted deliberately: parallelize for speed, then run a separate cleanup
// pass afterward to merge any duplicate entities the race produced, rather
// than paying for correct-under-concurrency locking (double-checked
// candidate re-verification) up front. 3 is a starting point, not measured
// against this specific machine yet -- confirmed with the user 2026-08-18.
export const DEDUP_CONCURRENCY = process.env.DEDUP_CONCURRENCY
  ? parseInt(process.env.DEDUP_CONCURRENCY, 10)
  : 3;

// Step 7 (coreference). Edge collection linking entity nodes judged to be the
// same real-world entity under different surface forms ("Jeffrey Epstein" /
// "Mr. Epstein" / "Epstein"). Deliberately an edge layer rather than a
// destructive merge: legal provenance means the surface form the document
// actually used has to stay recoverable, an edge is reversible where a merge
// is not, and every coref decision stays auditable instead of being baked in.
export const ARANGO_SAME_AS_COLLECTION = process.env.ARANGO_SAME_AS_COLLECTION || "je_same_as";

// Largest candidate cluster handed to one Step 7 LLM call. Measured against
// the real graph: of 2,115 (type, token) pairs only ~13 exceed 15 members, so
// this cap costs almost nothing in coverage while keeping the prompt well
// inside the 4096-token context. Oversized clusters are truncated to their
// highest-mention members (the ones that actually matter for retrieval) and
// the truncation is logged rather than done silently.
export const COREF_MAX_CLUSTER_SIZE = process.env.COREF_MAX_CLUSTER_SIZE
  ? parseInt(process.env.COREF_MAX_CLUSTER_SIZE, 10)
  : 15;

// How many clusters Step 7 judges concurrently. Same reasoning as
// DEDUP_CONCURRENCY, but without the race: Step 7 only ever writes edges
// between entities that already exist, so there is no check-then-act to lose.
export const COREF_CONCURRENCY = process.env.COREF_CONCURRENCY
  ? parseInt(process.env.COREF_CONCURRENCY, 10)
  : 3;

// Which entity types may be compared against each other during dedup (Step 4)
// and coreference (Step 7).
//
// Type is a hard partition everywhere downstream -- getEntitiesByType scopes
// the Jaro-Winkler channel, searchSimilarMentions scopes the vector search,
// buildClusters scopes coref. Before this, a name the model typed "court" in
// one chunk and "organization" in another landed in two disjoint pools and
// could never be merged by any pass, no matter how obvious the match. The
// full-corpus audit found 68 such names ("county of palm beach" as both court
// and organization, "abernathy" as all three).
//
// Adding "location" and "facility" would have made that worse on its own --
// every extra box is another chance the model picks a different one for the
// same name. Grouping is what converts the richer taxonomy into a net win:
// place-like and institution-like types share a pool, so a mistyped place
// still finds its twin, while a person is never compared against a building.
const TYPE_GROUPS = [
  ["person"],
  ["court", "organization", "location", "facility"],
];

// Types a mention of `type` may draw candidates from, including itself. An
// unknown type falls back to itself alone -- no silent widening.
export function comparableTypes(type) {
  const group = TYPE_GROUPS.find((g) => g.includes(type));
  return group ?? [type];
}

// Step 8 / retrieval comparison. How many chunks a retrieval strategy puts in
// front of the answer model. 8 x 350 words is roughly 2,800 words of context,
// which sits comfortably inside qwen3:8b's window alongside the prompt and
// still leaves room for the answer. Held identical across strategies on
// purpose: giving one retriever a bigger budget than the other would measure
// context length, not retrieval quality.
export const RETRIEVAL_TOP_K = process.env.RETRIEVAL_TOP_K
  ? parseInt(process.env.RETRIEVAL_TOP_K, 10)
  : 8;

// Upper bound on answer length. Generous enough for the aggregation questions
// ("list every organization associated with X") that Graph RAG is expected to
// win on, since truncating those would penalize the strategy for succeeding.
export const ANSWER_MAX_TOKENS = process.env.ANSWER_MAX_TOKENS
  ? parseInt(process.env.ANSWER_MAX_TOKENS, 10)
  : 1200;

// The model that turns retrieved context into an answer. Separate from
// EXTRACTION_MODEL on purpose: qwen3:8b was chosen by measured side-by-side
// testing, but for *entity extraction from a chunk*, which is a different job
// from *answering a question over retrieved passages*. Reusing it here was an
// inherited default, never a measured one. Defaults to the same model so
// nothing changes silently, but is now switchable for the naive-vs-graph eval
// (deepseek-r1:14b and :32b are both installed locally).
export const ANSWER_MODEL = process.env.ANSWER_MODEL || EXTRACTION_MODEL;

// Context window for answer generation, in tokens.
//
// Not a tuning knob -- a bug fix. Ollama's default context for this model is
// 4096, and it clips silently rather than erroring. Measured 2026-08-27: a k=8
// answer prompt is 4,235 tokens, so `prompt_eval_count` came back as exactly
// 4096 on every call and the tail of the last source was being dropped before
// the model ever saw it. Confirmed by re-running the identical prompt with
// num_ctx=8192, which reported the true 4,235.
//
// A ~3% clip, always at the same end of the prompt, always invisible. Every
// row in eval/results/runs.jsonl was produced under it.
export const ANSWER_NUM_CTX = process.env.ANSWER_NUM_CTX
  ? parseInt(process.env.ANSWER_NUM_CTX, 10)
  : 8192;

// Instruction prefix prepended to a QUERY (never to a passage) before
// embedding. BAAI documents this for bge-*-en-v1.5 asymmetric retrieval --
// passages embedded bare, short queries carrying the instruction -- and it was
// added here on that documentation alone, without testing.
//
// Measured on this corpus, it HURTS. For "What is the obiter dicta in this
// case?", the oral-argument transcript that actually answers it ranks #22 of
// 3,338 without the prefix and #80 with it -- a 4x degradation that pushes the
// right document out of any plausible retrieval window.
//
// Defaults to empty (off) rather than being deleted, because one query is one
// data point and the eval should settle it across a full question set. Set
// BGE_QUERY_PREFIX="Represent this sentence for searching relevant passages: "
// to A/B it.
export const BGE_QUERY_PREFIX = process.env.BGE_QUERY_PREFIX ?? "";

// Hybrid retrieval (see retrieval/hybridRetriever.js). Three cheap channels run
// in parallel over the whole corpus and are rank-fused, rather than one scorer
// trying to serve every question shape.
//
// Measured motivation: no single ranking wins both query types. Ranking the
// document that answers each question --
//        strategy              "obiter dicta"   "Alfredo Rodriguez"
//        best chunk                 #14                #3
//        density in top-100          #2               #12
// -- they are inversely correlated, because a conceptual question is answered
// by a document's overall character and a specific question by one passage.

// How deep each channel looks before fusion. Wider than RETRIEVAL_TOP_K on
// purpose: a channel has to be able to surface something the others rank badly,
// which is the entire point of running more than one.
export const CHANNEL_POOL = process.env.CHANNEL_POOL
  ? parseInt(process.env.CHANNEL_POOL, 10)
  : 50;

// Chunk pool the density channel counts within. 100 was where the split above
// was measured; it is a pool size, not a tuned threshold -- density is a
// relative count, so the exact number moves results far less than a distance
// cutoff would.
export const DENSITY_POOL = process.env.DENSITY_POOL
  ? parseInt(process.env.DENSITY_POOL, 10)
  : 100;

// Reciprocal Rank Fusion constant. 60 is the value from the original RRF paper
// and the de-facto default; it damps the top of each channel's list so one
// channel's #1 cannot single-handedly dominate the fused order.
export const RRF_K = process.env.RRF_K ? parseInt(process.env.RRF_K, 10) : 60;

// Whether hybrid retrieval spends an LLM call expanding the query before the
// lexical channel runs. On by default: the lexical channel is close to useless
// without it (a question rarely shares wording with the passage that answers
// it), and it is one local call per question.
export const USE_QUERY_EXPANSION = process.env.USE_QUERY_EXPANSION !== "false";
