// Step 3, E.2: the real, permanent implementation of the extraction design
// proven in E.1's scratch testing (see _project_step_by_step_plan.md's E.1
// build log entry for the full story of what was tried and why it changed).
// Two extraction paths, run together per chunk:
//
//  1. Deterministic (no LLM): docket/case numbers and dates follow fixed,
//     regular patterns, so a regex pulls them out with zero hallucination
//     risk. E.1 caught the LLM inventing a fake person ("Judge LAP") by
//     *interpreting* a docket number's judge-initials suffix instead of a
//     regex just *matching* it -- that failure mode is structurally
//     impossible here, since regex can only match what's literally there.
//  2. LLM (qwen3:8b, think disabled, JSON-schema-constrained output): judges
//     the genuinely ambiguous part -- which people/organizations/courts are
//     real participants in this case vs. noise (citations to unrelated
//     lawsuits, references to this case's own exhibits/depositions). Kept
//     deliberately narrow -- E.1 showed an 8B model asked to judge too much
//     at once (exact type + exact role + citation-noise filtering + dates +
//     docket numbers + relations, all in one call) starts guessing instead
//     of abstaining.

import { OLLAMA_URL, EXTRACTION_MODEL } from "./config.js";

// --- Deterministic pre-pass -------------------------------------------

// Federal docket numbers follow a fixed, regular pattern -- no LLM judgment
// needed. Handles both forms seen in the real corpus:
//   "1:15-cv-07433-LAP"        (district-prefixed, in-body citation form)
//   "CASE NO. 15-CV-07433-RWS" (caption-page form, no district-digit prefix)
const DOCKET_PATTERN = /\b(?:\d{1,2}:)?\d{2}-(?:cv|cr|md|mc)-\d{4,6}(?:-[A-Z]{2,4})?\b/gi;

// Common date formats seen in filings: "01/05/24", "January 5, 2024", "Jan. 5, 2024".
const DATE_PATTERN =
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b(?:Jan\.?|Feb\.?|Mar\.?|Apr\.?|May|Jun\.?|Jul\.?|Aug\.?|Sep\.?|Sept\.?|Oct\.?|Nov\.?|Dec\.?|January|February|March|April|June|July|August|September|October|November|December)\s+\d{1,2},?\s+\d{4}\b/g;

// Anything an entity's name or textual_evidence contains that signals it's
// a citation/reference rather than a real participant -- checked
// independently of what type the LLM assigned, since E.1 showed the model's
// own "reference" tagging isn't 100% self-consistent across runs.
// The last two alternatives were added 2026-08-20: the full-corpus audit found
// "Case 1:15-cv-07433-LAP" living as a *court* node with 71 mentions and the
// Bates stamp "GIUFFRE000046" as a *person* with 14. Both are paperwork
// identifiers wearing a party's name, and both slipped past the prompt -- which
// is exactly why this regex exists as an independent second layer rather than
// trusting the model's own "reference" tagging.
const REFERENCE_SIGNAL_PATTERN =
  /\bv\.\s|\bWL\s+\d|\bF\.\s?(2d|3d|Supp)|\bDep\.\s?Tr\.|\bDecl\.|\bExhibit\b|\bDE\s+\d|\bDocument\s+\d|\bCase\s+\d+:\d+-[a-z]{2}-|[A-Z]{3,}\d{4,}/i;

function extractDeterministic(chunkText) {
  return {
    docket_numbers: [...new Set([...chunkText.matchAll(DOCKET_PATTERN)].map((m) => m[0]))],
    dates: [...new Set([...chunkText.matchAll(DATE_PATTERN)].map((m) => m[0]))],
  };
}

// --- LLM pass ------------------------------------------------------------

const ENTITY_SCHEMA = {
  type: "object",
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          // "location" and "facility" added 2026-08-20 after a full-corpus
          // audit. With only person/organization/court available, every place
          // was forced into a wrong box: "State of Florida" (17 mentions),
          // "New York" (14), "Palm Beach County" (9) all landed as *court*,
          // because courts are named after jurisdictions; street addresses and
          // even "2004 black Chevy Suburban" landed as *organization*. Worse,
          // 68 names ended up carrying two or three different types across
          // chunks, and since type is a hard partition in every downstream
          // step (getEntitiesByType, searchSimilarMentions, buildClusters),
          // those names can never be merged by any pass. The enum is a lens:
          // what it does not name, it distorts.
          //
          // GPE and LOC are deliberately merged into one "location" rather
          // than split OntoNotes-style. The political-actor-vs-geography
          // distinction almost never changes an answer for this corpus, and
          // every extra box is another chance the model picks a different one
          // for the same name in a different chunk -- which is the exact
          // failure being fixed here.
          type: {
            type: "string",
            enum: ["person", "organization", "court", "location", "facility", "reference"],
          },
          candidate_role: {
            type: "string",
            enum: ["plaintiff", "defendant", "counsel", "judge", "witness", "non_party", "other", "none"],
          },
          textual_evidence: { type: "string" },
          confidence: { type: "string", enum: ["explicit", "resolved_from_context"] },
        },
        required: ["name", "type", "candidate_role", "textual_evidence", "confidence"],
      },
    },
  },
  required: ["entities"],
};

const SYSTEM_PROMPT = `You extract entities from a single chunk of a US federal court filing for a knowledge graph. \
Extract only people, organizations, courts, locations and facilities that are actual participants or \
facts of THIS case. Do NOT extract dates or docket/case numbers -- those are handled separately by \
code, not you.

Type definitions, in the order you should check them:
- "court": a judicial body that hears cases ("Southern District of New York", "New York Court of \
Appeals"). A court is an institution, NOT the place it is named after.
- "location": a geographic or political place -- a state, county, city, country, island or region \
("Florida", "New York", "Palm Beach County", "United States Virgin Islands"). If a name is a place \
that a court happens to be named after, it is a "location", not a "court".
- "facility": a building, property, premises, named residence, school building, airport, or a \
street address ("Palm Beach mansion", "Northcliffe House", "280 Sunset Avenue Palm Beach, FL 33480").
- "organization": a company, agency, department, firm, publication, university or other body of \
people ("Palm Beach Police Department", "The New York Times", "University of Utah"). A police \
department is an organization, not a location and not a court.
- "person": an individual human being.

A generic party or role phrase used in place of a name -- "Defendant", "Plaintiff", "defense \
counsel" -- refers to an individual human being in this case and must ALWAYS be typed "person", \
never "organization". ("the Court" is an exception: that one denotes the institution, type it \
"court".)

Use type "reference" for anything that is a citation to a DIFFERENT lawsuit, or a citation/pointer \
to another document, exhibit, deposition transcript, or declaration filed in this case (e.g. \
"McCawley Decl. at Exhibit 4", "Alessi Dep. Tr. at 223:5", "DE 338", "Document 1328-31"). \
Also use "reference" for a case caption or number ("Case 1:15-cv-07433-LAP") and for a document \
production identifier or Bates stamp ("GIUFFRE000046") -- these identify paperwork, never a person \
or a court, no matter whose name they contain. Entries typed "reference" are discarded \
automatically -- when in doubt between a real entity type and "reference", prefer "reference".

For candidate_role: only set it to something other than "none" when the role word appears \
DIRECTLY adjacent to the name in the text itself (e.g. "JOHN SMITH, Defendant" or "Plaintiff Jane \
Doe"). Never infer a role from context, prior knowledge of the case, or a docket number's judge-\
initials suffix -- if the role isn't spelled out right next to the name, use "none". It is always \
better to under-assign a role than to guess.

For each real entity give: name (as it appears), type, candidate_role, textual_evidence (a SHORT \
phrase, 5 words or fewer, that justifies the extraction -- not a full sentence), and confidence \
("explicit" if unambiguous, "resolved_from_context" if inferred, e.g. from a pronoun). If nothing \
qualifies, return an empty array.`;

// A real few-shot example built from this corpus's own citations -- E.1
// found prompt instructions alone weren't reliable for the reference-type
// distinction, but a concrete worked example the model can pattern-match
// against was.
const FEW_SHOT_USER = `Furthermore, Ms. Giuffre's correspondence... See also Southern District of New York Local Civil \
Rule 26.2(c); Am. Broad. Companies, Inc. v. Aereo, Inc., 2013 WL 139560, at *2 (S.D.N.Y. Jan. 11, \
2013); United States v. Bouchard Transp., 2010 WL 1529248 (E.D.N.Y. Apr. 14, 2010). See McCawley \
Decl. at Exhibit 4; Alessi Dep. Tr. at 223:5-225:17; DE 338.`;

const FEW_SHOT_ASSISTANT = JSON.stringify({
  entities: [
    { name: "Ms. Giuffre", type: "person", candidate_role: "none", textual_evidence: "Ms. Giuffre's correspondence", confidence: "explicit" },
    { name: "Southern District of New York", type: "court", candidate_role: "none", textual_evidence: "Southern District of New York Local Civil Rule", confidence: "explicit" },
    { name: "Am. Broad. Companies, Inc. v. Aereo, Inc.", type: "reference", candidate_role: "none", textual_evidence: "citation to unrelated case", confidence: "explicit" },
    { name: "United States v. Bouchard Transp.", type: "reference", candidate_role: "none", textual_evidence: "citation to unrelated case", confidence: "explicit" },
    { name: "McCawley Decl. at Exhibit 4", type: "reference", candidate_role: "none", textual_evidence: "citation to a declaration/exhibit", confidence: "explicit" },
    { name: "Alessi Dep. Tr. at 223:5-225:17", type: "reference", candidate_role: "none", textual_evidence: "citation to a deposition transcript", confidence: "explicit" },
    { name: "DE 338", type: "reference", candidate_role: "none", textual_evidence: "docket entry citation", confidence: "explicit" },
  ],
});

// Drops entities typed "reference" and anything matching the citation/
// reference signal pattern in either its name or its own textual_evidence,
// regardless of the type the model assigned -- see the module comment for
// why this two-layer approach (schema type + independent regex) is needed.
function filterNoiseEntities(entities) {
  return entities.filter((e) => e.type !== "reference" && !REFERENCE_SIGNAL_PATTERN.test(e.name) && !REFERENCE_SIGNAL_PATTERN.test(e.textual_evidence));
}

// A bare party/role phrase stands in for an individual human being, so it must
// be typed "person" -- otherwise "Defendant" splits across person and
// organization nodes that can never merge, since those two types sit in
// different comparable-type groups. The full-corpus audit found 280
// organization + 38 person mentions of "Defendant" and 99 + 88 of "Plaintiff".
//
// The prompt already says this explicitly, and the model still doesn't comply:
// the 200-chunk trial with the instruction in place returned "Defendant" as
// organization 26 times and person only 14. Third time in this project that a
// prompt instruction alone proved unreliable (see the entity-ID echoing fix in
// dedupJudgment.js and the "reference" regex above), and the same answer
// applies -- verify deterministically what a cheap check can verify.
//
// Matched on the WHOLE name, never as a substring. "Defendant Maxwell" is a
// named person and is left alone; only a name that is nothing but a role
// phrase is rewritten. "the court"/"this court" are deliberately absent: those
// genuinely denote the institution, and the model's insistence on typing them
// "court" is defensible.
const ROLE_PHRASES = new Set([
  "defendant", "defendants", "the defendant", "the defendants",
  "plaintiff", "plaintiffs", "the plaintiff", "the plaintiffs",
  "counsel", "defense counsel", "opposing counsel",
  "plaintiff's counsel", "defendant's counsel",
  "witness", "the witness", "petitioner", "respondent", "movant", "deponent",
]);

export function normalizeRolePhraseTypes(entities) {
  return entities.map((e) => {
    const bare = e.name.trim().toLowerCase().replace(/[.,;:]+$/, "").replace(/\s+/g, " ");
    return ROLE_PHRASES.has(bare) && e.type !== "person" ? { ...e, type: "person" } : e;
  });
}

async function callOllamaChat(chunkText, numPredict) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      stream: false,
      think: false, // E.1: without this, qwen3 wraps every response in an invisible <think> block -- 30x slower for no benefit here
      format: ENTITY_SCHEMA,
      options: { num_predict: numPredict },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: FEW_SHOT_USER },
        { role: "assistant", content: FEW_SHOT_ASSISTANT },
        { role: "user", content: chunkText },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama /api/chat returned HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  return body.message.content;
}

// num_predict budgets to try, in order. Schema-constrained decoding
// guarantees syntactically valid JSON *as long as generation completes* --
// so a JSON.parse failure here is an almost-certain signal of truncation
// (num_predict hit mid-object), not some other kind of malformed output.
// E.1 found 1500 held every real chunk tested, but that was empirical, not
// guaranteed -- an unusually entity-dense chunk (a long multi-party
// caption page, say) could still exceed it. Rather than let that chunk
// fail outright and need a manual re-run, retry once with a much higher
// ceiling before giving up for real.
const NUM_PREDICT_ATTEMPTS = [1500, 3000];

async function extractEntitiesLLM(chunkText) {
  let lastError;
  for (const numPredict of NUM_PREDICT_ATTEMPTS) {
    const content = await callOllamaChat(chunkText, numPredict);
    try {
      const parsed = JSON.parse(content);
      return normalizeRolePhraseTypes(filterNoiseEntities(parsed.entities));
    } catch (err) {
      lastError = new Error(`Model output was not valid JSON at num_predict=${numPredict} (likely truncated): ${err.message}\nRaw content: ${content}`);
    }
  }
  throw lastError;
}

// --- Combined entry point -------------------------------------------------

// Runs both extraction paths for one chunk and returns their combined
// result. Deterministic fields and LLM-judged entities are kept as separate
// top-level keys rather than merged into one list -- they have different
// provenance (pattern-matched fact vs. model judgment) and callers may want
// to treat them differently (e.g. dates/docket numbers need no Step 4/5
// dedup treatment at all, unlike entities).
export async function extractChunkEntities(chunkText) {
  const deterministic = extractDeterministic(chunkText);
  const entities = await extractEntitiesLLM(chunkText);
  return { ...deterministic, entities };
}
