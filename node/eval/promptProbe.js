// Tests a candidate amendment to dedupJudgment.js's SYSTEM_PROMPT WITHOUT
// modifying it, by replicating the same call shape with each prompt variant.
//
// Hypothesis: both models read "different docket/date" as evidence of
// "different entity". The prompt states that MATCHING dockets support "same"
// but never states that DIFFERING ones are not evidence of "different" -- and
// in a corpus spanning many filings over years, the same person appears under
// different dockets constantly.
//
// The fix must be checked in BOTH directions: it has to recover the missed
// merges WITHOUT loosening the traps into false merges.
import { Database, aql } from "arangojs";
import { OLLAMA_URL, ARANGO_URL, ARANGO_DB, ARANGO_USER, ARANGO_PASSWORD, EXTRACTION_MODEL }
  from "../src/config.js";
import { getRawExtraction } from "../src/rawExtractions.js";

const BASE = `You judge whether a newly-mentioned entity in a US federal court filing is the same \
real-world person/organization/court as one or more existing candidates already known from other \
parts of the case, a genuinely different entity, or truly unsure.

You will be given the new mention (its name, type, the textual evidence that justified extracting \
it, and facts about the chunk it came from) and a numbered list of candidates (each with a name and, \
where available, the role and chunk-level facts tied to the specific past mention that matched).

For each candidate, decide:
- "same" if the facts support this being the same real entity (matching case number, matching role, \
consistent context), even if the name string itself differs (e.g. a bare role-phrase like "defense \
counsel" can be the same person as an explicitly-named attorney mentioned elsewhere).
- "different" if the facts clearly point to a different entity, even if the name strings are \
similar or identical -- two different people can share a generic role-phrase as a placeholder name.
- "unsure" ONLY if the available facts are genuinely insufficient to tell -- not merely because a \
candidate turned out to be unrelated. A confidently-wrong candidate should be judged "different", \
not "unsure".

Give a short (<=10 word) reason per judgment. A false merge (treating two different real people as \
one) is worse than a missed merge, so do not guess "same" without real supporting evidence.

Return exactly one judgment per candidate, in a "judgments" array in the SAME ORDER the candidates \
are numbered below -- judgment 1 is about candidate 1, judgment 2 about candidate 2, and so on. Do \
not include any ID in your answer, only "verdict" and "reason".`;

// The amendment under test. Deliberately narrow: it constrains how docket/date
// evidence may be used, and says nothing else, so any change in trap behaviour
// is attributable to this and nothing else.
const AMENDMENT = `

IMPORTANT -- how to weigh docket numbers and dates. This corpus spans many separate filings across \
multiple dockets and several years, and the same person appears throughout them. A SHARED docket \
number or date is mild supporting evidence for "same". A DIFFERENT docket number or date is NOT \
evidence of "different" and must never be your reason for judging "different" -- filings about the \
same person routinely carry different dockets and dates. Judge "different" only on genuinely \
CONTRADICTORY facts: incompatible roles, clearly different given names or initials, or text that \
explicitly distinguishes the two. If the names are identical apart from capitalization, spacing or \
punctuation, they are the same entity.`;

const schema = (n) => ({
  type: "object",
  properties: { judgments: { type: "array", minItems: n, maxItems: n,
    items: { type: "object",
      properties: { verdict: { type: "string", enum: ["same", "different", "unsure"] },
                    reason: { type: "string" } },
      required: ["verdict", "reason"] } } },
  required: ["judgments"],
});

const db = new Database({ url: ARANGO_URL, databaseName: ARANGO_DB,
  auth: { username: ARANGO_USER, password: ARANGO_PASSWORD } });

// Same-string-modulo-formatting and true-merge cases (expect "same"),
// then the surname-collision traps (expect "different").
const CASES = [
  ["Jeffrey Epstein", "JEFFREY EPSTEIN", "same"],
  ["Virginia Giuffre", "VIRGINIA GIUFFRE", "same"],
  ["Ms. Maxwell", "MS. MAXWELL", "same"],
  ["Epstein", "EPSTEIN", "same"],
  ["Virginia Giuffre", "Virginia L. Giuffre", "same"],
  ["Ghislaine Maxwell", "GHISLAINE MAXWELL", "same"],
  ["Ghislaine Maxwell", "G. Maxwell", "same"],
  ["Ms. Maxwell", "Ghislaine Maxwell", "same"],
  ["Ms. Giuffre", "Virginia Giuffre", "same"],
  ["Virginia Giuffre", "Virginia Roberts", "same"],
  ["Virginia Roberts", "Victoria Roberts", "different"],
  ["Virginia Giuffre", "Robert Giuffre", "different"],
  ["Virginia Roberts", "Sky Roberts", "different"],
  ["Ms. Roberts", "Lynn Roberts", "different"],
  ["Virginia Roberts", "Kimberley Roberts", "different"],
];

const cur = await db.query(aql`
  FOR d IN je_raw_extractions FOR e IN d.entities FILTER e.type == "person"
    RETURN { name: e.name, textual_evidence: e.textual_evidence, chunk_id: d._key,
             docket_numbers: d.docket_numbers, dates: d.dates }`);
const mentions = await cur.all();
const find = (n) => mentions.find((m) => m.name === n) ?? null;

async function judge(systemPrompt, probe, cand) {
  const raw = await getRawExtraction(cand.chunk_id);
  const userContent = `New mention:
  name: ${probe.name}
  type: person
  textual evidence: "${probe.textual_evidence}"
  docket numbers in this chunk: ${JSON.stringify(probe.docket_numbers)}
  dates in this chunk: ${JSON.stringify(probe.dates)}

Candidates:
1. name: ${cand.name}
   docket numbers in that chunk: ${JSON.stringify(raw?.docket_numbers)}
   dates in that chunk: ${JSON.stringify(raw?.dates)}`;
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EXTRACTION_MODEL, stream: false, think: false,
      format: schema(1), options: { num_predict: 1000 },
      messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }] }),
  });
  return JSON.parse((await res.json()).message.content).judgments[0];
}

console.log(`model: ${EXTRACTION_MODEL}`);
for (const [label, prompt] of [["BASE   ", BASE], ["AMENDED", BASE + AMENDMENT]]) {
  let ok = 0, n = 0, falseMerge = 0;
  const fails = [];
  for (const [a, b, expected] of CASES) {
    const pa = find(a), pb = find(b);
    if (!pa || !pb) continue;
    const j = await judge(prompt, pa, pb);
    n++;
    if (j.verdict === expected) ok++;
    else {
      fails.push(`${a} / ${b}: expected ${expected}, got ${j.verdict} -- ${j.reason}`);
      if (expected === "different" && j.verdict === "same") falseMerge++;
    }
  }
  console.log(`  ${label}  ${ok}/${n} correct   false merges: ${falseMerge}`);
  for (const f of fails) console.log(`            ${f}`);
}
