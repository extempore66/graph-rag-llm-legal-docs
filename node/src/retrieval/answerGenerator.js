// Shared answer generation for every retrieval strategy -- the naive vector
// baseline, the graph retriever (Step 8), and anything compared against them
// later.
//
// This module exists to make the comparison *structurally* fair rather than
// fair-by-promise. Naive RAG and Graph RAG differ only in how they choose
// which chunks to put in front of the model; if each owned its own prompt,
// model settings and output parsing, a measured difference could just as
// easily be prompt luck as retrieval quality. Routing both through one
// generator means the only variable left is the retrieved context itself.
//
// Same principle already used in dedupJudgment.js, where pinning the schema's
// minItems/maxItems turned "answer once per candidate" from an instruction the
// model ignored into something it structurally could not violate. A constraint
// you cannot accidentally break beats one you have to remember.

import { OLLAMA_URL, ANSWER_MODEL, ANSWER_MAX_TOKENS, ANSWER_NUM_CTX } from "../config.js";

// Sources are numbered [1]..[n] in the prompt and cited back by number, never
// by chunk_id. This is the same lesson Step 5 learned the hard way: asked to
// echo an exact identifier, the model returned ":65839" -- a real ID with a
// stray colon picked up from the prompt's own formatting -- which produced an
// invalid database reference. A chunk_id here is far worse bait, being long,
// dotted and numeric ("gov.uscourts.nysd.447706.1327.11_31"). Positional
// correspondence removes the failure mode entirely: the model emits small
// integers, and the real chunk_id is re-attached in code from our own array.
const SYSTEM_PROMPT = `You answer questions about a corpus of US federal court filings, using ONLY the \
numbered source passages provided. The passages are extracted from PDFs, so they may contain OCR \
noise, odd line breaks and interleaved page furniture -- read through that.

Work in this order, and answer the fields in the order they are requested:

STEP 1 -- "source_relevance": one entry per source, IN ORDER, judging each one independently. Set \
"relevant" true only if that specific passage bears on the question, with a <=10 word "why". \
Retrieval returns a fixed number of passages whether or not the corpus contains an answer, so \
usually MOST are irrelevant -- judging most of them false is the normal, correct outcome, and \
marking an unrelated passage relevant is an error.

STEP 2 -- "answered_from_context": true only if the passages you marked relevant actually contain \
enough to answer. If you marked none relevant, this MUST be false.

STEP 3 -- "answer": if answered_from_context is true, answer from those sources -- specific names, \
dates and docket numbers over vague summary. If it is false, say plainly that these documents do not \
contain the answer, and say in one line what they contain instead. Do NOT summarise the passages as \
a substitute for answering: an accurate description of irrelevant documents is still a failure to \
answer the question.

Use ONLY the sources. Do not use outside knowledge about any person, case or event, even if you are \
confident it is true. Do not put source numbers inside the answer text; they belong in \
source_relevance.`;

// answered_from_context is asked for explicitly rather than inferred from the
// answer's wording, because "did the retrieval supply what was needed" is the
// single most useful signal when comparing two retrieval strategies -- far more
// diagnostic than answer prose, and countable without a human judge.
// One verdict per source, with the array length PINNED to the source count --
// the same fix dedupJudgment.js needed, for the same reason.
//
// Three versions of this failed before landing here. Asking for "cited_sources"
// produced 8 of 8 every time. Reordering the schema so relevance was declared
// before the answer produced 8 of 8 every time. Both qwen3:8b and
// deepseek-r1:14b behaved identically, so it was never a capability ceiling.
//
// The difference is that "list the sources you used" is one open-ended choice
// where including everything is the safe move, while minItems/maxItems forces N
// separate yes/no decisions that each have to be justified in a `why` field. A
// model can shrug off an instruction; it cannot generate 8 array entries that
// the grammar requires without actually considering 8 sources.
//
// Same lesson as the entity_id fix in Step 5: never rely on an instruction when
// the schema can make compliance structural.
function buildAnswerSchema(sourceCount) {
  return {
    type: "object",
    properties: {
      source_relevance: {
        type: "array",
        minItems: sourceCount,
        maxItems: sourceCount,
        items: {
          type: "object",
          properties: {
            relevant: { type: "boolean" },
            why: { type: "string" },
          },
          required: ["relevant", "why"],
        },
      },
      answered_from_context: { type: "boolean" },
      answer: { type: "string" },
    },
    required: ["source_relevance", "answered_from_context", "answer"],
  };
}

// Chunks arrive with their provenance already attached (chunk_id, source_file,
// page range) because that provenance is the product here, not decoration: a
// legal answer that cannot be traced to a page in a filing is not usable, and
// "fraction of answers that trace to a real source" is one of the few
// comparison metrics that needs no LLM judge and no human opinion.
function formatSources(chunks) {
  return chunks
    .map((c, i) => {
      const pages =
        c.page_start === c.page_end ? `p. ${c.page_start}` : `pp. ${c.page_start}-${c.page_end}`;
      return `[${i + 1}] (${c.source_file}, ${pages})\n${c.text}`;
    })
    .join("\n\n");
}

async function callOllamaChat(userContent, sourceCount) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANSWER_MODEL,
      stream: false,
      think: false,
      format: buildAnswerSchema(sourceCount),
      // temperature 0 is not a quality choice, it is an evaluation
      // requirement: a comparison run twice must produce the same answers,
      // otherwise a difference between the two retrievers cannot be told
      // apart from sampling noise. seed is belt-and-braces for the same
      // reason. Both should stay pinned for as long as these numbers are
      // being compared against each other.
      options: { temperature: 0, seed: 42, num_predict: ANSWER_MAX_TOKENS },
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
  // done_reason is carried out rather than discarded because "length" means the
  // answer was cut off at num_predict, and a truncated answer scored as a wrong
  // answer would blame the retriever for a generation-budget problem. Observed
  // on the very first smoke test, where an answer ended mid-sentence at "held
  // as a" -- schema-constrained decoding still closed the JSON, so the
  // truncation was invisible to JSON.parse and would have been invisible to the
  // eval too.
  return { content: body.message.content, done_reason: body.done_reason };
}

// Turns the model's source NUMBERS back into real chunk provenance, discarding
// anything out of range instead of trusting it.
//
// Out-of-range citations are counted rather than silently dropped. A model that
// cites source [7] when six were supplied has invented a citation, and in a
// legal-document system that is a fabrication in its own right -- exactly the
// class of failure this project has spent its whole build catching (the "Judge
// LAP" hallucination, the confabulated defendants from garbled chunks). It is
// also a per-strategy metric worth reporting: if one retriever's context makes
// the model cite more carefully than the other's, that is a real finding.
function resolveCitations(citedNumbers, chunks) {
  const cited = [];
  let invalid = 0;
  for (const n of citedNumbers) {
    if (Number.isInteger(n) && n >= 1 && n <= chunks.length) {
      const c = chunks[n - 1];
      cited.push({
        chunk_id: c.chunk_id,
        source_file: c.source_file,
        page_start: c.page_start,
        page_end: c.page_end,
      });
    } else {
      invalid++;
    }
  }
  return { cited, invalid };
}

/**
 * Answer one question from a fixed set of retrieved chunks.
 *
 * @param {string} question
 * @param {Array<{chunk_id, source_file, page_start, page_end, text}>} chunks
 *        Retrieved context, already ordered best-first by whichever strategy
 *        produced it. Order is preserved into the prompt: it is part of what
 *        a retrieval strategy is being judged on.
 * @returns {Promise<{answer, answered_from_context, citations, invalid_citations, context_chunk_ids, latency_ms}>}
 */
export async function generateAnswer(question, chunks) {
  // An empty context is a legitimate retrieval outcome (a graph traversal that
  // anchors on no entity returns nothing), and it must not be quietly turned
  // into an unsourced answer from the model's own knowledge. Short-circuited
  // here rather than sent to the model at all, so the two strategies are
  // scored on the same definition of "found nothing".
  if (chunks.length === 0) {
    return {
      answer: "No context was retrieved for this question.",
      answered_from_context: false,
      citations: [],
      invalid_citations: 0,
      truncated: false,
      context_chunk_ids: [],
      latency_ms: 0,
    };
  }

  const userContent = `Question: ${question}\n\nSources:\n\n${formatSources(chunks)}`;

  const started = Date.now();
  const { content, done_reason } = await callOllamaChat(userContent, chunks.length);
  const latency_ms = Date.now() - started;

  const parsed = JSON.parse(content);
  // Positional, never model-echoed: verdict i is about source i+1.
  const verdicts = parsed.source_relevance ?? [];
  const relevantNumbers = verdicts.map((v, i) => (v?.relevant ? i + 1 : null)).filter(Boolean);
  const { cited, invalid } = resolveCitations(relevantNumbers, chunks);

  return {
    answer: parsed.answer,
    answered_from_context: parsed.answered_from_context,
    citations: cited,
    invalid_citations: invalid,
    // "length" = hit the token ceiling mid-answer; "stop" = finished normally.
    truncated: done_reason === "length",
    // Everything the model was shown, kept alongside what it actually cited --
    // the gap between the two is what separates "retrieval found it" from
    // "the model used it", and those are different failures with different fixes.
    context_chunk_ids: chunks.map((c) => c.chunk_id),
    latency_ms,
    model: ANSWER_MODEL,
  };
}

// ---------------------------------------------------------------------------
// Two-phase generation.
//
// The single-call design above asks one model, in one pass, to judge whether
// the passages are sufficient AND to write the answer. That is a conflict of
// interest, and generation pressure wins it: given eight passages and a
// question, producing something is the path of least resistance. It is why the
// system confidently describes what the corpus DOES contain when asked
// something the corpus cannot answer (KNOWN_LIMITATIONS.md section 2), and why
// four prompt amendments failed to stop it -- the prompt already forbids it in
// the strongest terms available.
//
// Splitting the two removes the conflict rather than arguing with it. Phase 1
// has no field in which to write prose, so it cannot smuggle a summary in as an
// answer. Phase 2 runs only if phase 1 said yes, and is never asked to hedge.
// Same lesson as the minItems/maxItems fix in Step 5: make compliance
// structural rather than instructed.
//
// The latency win is a side effect, not the motive, but it is what makes the
// system demonstrable: measured 2026-08-27, the single call takes 68.7s wall
// (4,096 tokens prefill in 19.8s, then 751 tokens generated at ~17 tok/s).
// Split and streamed, sources render at ~200ms, the verdict lands in a few
// seconds, and the answer writes itself visibly instead of the page sitting
// blank for over a minute.
//
// generateAnswer above is deliberately left untouched. Every row in
// eval/results/runs.jsonl was measured against it, and silently changing the
// generator would invalidate them.
// ---------------------------------------------------------------------------

// Both phases share ONE system prompt and ONE user prefix, differing only in a
// trailing task line. That ordering is deliberate and measured.
//
// Ollama keeps a single KV-cache slot per loaded model and reuses it only for a
// common prompt PREFIX. Measured 2026-08-27: re-sending an identical prompt
// drops prefill from 9,813ms to 57ms, but any intervening request evicts it
// (A -> B -> A costs the full 9,554ms again). So if phase 2 began with a
// different system prompt, it would diverge at token one and pay its own cold
// prefill -- roughly ten seconds of dead air between the verdict and the first
// word of the answer.
//
// Putting the sources and the question first, and the task instruction last,
// makes phase 1's prompt a prefix of phase 2's. Phase 2 then re-reads a cache
// phase 1 just populated, and starts emitting almost immediately.
const SHARED_SYSTEM = `You work with a corpus of US federal court filings. The numbered source \
passages below are extracted from PDFs, so they may contain OCR noise, odd line breaks and \
interleaved page furniture -- read through that.

Use ONLY these sources. Do not use outside knowledge about any person, case or event, even if you \
are confident it is true.`;

function sharedPrefix(question, chunks) {
  return `Sources:\n\n${formatSources(chunks)}\n\nQuestion: ${question}\n\n`;
}

// Phase 1's task. Note what is ABSENT from the schema it is paired with: any
// string field long enough to hold an answer. `missing` is about what the
// passages lack, not about the subject.
const VERDICT_TASK = `TASK: Do NOT answer the question. Judge only whether these passages contain \
enough to answer it.

Mark each passage relevant or not, IN ORDER, judging each independently.

Then set "sufficient". If you marked NO passage relevant, "sufficient" MUST be false -- there is
nothing to answer from. It is TRUE if the relevant passages let you give even a partial but specific \
answer -- a name, a role, a date, a holding. Do not demand completeness: a passage that answers half \
the question is still enough to be worth answering from.

Set it FALSE only when the passages genuinely cannot address the question at all -- most often \
because the corpus does not contain that KIND of material. When false, "missing" names in one short \
phrase what is absent, describing the gap in the corpus rather than the subject -- e.g. "no judicial \
opinions, only party filings". When true, leave "missing" empty.`;

// Phase 2's task. Plain text, not JSON: it streams straight to the page, and
// partial JSON would have to be repaired on every frame to be rendered.
// Nothing here needs structure -- the citations were already decided in phase 1
// from the relevance verdicts.
const ANSWER_TASK = `TASK: Answer the question from these sources.

They have already been judged sufficient, so answer directly and confidently. Prefer specific names, \
dates and docket numbers over vague summary. Do not describe the documents; answer the question. Do \
not include source numbers in your reply. Plain prose, no headings, no markdown.`;

// Booleans only, one per source, array length pinned to the source count.
//
// The single-call design paired each boolean with a <=10 word `why`, and that
// was load-bearing there: it forced the model to actually consider each source
// rather than wave a hand at all of them on the way to writing an answer.
//
// Here it is redundant and expensive. This call has no answer to hurry toward
// -- the judgment IS the entire output, so the forcing function is structural
// already. Measured 2026-08-27: with `why` the verdict generated 639 tokens and
// took 42s of the 64s total; the eight justifications were nearly the whole
// cost. Pinned minItems/maxItems still forces N separate decisions.
function verdictSchema(sourceCount) {
  return {
    type: "object",
    properties: {
      source_relevance: {
        type: "array",
        minItems: sourceCount,
        maxItems: sourceCount,
        items: { type: "boolean" },
      },
      sufficient: { type: "boolean" },
      missing: { type: "string" },
    },
    required: ["source_relevance", "sufficient", "missing"],
  };
}

/**
 * Phase 1: can these passages answer this question?
 *
 * Returns the per-source verdicts, the sufficiency decision, and -- when
 * insufficient -- a short phrase naming what is absent. No answer text, by
 * construction.
 */
export async function judgeSufficiency(question, chunks) {
  if (chunks.length === 0) {
    return { sufficient: false, missing: "no context was retrieved", citations: [], invalid_citations: 0, latency_ms: 0 };
  }

  const started = Date.now();
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANSWER_MODEL,
      stream: false,
      think: false,
      format: verdictSchema(chunks.length),
      options: { temperature: 0, seed: 42, num_predict: ANSWER_MAX_TOKENS, num_ctx: ANSWER_NUM_CTX },
      messages: [
        { role: "system", content: SHARED_SYSTEM },
        { role: "user", content: sharedPrefix(question, chunks) + VERDICT_TASK },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama /api/chat returned HTTP ${response.status}: ${await response.text()}`);

  const parsed = JSON.parse((await response.json()).message.content);
  const verdicts = parsed.source_relevance ?? [];
  // Positional, never model-echoed: verdict i is about source i+1.
  const relevantNumbers = verdicts.map((v, i) => (v === true ? i + 1 : null)).filter(Boolean);
  const { cited, invalid } = resolveCitations(relevantNumbers, chunks);

  // Deterministic guard over the model's own verdict, not a second opinion.
  //
  // "If you marked no passage relevant, sufficient MUST be false" is in the
  // prompt, and the model ignores it. Observed 2026-08-27 on AB-05 and ER-01:
  // zero sources marked relevant, sufficient returned true, and ER-01 then
  // produced a confidently wrong answer naming Jeffrey Epstein as one of the
  // people called Maxwell.
  //
  // Same lesson as Step 5's minItems/maxItems and Step 3's schema-constrained
  // types: an instruction the model can ignore becomes a rule it cannot when
  // it moves out of the prompt and into code. Nothing can be answered from a
  // set of passages the model itself judged entirely irrelevant, so this is
  // an entailment of its own output rather than an override of its judgment.
  const sufficient = Boolean(parsed.sufficient) && relevantNumbers.length > 0;

  return {
    sufficient,
    missing: sufficient ? "" : parsed.missing || "no retrieved passage was judged relevant to the question",
    source_relevance: verdicts,
    citations: cited,
    invalid_citations: invalid,
    latency_ms: Date.now() - started,
  };
}

/**
 * Phase 2: write the answer, streaming.
 *
 * Calls onDelta with each text fragment as it arrives. Returns the assembled
 * answer and whether it hit the token ceiling.
 *
 * Only call this when judgeSufficiency returned sufficient: true. Calling it
 * regardless would reintroduce exactly the defect the split exists to remove.
 */
export async function streamAnswer(question, chunks, onDelta) {
  const started = Date.now();
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANSWER_MODEL,
      stream: true,
      think: false,
      options: { temperature: 0, seed: 42, num_predict: ANSWER_MAX_TOKENS, num_ctx: ANSWER_NUM_CTX },
      messages: [
        { role: "system", content: SHARED_SYSTEM },
        { role: "user", content: sharedPrefix(question, chunks) + ANSWER_TASK },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Ollama /api/chat returned HTTP ${response.status}: ${await response.text()}`);

  // Ollama streams newline-delimited JSON. A network chunk can split a line in
  // half, so hold the remainder rather than trying to parse it -- the tail of
  // one read is the head of the next.
  const decoder = new TextDecoder();
  let buffer = "";
  let answer = "";
  let doneReason = null;

  for await (const bytes of response.body) {
    buffer += decoder.decode(bytes, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line);
      const delta = frame.message?.content ?? "";
      if (delta) {
        answer += delta;
        onDelta(delta);
      }
      if (frame.done) doneReason = frame.done_reason;
    }
  }

  return { answer, truncated: doneReason === "length", latency_ms: Date.now() - started, model: ANSWER_MODEL };
}
