// Optional pre-retrieval step, shared by every retrieval strategy: rewrite the
// user's question into the vocabulary the documents actually use, before it is
// embedded.
//
// This exists because of a measured failure, not a hunch. Asked "What is the
// obiter dicta in this case?", bge-large ranked the corpus's only genuine
// quoted judicial observations at #1269 and #1768 of 3,338 -- the bottom half --
// and returned privilege-log boilerplate instead. The passages were there:
//
//   1328.23 p.8   "...the Court notes that 'evidence of a tortfeasor's wealth is...'"
//   1328.18 p.15  "...('I find that interrogatory P is over-broad because...')"
//
// The gap is purely lexical-conceptual. "Obiter dicta" is a Latin term of art
// that never appears anywhere near the thing it describes, and the embedding
// model does not bridge it. An older OpenAI ada-002 index over the identical
// corpus reportedly did. Re-running bge-large against that index's own
// page-level chunks scored them 0.3915 and 0.4477 against a 0.3177 retrieval
// cutoff, which ruled out chunking as the cause and left the embedder.
//
// Changing embedders is the heavy fix. This is the cheap one: spend one local
// LLM call turning jargon into the words a court filing would really contain.
//
// Deliberately shared rather than owned by one retriever. If naive RAG expanded
// its queries and the graph retriever didn't, the eval would be measuring query
// preprocessing, not retrieval strategy -- same reason answerGenerator.js is
// common to both.

import { OLLAMA_URL, ANSWER_MODEL } from "../config.js";

// Two outputs, because they are two different retrieval theories and the eval
// should be able to test them separately rather than blending them by default:
//
//   expanded_query       -- the question restated in document vocabulary.
//                           Conservative: still a query, just de-jargonized.
//   hypothetical_passage -- HyDE. A short invented passage of the kind that
//                           WOULD answer the question, embedded as if it were a
//                           document. Sounds unsound and measures well: matching
//                           document-to-document sidesteps the asymmetry between
//                           a 9-word question and a 350-word passage entirely.
//
// Nothing generated here is ever shown to the user or fed to the answer model.
// It exists only to produce a better vector. A hallucinated detail in the
// hypothetical passage costs a slightly worse retrieval, never a wrong answer --
// which is why the invented-passage trick is safe here and would not be
// anywhere downstream.
const EXPANSION_SCHEMA = {
  type: "object",
  properties: {
    expanded_query: { type: "string" },
    hypothetical_passage: { type: "string" },
  },
  required: ["expanded_query", "hypothetical_passage"],
};

const SYSTEM_PROMPT = `You prepare search queries for a corpus of US federal court filings -- motions, \
depositions, discovery disputes and exhibits.

Given a question, produce two things:

1. "expanded_query": the same question restated using the concrete words and phrases that would \
literally appear in such documents. Replace terms of art and Latin with the plain language a filing \
would use. Keep any names, dates and docket numbers exactly as given. Add closely-related phrasings \
rather than narrowing to one.

2. "hypothetical_passage": two or three sentences written as if excerpted from an actual filing that \
answers the question. Match the register of a court document, not a summary.

Critical: invent NO case-specific facts -- no party names, dates, dollar amounts or outcomes that \
were not in the question. Both outputs are used only to steer a semantic search, so generic-but- \
correctly-worded text is exactly right, and invented specifics actively hurt.

Example -- question: "What was the outcome of the sanctions motion?"
  expanded_query: "motion for sanctions granted denied; Rule 37 sanctions; the motion is granted in \
part and denied in part; award of fees and costs; order resolving motion for sanctions"
  hypothetical_passage: "For the foregoing reasons, the motion for sanctions is granted in part and \
denied in part. Defendant shall bear the reasonable costs and attorneys' fees incurred in connection \
with the motion."

The example is from a DIFFERENT kind of question than the ones this system is evaluated on, and \
deliberately so: an example drawn from a question you will later be asked teaches the answer rather \
than the format. An earlier version of this prompt used the evaluation question itself as the \
example, and the model simply echoed it back -- the test measured the prompt author, not the model.`;

/**
 * Expand one question into retrieval-friendly text.
 *
 * @param {string} question
 * @returns {Promise<{expanded_query: string, hypothetical_passage: string}>}
 */
export async function expandQuery(question) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ANSWER_MODEL,
      stream: false,
      think: false,
      format: EXPANSION_SCHEMA,
      // temperature 0 for the same reason as answerGenerator.js: an eval run
      // twice must retrieve the same chunks, or a strategy difference cannot be
      // separated from sampling noise.
      options: { temperature: 0, seed: 42, num_predict: 400 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: question },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama /api/chat returned HTTP ${response.status}: ${await response.text()}`);
  }

  const parsed = JSON.parse((await response.json()).message.content);
  return {
    expanded_query: parsed.expanded_query,
    hypothetical_passage: parsed.hypothetical_passage,
  };
}
