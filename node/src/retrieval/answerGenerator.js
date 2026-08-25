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

import { OLLAMA_URL, ANSWER_MODEL, ANSWER_MAX_TOKENS } from "../config.js";

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
