# How RAG systems are measured

Written 2026-08-26, rewritten the same day to carry the technical formalism
alongside the plain-language explanation rather than one or the other.

Two things in one document: the standard evaluation vocabulary of the field,
given precisely and then explained in ordinary language, and an honest account of
which of it this project actually applied. Every section states the technical
definition first and follows it with the intuition — read either layer alone and
it should still hold together.

---

## The decomposition, and why it comes first

A RAG pipeline is a composition of two estimators — a retriever `R(q) → C`
producing a context set, and a generator `G(q, C) → a`. End-to-end accuracy is
bounded above by retrieval sufficiency: if the evidence isn't in `C`, no `G`
recovers it. Error attribution is therefore the primary job of an eval suite,
which is why metrics are stratified by layer rather than collapsed into one
score.

In plain terms: a RAG system is two systems bolted together, and they fail
independently. Did we fetch the right text, and given that text, did we write a
good answer? A wrong answer tells you nothing until you know which half broke. If
the evidence never got retrieved, no model can save you — the generator can't
cite what it never saw. If the evidence *was* retrieved and the answer is still
wrong, that's a completely different bug with a completely different fix. A
single end-to-end accuracy number tells you the system is wrong; it never tells
you what to go and change.

---

## Layer 1 — retrieval, the classical IR (Information Retrieval) metrics

Every metric here requires **qrels** (query relevance judgments): a set of
`(query, document, grade)` triples, binary or graded — TREC conventionally uses
0-3. Constructing qrels is the expensive human step, and its absence is why most
RAG projects report no Layer-1 numbers at all.

These metrics are borrowed wholesale from search engines and are decades old. The
catch is that for each question, a human has to have marked which chunks
genuinely contain the answer. That labelling is the whole cost, and it's the
reason this entire layer gets quietly skipped in practice.

### Recall@k

`Recall@k = |relevant ∩ retrieved_k| / |relevant|`

The ceiling metric — every downstream score inherits its cap.

This is *the* metric for RAG: of all the chunks that genuinely answer the
question, what fraction landed in our top k? If recall@10 is 0.6, then 40% of
your questions are unanswerable before the LLM even wakes up, and no amount of
prompt engineering will recover them. When people spend weeks tuning prompts on a
system whose real problem is recall, this is the number they never measured.

### Precision@k

`Precision@k = |relevant ∩ retrieved_k| / k`

Secondary in RAG, because context windows tolerate noise better than absence —
though noise still costs attention dilution and distractor-induced errors.

Of the k chunks you returned, what fraction were actually relevant. It matters
less than people assume — one extra irrelevant chunk is usually harmless — but
junk crowds the context window and gives the model something wrong to latch onto.

### MRR — Mean Reciprocal Rank

`MRR = (1/|Q|) · Σ 1/rank(first relevant)`

Sensitive only to the first hit; appropriate where relevance is effectively
singular.

Look only at the *first* correct chunk in the list. Ranked 1st scores 1.0; 2nd
scores 0.5; 3rd scores 0.33; 10th scores 0.1. Average across all questions. It
answers "how quickly do we hit gold," and it's the right choice when each
question has one right answer sitting somewhere in the pile.

### MAP — Mean Average Precision

Average precision for one query is the mean of `Precision@i` evaluated at each
rank `i` holding a relevant document; MAP averages that across the query set.

Unlike MRR, which stops caring once it finds the first good hit, MAP rewards you
for ranking *all* the relevant material highly. Use it when a question has
several pieces of supporting evidence and you want credit for surfacing all of
them, not just one.

### nDCG@k

`DCG@k = Σᵢ₌₁..ₖ gainᵢ / log₂(i+1)`, with gain either `relᵢ` or the exponential
variant `2^relᵢ − 1` (web-search convention, which sharply upweights highly
relevant documents). Normalise by `IDCG@k`, the DCG of the ideal permutation, so
scores are comparable across queries holding different numbers of relevant
documents.

This is the sophisticated one, and it's worth understanding because it's what
serious search teams actually use. Two ideas stacked on top of each other. First,
relevance is **graded**, not yes/no — a chunk can be perfect, partly useful, or
useless, and the grades count differently. Second, a hit further down the list is
**worth less**, discounted as you descend, because users read from the top. Add
those up, then divide by the score a perfect ordering would have earned, so 1.0
means you couldn't have ranked it better. It's the only common metric that
rewards putting the *best* evidence first rather than merely including it
somewhere in the pile.

### Hit rate / Success@k

Binary: did *any* relevant chunk appear in the top k.

Crude, but useful as a floor and as a sanity check that the plumbing works at
all.

---

## Two RAG-specific complications classical IR doesn't have

**Qrels are chunk-level, so they're bound to your chunking configuration.**
Relevance is judged over retrieval units, not documents. Change
`chunk_token_size` or the overlap and every judgment is silently invalidated,
because the units being judged no longer exist.

Practically: your expensive human labelling is tied to one specific way of
cutting up the documents. Re-cut them and you've thrown the labels away. This is
why chunking parameters belong in the experiment key alongside the model — and
it's a live trap when comparing against a system with different chunking, which
ArangoDB's Importer is at 1024 tokens with 128 overlap.

**Relevance is the wrong predicate; sufficiency is the right one.** Standard IR
metrics are element-wise — each document judged independently. A multi-hop
question needs a *set* that jointly entails the answer, and a chunk supplying
only a bridging entity can look irrelevant in isolation while being necessary to
the join. Set-level sufficiency has no clean classical metric, which is why
claim-level context recall has taken over in the RAG literature.

In plain terms: relevance gets judged one piece at a time, but some questions
need two pieces that only work together, and neither looks useful alone. The old
metrics were built for "find me documents about X," not "assemble enough to
derive X."

---

## Layer 2 — generation

Given whatever context was retrieved, was the answer any good?

### Faithfulness / groundedness

Decompose the answer into atomic claims, then entailment-check each against the
context — either with an NLI model (AlignScore, SummaC) or an LLM judge. Score =
supported claims / total claims. Semantics matter here: this measures entailment
by *the provided context*, not truth about the world.

This is the hallucination metric, and it's the most important one at this layer.
Chop the answer into individual factual claims and check each one against the
retrieved text; nine true claims and one invented one scores 0.9. Note carefully
what it does **not** check — whether the answer is correct in reality. An answer
faithfully grounded in a wrong document scores a perfect 1.0.

### Answer relevance

RAGAS operationalises this without gold answers: reverse-generate n candidate
questions from the answer, embed them, take mean cosine to the original question.

It asks "did it answer the question I asked?" — which is genuinely separate from
being grounded. You can be perfectly faithful and still answer a different
question: every sentence supported, none of it responsive.

### Answer correctness

Against a human-written reference. Lexical measures (exact match, token F1,
ROUGE-L) work for short extractive answers and poorly for free-form; BERTScore
adds semantic tolerance; LLM-judge correlates best with humans and carries the
most bias.

Is it actually right. Needs gold answers written by a person, which is again the
expensive part.

### Attribution / citation quality

The ALCE benchmark formalises this as citation precision (does each cited passage
actually support its claim) and citation recall (is every claim needing support
actually cited).

Do the footnotes point at the right place. This is distinct from faithfulness —
an answer can be fully entailed by the context and still attach the wrong
footnote to a given sentence. Users trust citations more than they trust prose,
so a wrong citation is worse than a missing one.

### Abstention

Evaluated on an unanswerable subset: refusal precision and recall. The broader
frame is selective prediction — plot risk against coverage, or take AUROC of a
confidence signal against correctness, to characterise the whole threshold curve
rather than a single operating point.

Given context that doesn't contain the answer, does the system refuse rather than
confabulate? **This is this project's documented failure**, written up in
`node/eval/KNOWN_LIMITATIONS.md` §2 after four separate attempts to fix it.

---

## The mnemonic worth memorising: the RAG triad

Three relationships, three edges of a triangle:

| Edge               | Question it asks                      | What it catches   |
|--------------------|---------------------------------------|-------------------|
| question ↔ context | Is the retrieved text relevant?       | retrieval failure |
| context ↔ answer   | Is the answer grounded in it?         | hallucination     |
| question ↔ answer  | Does the answer address the question? | evasion, drift    |

If all three are healthy it is very hard for the system to be badly wrong, and
it's a good diagnostic *order* to walk when something breaks.

The obiter dicta failure (AB-01) sits precisely here: context↔answer held —
nothing was fabricated, every sentence came from the retrieved passages — while
question↔answer collapsed to zero responsiveness. That is why grounding
instructions in the system prompt cannot touch it: grounding was never the thing
that broke.

---

## Judge methodology, since most of Layer 2 is LLM-judged

LLM judges carry documented, measurable biases: **position bias** (favouring
whichever candidate appears first), **verbosity bias** (longer answers scored
higher), and **self-preference bias** (a model favouring its own generations).
Standard mitigations are pairwise rather than pointwise scoring, swapping
presentation order and averaging, and ensembling multiple judges. Validate
against a human-labelled subsample and report agreement — Cohen's κ, or
Krippendorff's α for multiple raters.

Plainly: when a model grades another model, it has predictable favourites — it
likes the first answer it sees, it likes long answers, and it likes its own
writing. Check it against a human on a sample before you trust any of its
numbers. An unvalidated judge score is a number with no error bar on it.

---

## Statistics — the part that matters most at our scale

With 35 questions across 7 strata of 5, per-stratum resolution is 20% per
question. System comparisons need a **paired bootstrap** or **permutation test**
over per-query scores rather than a comparison of means — the queries are shared,
and the pairing is where the statistical power lives. Report confidence
intervals.

The pinned `temperature: 0, seed: 42` in `answerGenerator.js` removes *sampling*
variance so a rerun reproduces exactly, which is necessary to attribute any
difference to the retriever. But it does nothing about sampling error over the
question set. Determinism is not significance: with five questions per category,
one answer flipping moves that category's score by 20 points, so small gaps
between strategies mean nothing at all.

---

## Reranking and RRF — techniques, not metrics

**Reranking** is a bi-encoder/cross-encoder cascade. The bi-encoder runs two
independent forward passes — one over the query, one over the passage — pooling
each into a fixed-width dense vector, scored by cosine over L2-normalised
vectors. Because the passage embedding is query-independent it can be computed
offline and indexed under ANN (IVF, HNSW), making query cost independent of
corpus size. Its weakness is the information bottleneck: all query-passage
interaction is forced through one fixed vector, with no token-level attention
between them. The cross-encoder instead runs a single forward pass over
`[CLS] query [SEP] passage [SEP]` with full self-attention across both segments,
emitting a scalar from a classification head — no embedding, no cosine, nothing
precomputable, O(N) model calls for N candidates.

In plain terms: the fast one reads the question and the chunk *separately*, boils
each down to a list of numbers, and compares the two summaries. Because each side
is summarised independently, all 3,338 chunk summaries can be computed once, in
advance — that's what makes search instant. The cost is that each chunk was
summarised without knowing what would ever be asked of it. The accurate one reads
the question and the chunk *together, as one piece of text*, and judges the pair
directly. Far better, because it can notice that this specific chunk answers this
specific question, but nothing can be precomputed, so you're running the model
once per candidate. Hence the standard pattern: retrieve ~50 candidates fast,
rerank those 50 slowly and well, keep the top 10. Cheap where it can be,
expensive only where it pays.

### Specific flow: where do the N candidates come from?

That's the whole point of the cascade. Stage 1 scores all 3,338 chunks cheaply —
one ANN lookup against precomputed vectors — and hands its top N down. Stage 2
runs the expensive model only on those N. The cross-encoder is a reordering
device applied to a shortlist someone else produced; it has no mechanism for
finding anything.

The consequence is the part that matters: **a reranker inherits stage 1's
recall.** It improves precision and cannot improve recall — a chunk ranked #500
by the bi-encoder is unrecoverable however good the reranker is. That is exactly
why `hybridRetriever.js` is not built as retrieve-then-rerank: four channels each
search the whole corpus independently, so a chunk that cosine ranks #329 can
still arrive at #1 through BM25.

Worth knowing there's a middle option — late-interaction models like ColBERT keep
per-token embeddings and score with MaxSim, recovering term-level interaction
while staying precomputable.

**RRF (Reciprocal Rank Fusion)** fuses ranked lists by `Σ 1/(60 + rank)`, using
rank order only. That's what lets lists on incomparable score scales combine
without anyone having to invent weights for them.

### What "invent weights" actually means

Worth spelling out, because it is the whole justification for using rank fusion
rather than the more obvious thing.

The four channels in `hybridRetriever.js` return numbers that are not
comparable to each other:

| Channel | Returns | Scale |
|---|---|---|
| vector | cosine similarity, e.g. `0.42` | bounded, roughly 0–1 |
| lexical | BM25 score, e.g. `14.7` | unbounded, and it shifts with query length |
| density | a count of chunks from one document, e.g. `9` | small integers |
| graph | hop distance / mention count | small integers, different meaning again |

To fuse by *score* you must first put all four on one scale, and then decide how
much each one counts:

```
final = 0.5·vector + 0.2·lexical + 0.2·density + 0.1·graph
```

Those four coefficients are the invention. There is no principled source for
them in this project, because fitting weights honestly requires labelled data —
a set of questions with known-correct passages to optimise against. This project
deliberately has none (see "What this project actually has" below). So in
practice the numbers would be guessed and then nudged while watching five or six
questions, which is tuning to those five or six questions rather than to the
problem.

Rank fusion sidesteps it. Position 1 means the same thing in every channel, so
`1/(60 + rank)` needs no scale conversion and no per-channel weight.

**The honest caveat**: the `60` is also a chosen number. It comes from the
published default in Cormack et al. (2009), and its only real job is to stop the
top one or two ranks from dominating everything below them. The defensible claim
is not "no constants" — it is *one* shared constant taken from the literature,
instead of one tuned knob per channel.

And the reserved slots are, strictly, a weight: half of `RETRIEVAL_TOP_K` is
guaranteed to plain cosine, which is a hand-set preference for one channel over
the others. It was added because equal-weight fusion fixed one question and
broke another in the same change. It is a scar, not a design — and it should be
described that way rather than dressed up.

Neither of these measures anything. Both change what gets measured. **This
project has no reranker** — `RETRIEVAL_TOP_K = 8` comes out of the bi-encoder, or
out of RRF fusion for hybrid, and goes straight into the prompt.

---

## What this project actually has

`node/eval/runEval.js` records per row: retrieved chunk ids, source files, vector
distances, which channels fired, graph traversal path, fallback flag, citation
count and rate, invalid citations, `answered_from_context`, truncation, and
latency split into retrieval and generation. The experiment key is
`ANSWER_MODEL|k|prefix|expand`, correctly treating a config change as a new
measurement rather than a duplicate row.

Absent is all of Layer 1 — no qrels, therefore no recall@k, nDCG, MAP or MRR.
`human_correct` and `human_notes` are `null` in all 35 rows.

The reasoning in the file header is a validity argument rather than laziness:
real relevance labels need a human reading the source PDFs, and an LLM-generated
gold set would make both systems' scores a function of one model's reading of the
corpus — exactly the judge-bias problem above, with no human anchor available to
validate against. Rather than manufacture a number that looks like a measurement,
the harness records the evidence and leaves the grading column empty.

What it measured instead is *difference*, not relevance: inter-strategy document
overlap, disagreement rate, and the fallback rate of 11 of 35. Those establish
that the strategies behave differently. They don't establish which one is right.

---

## The cheap Layer-1 proxy still worth building

For the extractive short-answer strata, test whether the gold answer string
appears in the concatenated retrieved context under normalisation — case folding,
whitespace collapse, punctuation stripping. Call it **answer-in-context rate**.
It's a weak-supervision proxy for recall@k requiring one label per question
rather than |corpus| labels per question.

The value is that it partitions the error cleanly: string present in context but
the answer is wrong means a generation bug; string never arrived means a
retrieval bug. For 35 questions it's roughly an hour of work, and it would move
the eval from "these strategies differ" to "this strategy retrieves the evidence
more often."

It is invalid for the aggregation and abstention strata, where no single span
constitutes the answer. Not built as of 2026-08-26.

---

## Frameworks that package all of this

For reference rather than endorsement — none were used here.

- **RAGAS** — faithfulness, answer relevance, context precision, context recall
- **TruLens** — origin of the RAG-triad framing above
- **DeepEval**, **ARES** — similar coverage, different ergonomics

The standing caveat applies to all of them: most compute their scores using an
LLM as judge. That's fast, cheap and genuinely useful, but the measurement
inherits the judge model's blind spots — and two systems can end up ranked
against one model's reading of the evidence rather than against the evidence.
Worth knowing before treating any of their output as ground truth.
