// A/B comparison of ANSWER-model choice for Step 5 (dedup judgment), run
// BEFORE committing to the ~14h dedupBatchRunner pass.
//
// Why this exists: switching the judgment model is a one-line config change
// whose consequences only show up 14 hours later, baked into je_entities as
// merges that are painful to unpick. This harness makes the same comparison
// in ~20 minutes on real corpus data.
//
// What it deliberately does NOT test: Step 4 candidate generation. Step 5
// only ever judges what Step 4 hands it, so this isolates the judgment call
// by supplying candidate sets directly. Step 4 recall is a separate (and
// probably larger) lever -- see the notes printed at the end.
//
// Usage:
//   EXTRACTION_MODEL=qwen3:8b node --env-file=.env eval/dedupModelAB.js
//   EXTRACTION_MODEL=qwen3:30b-a3b-instruct-2507-q4_K_M node --env-file=.env eval/dedupModelAB.js
//
// Results append to eval/results/dedup_model_ab.jsonl, keyed by model, so the
// two runs can be compared afterwards without re-running either.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import jaroWinkler from "jaro-winkler";
import { Database, aql } from "arangojs";
import {
  ARANGO_URL, ARANGO_DB, ARANGO_USER, ARANGO_PASSWORD,
  EXTRACTION_MODEL, JARO_WINKLER_THRESHOLD,
} from "../src/config.js";
import { judgeCandidates } from "../src/dedupJudgment.js";
import { ensureEntitiesCollections } from "../src/entities.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "results", "dedup_model_ab.jsonl");

const db = new Database({
  url: ARANGO_URL, databaseName: ARANGO_DB,
  auth: { username: ARANGO_USER, password: ARANGO_PASSWORD },
});

// --- Gold set ---------------------------------------------------------------
//
// Hand-labelled from domain knowledge of this specific case. Deliberately
// weighted toward false-merge traps (surname collisions, near-miss given
// names) because dedupJudgment.js's own prompt states the asymmetry: "A false
// merge (treating two different real people as one) is worse than a missed
// merge." A model that scores well by merging everything is not a good model.
//
// Virginia Roberts married and became Virginia Giuffre -- so the maiden/married
// pair is genuinely the same person, while Sky Roberts (her father) and the
// unrelated Roberts/Giuffre namesakes are genuinely different people. That
// combination is exactly what makes this corpus a good discrimination test.
const GOLD = [
  // --- true merges -----------------------------------------------------
  ["Virginia Giuffre",         "Virginia Roberts",      "person", "same"],
  ["Virginia Giuffre",         "Virginia L. Giuffre",   "person", "same"],
  ["Virginia Roberts Giuffre", "Virginia Giuffre",      "person", "same"],
  ["VIRGINIA L. GIUFFRE",      "Virginia L. Giuffre",   "person", "same"],
  ["Ms. Giuffre",              "Virginia Giuffre",      "person", "same"],
  ["Ghislaine Maxwell",        "GHISLAINE MAXWELL",     "person", "same"],
  ["Ghislaine Maxwell",        "G. Maxwell",            "person", "same"],
  ["Ms. Maxwell",              "Ghislaine Maxwell",     "person", "same"],
  ["Jeffrey Epstein",          "Jeffery Epstein",       "person", "same"],
  ["Jeffrey Epstein",          "JEFFREY EDWARD EPSTEIN","person", "same"],
  ["Mr. Epstein",              "Jeffrey Epstein",       "person", "same"],

  // --- true non-merges (the expensive direction to get wrong) ----------
  ["Virginia Roberts",         "Victoria Roberts",      "person", "different"],
  ["Virginia Giuffre",         "Robert Giuffre",        "person", "different"],
  ["Virginia Roberts",         "Sky Roberts",           "person", "different"],
  ["Ms. Roberts",              "Lynn Roberts",          "person", "different"],
  ["Virginia Roberts",         "Kimberley Roberts",     "person", "different"],
  ["Ghislaine Maxwell",        "Christine Maxwell",     "person", "different"],
  ["Jeffrey Epstein",          "Mark Epstein",          "person", "different"],
];

// --- Load every mention once, with the chunk facts that go with it ----------
//
// Step 5's prompt is fed docket numbers and dates from the chunk a mention
// came from; those are real signal (two mentions in filings sharing a docket
// number are more likely the same person). Pulling them from the real
// je_raw_extractions records keeps this test honest rather than synthetic.
async function loadMentions() {
  const cursor = await db.query(aql`
    FOR d IN je_raw_extractions
      FOR e IN d.entities
        RETURN {
          name: e.name, type: e.type,
          textual_evidence: e.textual_evidence,
          chunk_id: d._key,
          docket_numbers: d.docket_numbers,
          dates: d.dates
        }
  `);
  return cursor.all();
}

// First real occurrence of a name, so every case carries genuine evidence
// text and genuine chunk facts rather than anything invented here.
function firstOccurrence(mentions, name, type) {
  return mentions.find((m) => m.name === name && m.type === type) ?? null;
}

// Mirrors how Step 4 would have surfaced this pair, because
// guardAgainstFalseMerge() in dedupJudgment.js treats the two channels
// differently: a "same" verdict on an embedding-only candidate with a weak
// name match gets downgraded to "unsure", while a Jaro-Winkler candidate is
// trusted as independently name-corroborated. Labelling the source wrongly
// here would test a code path the real run never takes.
function channelFor(nameA, nameB) {
  const score = jaroWinkler(nameA, nameB, { caseSensitive: false });
  return {
    source: score >= JARO_WINKLER_THRESHOLD ? "jaro_winkler" : "embedding",
    jw: Number(score.toFixed(3)),
  };
}

async function runCase(kase, mentions) {
  const [probeName, candName, type, expected] = kase;
  const probe = firstOccurrence(mentions, probeName, type);
  const cand = firstOccurrence(mentions, candName, type);
  if (!probe || !cand) {
    return { skipped: true, probe: probeName, candidate: candName,
             why: !probe ? "probe not in corpus" : "candidate not in corpus" };
  }

  const { source, jw } = channelFor(probeName, candName);
  const entity = { name: probe.name, type: probe.type, textual_evidence: probe.textual_evidence };
  const chunkFacts = { docket_numbers: probe.docket_numbers, dates: probe.dates };

  // entity_id is a synthetic label: judgeCandidates re-attaches it positionally
  // and never asks the model to reproduce it (see the schema comment in
  // dedupJudgment.js), so its value is irrelevant to what is being measured.
  // chunk_id is real, which is what makes getRawExtraction() supply true facts.
  const candidates = [{ entity_id: `ab_${candName.replace(/\W+/g, "_")}`,
                        name: cand.name, source, chunk_id: cand.chunk_id }];

  const started = Date.now();
  const [judgment] = await judgeCandidates(entity, chunkFacts, candidates);
  return {
    probe: probeName, candidate: candName, type, expected,
    verdict: judgment.verdict, reason: judgment.reason,
    channel: source, jw, latency_ms: Date.now() - started,
  };
}

// --- main -------------------------------------------------------------------

// Creates je_entities / je_mentioned_in / je_possible_duplicates if absent.
// Idempotent, and the real dedup run needs them anyway -- but they must exist
// before judgeCandidates runs, because enrichCandidate() queries
// je_mentioned_in and an AQL query against a missing collection throws.
await ensureEntitiesCollections();

const mentions = await loadMentions();
console.log(`model: ${EXTRACTION_MODEL}`);
console.log(`mentions loaded: ${mentions.length}`);
console.log(`gold cases: ${GOLD.length}\n`);

const results = [];
for (const kase of GOLD) {
  const r = await runCase(kase, mentions);
  if (r.skipped) {
    console.log(`  SKIP  ${r.probe} / ${r.candidate}  (${r.why})`);
    continue;
  }
  // A false merge is the one error class the pipeline cannot cheaply undo,
  // so it is called out by name rather than folded into a generic "wrong".
  const ok = r.verdict === r.expected;
  const falseMerge = r.expected === "different" && r.verdict === "same";
  const mark = falseMerge ? "FALSE-MERGE" : ok ? "ok         " : "miss       ";
  console.log(
    `  ${mark} ${String(r.latency_ms).padStart(6)}ms  exp=${r.expected.padEnd(9)} got=${r.verdict.padEnd(9)}` +
    ` jw=${r.jw} ${r.channel.padEnd(12)} ${r.probe} / ${r.candidate}`
  );
  if (!ok) console.log(`              reason: ${r.reason}`);
  results.push({ model: EXTRACTION_MODEL, ...r, correct: ok, false_merge: falseMerge,
                 run_at: new Date().toISOString() });
}

// --- summary ----------------------------------------------------------------
const same = results.filter((r) => r.expected === "same");
const diff = results.filter((r) => r.expected === "different");
const falseMerges = results.filter((r) => r.false_merge);
const missedMerges = same.filter((r) => r.verdict !== "same");
const unsure = results.filter((r) => r.verdict === "unsure");
const median = (xs) => xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0;

console.log(`\n--- ${EXTRACTION_MODEL} ---`);
console.log(`  correct overall : ${results.filter((r) => r.correct).length}/${results.length}`);
console.log(`  true merges     : ${same.filter((r) => r.correct).length}/${same.length} caught`);
console.log(`  true non-merges : ${diff.filter((r) => r.correct).length}/${diff.length} held apart`);
console.log(`  FALSE MERGES    : ${falseMerges.length}   <-- the expensive error`);
console.log(`  missed merges   : ${missedMerges.length}   (recoverable by Step 7 coref)`);
console.log(`  unsure          : ${unsure.length}`);
console.log(`  median latency  : ${median(results.map((r) => r.latency_ms))}ms`);
if (falseMerges.length) {
  console.log(`\n  false merges in detail:`);
  for (const f of falseMerges) console.log(`    ${f.probe} <- ${f.candidate}: ${f.reason}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.appendFileSync(OUT, results.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nappended ${results.length} row(s) to ${OUT}`);
