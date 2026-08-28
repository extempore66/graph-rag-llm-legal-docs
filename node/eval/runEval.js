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
//   node --env-file=.env eval/runEval.js --two-phase       measure the path the server actually runs
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
import { generateAnswer, judgeSufficiencyIndependent, streamAnswer } from "../src/retrieval/answerGenerator.js";
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

// Which answer path to measure.
//
// generateAnswer is the ORIGINAL single call: one model, one pass, judging
// sufficiency and writing the answer together. Every row already in runs.jsonl
// was measured against it, which is why it is still here and still the default
// -- changing what the default measures would silently invalidate the history.
//
// --two-phase measures what the server has actually run since 2026-08-27:
// judge each retrieved passage on its own (one call per passage, each call
// seeing exactly one passage), and only write an answer if at least one
// passage helped. That split is the fix for the false refusal on "Who were the
// defense attorneys in this case?" -- see judgeSufficiencyIndependent's header
// comment for the measurement that motivated it.
//
// The two are different measurements of different code, so they get different
// config keys and never collide in the results file.
const twoPhase = process.argv.includes("--two-phase");

/**
 * The server's answer path, wrapped to return generateAnswer's shape so every
 * downstream field in the result row means the same thing under both modes.
 *
 * The one genuinely new field is `refused`: phase 1 said no passage bore on
 * the question, so phase 2 never ran and no answer was written. Under the
 * single-call path that outcome is only visible as answered_from_context =
 * false on an answer that was written anyway -- which is precisely the
 * conflict of interest the split removes.
 */
async function answerTwoPhase(question, chunks) {
  const started = Date.now();
  if (chunks.length === 0) {
    return {
      answer: "No context was retrieved for this question.",
      answered_from_context: false, citations: [], invalid_citations: 0,
      truncated: false, refused: true, judge_ms: 0, latency_ms: 0,
    };
  }

  const verdict = await judgeSufficiencyIndependent(question, chunks);
  if (!verdict.sufficient) {
    return {
      answer: verdict.missing,
      answered_from_context: false,
      citations: verdict.citations,
      invalid_citations: verdict.invalid_citations,
      truncated: false,
      refused: true,
      judge_ms: verdict.latency_ms,
      latency_ms: Date.now() - started,
    };
  }

  // streamAnswer is the same function the browser drives; the deltas are
  // discarded here because only the assembled text is being recorded.
  const written = await streamAnswer(question, chunks, () => {});
  return {
    answer: written.answer,
    answered_from_context: true,
    // Citations come from phase 1. Phase 2 writes prose and is never asked
    // which sources it used, so there is nothing to reconcile between them.
    citations: verdict.citations,
    invalid_citations: verdict.invalid_citations,
    truncated: written.truncated,
    refused: false,
    judge_ms: verdict.latency_ms,
    latency_ms: Date.now() - started,
  };
}

const answerWith = twoPhase ? answerTwoPhase : generateAnswer;

const resultsDir = path.join(__dirname, "results");
fs.mkdirSync(resultsDir, { recursive: true });
const resultsPath = path.join(resultsDir, "runs.jsonl");

// Resume: everything already recorded for this exact configuration.
// Configuration is part of the key because the same question under a different
// ANSWER_MODEL or a different prefix setting is a different measurement, not a
// duplicate -- that is precisely how the A/B comparisons get run.
const configKey = `${ANSWER_MODEL}|k=${RETRIEVAL_TOP_K}|prefix=${BGE_QUERY_PREFIX ? "on" : "off"}|expand=${USE_QUERY_EXPANSION}${twoPhase ? "|answer=two-phase" : ""}`;
const done = new Set();
if (fs.existsSync(resultsPath)) {
  for (const line of fs.readFileSync(resultsPath, "utf8").split("\n").filter(Boolean)) {
    const r = JSON.parse(line);
    done.add(`${r.config}|${r.strategy}|${r.id}`);
  }
}

console.log(`config: ${configKey}`);
console.log(`answer path: ${twoPhase ? "two-phase (judge each passage, then write) -- what the server runs" : "single call (original) -- what runs.jsonl history was measured against"}`);
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
      const answer = await answerWith(q.question, chunks);
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
        // --two-phase only. Null under the single-call path, where "refused"
        // is not an outcome the code can produce.
        refused: answer.refused ?? null,
        judge_ms: answer.judge_ms ?? null,
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
          `${twoPhase ? (row.refused ? "REFUSED" : "answered") : `from_context=${row.answered_from_context}`}  docs: ${row.documents.slice(0, 3).join(", ")}`
      );
    }
  }
}

console.log(`\nDone. Rows in ${resultsPath}.`);
console.log(`Grade by filling human_correct / human_notes, then summarise per stratum.`);
