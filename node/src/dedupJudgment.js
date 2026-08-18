// Step 5: LLM judgment #2 -- given a new mention and the short candidate
// list Step 4 found, decide per candidate whether it's the same real-world
// entity, a different one, or genuinely unsure. Only ever called when Step
// 4 returned at least one candidate. "Unsure" is reserved for genuine
// ambiguity (two plausible candidates, not enough to tell apart) -- a
// candidate that's clearly wrong once the facts are laid out should come
// back "different", not "unsure"; routinely landing on "unsure" for
// obviously-wrong candidates would be a sign this prompt needs tightening,
// not a gap this step is designed to paper over.

import jaroWinkler from "jaro-winkler";
import { OLLAMA_URL, EXTRACTION_MODEL } from "./config.js";
import { getEntity, getMentionedInEdge } from "./entities.js";
import { getRawExtraction } from "./rawExtractions.js";
import { looksGeneric } from "./nameUtils.js";

// No entity_id in the schema -- deliberately. An early real-data test
// caught the model echoing back a mangled ID (":65839", a stray leading
// colon picked up from the prompt's own "- entity_id: X" formatting), which
// produced an invalid ArangoDB edge reference. Same category of mistake as
// this project's "Judge LAP" hallucination in Step 3: never trust an LLM to
// reproduce an exact token verbatim when the alternative (positional
// correspondence -- judgment N always means candidate N) avoids needing it
// to at all. Candidates are numbered in the prompt; judgments must come
// back in that same order, and the real entity_id is re-attached in code
// from our own candidates array, never from model output.
// Built per call with minItems/maxItems pinned to the exact candidate count
// -- a real test run showed that without this, schema-constrained decoding
// still happily generates more (or fewer) array items than candidates
// given (e.g. 2 judgments for 1 candidate), since a bare `type: "array"` of
// a given item shape places no limit on how many items satisfy it. Pinning
// the count turns "the model must answer once per candidate" from a prompt
// instruction (which it silently ignored) into a structural constraint on
// the generated JSON itself.
function buildJudgmentSchema(candidateCount) {
  return {
    type: "object",
    properties: {
      judgments: {
        type: "array",
        minItems: candidateCount,
        maxItems: candidateCount,
        items: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["same", "different", "unsure"] },
            reason: { type: "string" },
          },
          required: ["verdict", "reason"],
        },
      },
    },
    required: ["judgments"],
  };
}

const SYSTEM_PROMPT = `You judge whether a newly-mentioned entity in a US federal court filing is the same \
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

// Real-data test caught a genuine reasoning failure, not a data gap: the
// model judged "N atalya Malyshov" and "Virginia Roberts" as "same name"
// (they aren't) when both appeared in the same dense discovery-request
// sentence listing six different people -- their context snippets overlap
// almost entirely (same list, same surrounding words) even though they're
// clearly different real people. Prompt wording alone didn't prevent this,
// so this is a deterministic backstop, same "never trust the LLM alone on
// something a cheap check can verify" lesson as the entity_id fix above.
//
// looksGeneric (shared with dedupCandidates.js's prefilter, see
// nameUtils.js) tells "defense counsel" apart from a real name -- that's the
// legitimate case the embedding channel exists for (Christine Walz / Ms.
// Walz's later "defense counsel" mention), and low string similarity there
// is expected, not a red flag. When BOTH names look like real, specific,
// different names -- not one real name plus one generic placeholder -- a
// "same" verdict resting only on embedding similarity (no Jaro-Winkler
// support at all) is exactly the shape of the observed failure, so it gets
// downgraded to "unsure" instead of trusted.
function guardAgainstFalseMerge(entity, candidate, judgment) {
  if (judgment.verdict !== "same") return judgment;
  if (candidate.source === "jaro_winkler") return judgment; // name similarity independently supports this
  if (looksGeneric(entity.name) || looksGeneric(candidate.name)) return judgment; // legitimate role-phrase case

  const nameSimilarity = jaroWinkler(entity.name, candidate.name ?? "");
  if (nameSimilarity < 0.6) {
    return { ...judgment, verdict: "unsure", reason: `Downgraded from "same": two distinct-looking names ("${entity.name}" / "${candidate.name}") with only embedding support, no name-level corroboration` };
  }
  return judgment;
}

function formatCandidateFacts(index, candidate, role, rawExtraction) {
  const lines = [`${index + 1}. name: ${candidate.name ?? "(unknown)"}`];
  if (candidate.snippet) lines.push(`   matched context: "${candidate.snippet}"`);
  if (role) lines.push(`   role in that mention: ${role.role}`, `   textual evidence: "${role.textual_evidence}"`);
  if (rawExtraction) {
    lines.push(`   docket numbers in that chunk: ${JSON.stringify(rawExtraction.docket_numbers)}`);
    lines.push(`   dates in that chunk: ${JSON.stringify(rawExtraction.dates)}`);
  }
  return lines.join("\n");
}

// Fills in whatever facts are available for one candidate. Candidates from
// the Jaro-Winkler channel only ever get a name (no specific chunk_id to
// trace back to a mention). Candidates from the embedding channel carry a
// chunk_id, so their role and chunk-level facts (docket/dates) get pulled
// in too -- for the *specific* matched mention, not the candidate's whole
// history (see dedupCandidates.js).
async function enrichCandidate(candidate) {
  const [entity, role, rawExtraction] = await Promise.all([
    candidate.name ? null : getEntity(candidate.entity_id),
    candidate.chunk_id ? getMentionedInEdge(candidate.entity_id, candidate.chunk_id) : null,
    candidate.chunk_id ? getRawExtraction(candidate.chunk_id) : null,
  ]);
  return {
    ...candidate,
    name: candidate.name ?? entity?.name,
    role,
    rawExtraction,
  };
}

async function callOllamaChat(userContent, candidateCount) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      stream: false,
      think: false,
      format: buildJudgmentSchema(candidateCount),
      options: { num_predict: 1000 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama /api/chat returned HTTP ${response.status}: ${await response.text()}`);
  }

  const body = await response.json();
  return body.message.content;
}

// entity: the new mention from je_raw_extractions.entities[i].
// chunkFacts: { docket_numbers, dates } from the *current* chunk's
// je_raw_extractions record -- already in hand from the batch runner's
// outer loop, no extra lookup needed.
// candidates: Step 4's output (findCandidates), non-empty (callers should
// not invoke this when Step 4 found nothing).
export async function judgeCandidates(entity, chunkFacts, candidates) {
  const enriched = await Promise.all(candidates.map(enrichCandidate));

  const userContent = `New mention:
  name: ${entity.name}
  type: ${entity.type}
  textual evidence: "${entity.textual_evidence}"
  docket numbers in this chunk: ${JSON.stringify(chunkFacts.docket_numbers)}
  dates in this chunk: ${JSON.stringify(chunkFacts.dates)}

Candidates:
${enriched.map((c, i) => formatCandidateFacts(i, c, c.role, c.rawExtraction)).join("\n")}`;

  const content = await callOllamaChat(userContent, candidates.length);
  const parsed = JSON.parse(content);

  // Positional correspondence, not model-echoed IDs -- see the schema
  // comment above. A length mismatch means the model didn't follow the
  // one-judgment-per-candidate instruction; treated as a real failure
  // (surfaces in the batch runner's failure log for that entity) rather
  // than guessed at, since silently zipping mismatched arrays could
  // misattribute a "same" verdict to the wrong candidate -- exactly the
  // false-merge risk this whole design exists to avoid.
  if (parsed.judgments.length !== candidates.length) {
    throw new Error(
      `Judgment count mismatch: got ${parsed.judgments.length} judgments for ${candidates.length} candidates`
    );
  }

  return parsed.judgments.map((j, i) => guardAgainstFalseMerge(entity, enriched[i], { ...j, entity_id: candidates[i].entity_id }));
}
