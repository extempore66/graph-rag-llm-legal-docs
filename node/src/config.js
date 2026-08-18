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
export const ARANGO_RAW_EXTRACTIONS_COLLECTION = "je_raw_extractions";

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
export const ARANGO_ENTITIES_COLLECTION = "je_entities";
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
