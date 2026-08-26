// Runs the question set through one or more retrieval strategies and records
// everything needed to grade them, without grading correctness itself -- that
// requires a human reading the source PDFs, and a machine-generated gold answer
// would just measure both systems against one system's reading.
//
// Usage:
//   node --env-file=.env eval/runEval.js                     all strategies, all questions
//   node --env-file=.env eval/runEval.js --only naive        one strategy
//   node --env-file=.env eval/runEval.js --limit 2           first N questions (plumbing check)
//   node --env-file=.env eval/runEval.js --stratum multi_hop one stratum
//
// Resumable, like every other batch runner here: results are appended per
// (strategy, question) and an existing pair is skipped. A run interrupted at
// question 20 of 35 resumes at 20 rather than re-spending the LLM calls.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { retrieveNaive } from "../src/retrieval/naiveRetriever.js";
import { retrieveHybrid } from "../src/retrieval/hybridRetriever.js";
import { retrieveGraph } from "../src/retrieval/graphRetriever.js";
import { generateAnswer } from "../src/retrieval/answerGenerator.js";
import { ANSWER_MODEL, RETRIEVAL_TOP_K, BGE_QUERY_PREFIX, USE_QUERY_EXPANSION } from "../src/config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Graph is absent on purpose rather than stubbed: a stub that returns nothing
// would silently score as "retrieved nothing" and pollute the comparison with a
// number that looks like a measurement. It gets added when it exists.
const STRATEGIES = {
  naive: retrieveNaive,
  hybrid: retrieveHybrid,
  // Added once graphRetriever existed. It was deliberately omitted (not
  // stubbed) until then, so no row in runs.jsonl ever claimed a graph result
  // that had not been measured.
  graph: retrieveGraph,
};

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const only = arg("only");
const stratum = arg("stratum");
const limit = arg("limit") ? parseInt(arg("limit"), 10) : Infinity;

const set = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));
let questions = set.questions;
if (stratum) questions = questions.filter((q) => q.stratum === stratum);
questions = questions.slice(0, limit);

const strategies = only ? { [only]: STRATEGIES[only] } : STRATEGIES;
if (Object.values(strategies).some((s) => !s)) {
  console.error(`Unknown strategy. Available: ${Object.keys(STRATEGIES).join(", ")}`);
  process.exit(1);
}

const resultsDir = path.join(__dirname, "results");
fs.mkdirSync(resultsDir, { recursive: true });
const resultsPath = path.join(resultsDir, "runs.jsonl");

// Resume: everything already recorded for this exact configuration.
// Configuration is part of the key because the same question under a different
// ANSWER_MODEL or a different prefix setting is a different measurement, not a
// duplicate -- that is precisely how the A/B comparisons get run.
const configKey = `${ANSWER_MODEL}|k=${RETRIEVAL_TOP_K}|prefix=${BGE_QUERY_PREFIX ? "on" : "off"}|expand=${USE_QUERY_EXPANSION}`;
const done = new Set();
if (fs.existsSync(resultsPath)) {
  for (const line of fs.readFileSync(resultsPath, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    done.add(`${r.config}|${r.strategy}|${r.id}`);
  }
}

console.log(`config: ${configKey}`);
console.log(`questions: ${questions.length}  strategies: ${Object.keys(strategies).join(", ")}`);
console.log(`already recorded: ${done.size} row(s) in ${resultsPath}\n`);

const short = (f) => f.replace("gov.uscourts.nysd.447706.", "").replace(".pdf", "");

for (const q of questions) {
  for (const [name, retrieve] of Object.entries(strategies)) {
    const key = `${configKey}|${name}|${q.id}`;
    if (done.has(key)) {
      console.log(`[skip] ${q.id} ${name}`);
      continue;
    }

    const started = Date.now();
    let row;
    try {
      const chunks = await retrieve(q.question);
      const answer = await generateAnswer(q.question, chunks);
      row = {
        config: configKey,
        strategy: name,
        id: q.id,
        stratum: q.stratum,
        question: q.question,
        predicted_winner: q.predicted_winner,
        // Retrieval evidence -- objective, gradeable without a human.
        retrieved: chunks.map((c) => ({
          chunk_id: c.chunk_id,
          source_file: c.source_file,
          page_start: c.page_start,
          distance: c.distance ?? null,
          channels: c.channels ?? null,
          // Graph traversal provenance: which resolved entities reached this
          // chunk. Null for strategies that select by similarity.
          path: c.path ?? null,
        })),
        documents: [...new Set(chunks.map((c) => short(c.source_file)))],
        // Set only by the graph strategy: the linked entities, the same_as
        // families they expanded into, and whether it fell back to vector
        // because the question named no known entity. Recorded because the
        // fallback rate is itself a result -- it measures how much of a
        // question set is entity-shaped.
        graph_path: chunks.graph_path ?? null,
        // Answer evidence -- correctness still needs a human, everything else does not.
        answer: answer.answer,
        answered_from_context: answer.answered_from_context,
        citations: answer.citations.length,
        citation_rate: chunks.length ? answer.citations.length / chunks.length : 0,
        invalid_citations: answer.invalid_citations,
        truncated: answer.truncated,
        total_ms: Date.now() - started,
        answer_ms: answer.latency_ms,
        // Filled in by a human later; never by this script.
        human_correct: null,
        human_notes: null,
        run_at: new Date().toISOString(),
      };
    } catch (err) {
      row = { config: configKey, strategy: name, id: q.id, stratum: q.stratum, error: err.message, run_at: new Date().toISOString() };
      console.error(`[FAIL] ${q.id} ${name}: ${err.message}`);
    }

    fs.appendFileSync(resultsPath, JSON.stringify(row) + "\n");
    if (!row.error) {
      console.log(
        `[${q.id}] ${name.padEnd(6)} ${String(row.total_ms).padStart(6)}ms  ` +
          `cites ${row.citations}/${row.retrieved.length}  ` +
          `from_context=${row.answered_from_context}  docs: ${row.documents.slice(0, 3).join(", ")}`
      );
    }
  }
}

console.log(`\nDone. Rows in ${resultsPath}.`);
console.log(`Grade by filling human_correct / human_notes, then summarise per stratum.`);
