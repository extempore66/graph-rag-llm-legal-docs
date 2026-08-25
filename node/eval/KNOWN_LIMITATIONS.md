# Known limitations of the query layer

Status as of 2026-08-24, after 80 measured rows in `results/runs.jsonl`
(70 at `qwen3:8b`, 10 at `deepseek-r1:32b`). Everything below is a measured
finding, not a prediction. Where a fix was attempted and failed, the attempt is
recorded so it is not tried a fifth time by accident.

---

## 1. The answerer narrates retrieval instead of answering the question

**This is the root defect. The abstention problem in section 2 is downstream of it.**

On questions whose answer is absent from the corpus, the model does not say so.
It writes a description of whatever passages arrived:

> qwen3:8b, AB-04 ("How much did Ghislaine Maxwell pay Virginia Giuffre to
> settle their dispute?") --
> *"The text provided is highly relevant to the legal case involving Virginia
> Giuffre and Ghislaine Maxwell. It details the discovery process, including
> motions to compel, objections to interrogatories..."*

> deepseek-r1:32b, AB-01 ("What is the obiter dicta in this case?") --
> *"The provided documents contain a mix of relevant and irrelevant
> information. They include legal arguments, interrogatories, responses, and
> witness testimony..."*

Neither is an answer. Both are relevance commentary occupying the `answer` field.

This is the failure mode the system prompt explicitly forbids
(`src/retrieval/answerGenerator.js`, STEP 3):

> "Do NOT summarise the passages as a substitute for answering: an accurate
> description of irrelevant documents is still a failure to answer the
> question."

Both models read that sentence and did it anyway. Prompt-level prohibition of a
behaviour is not a control over it.

Two plausible mechanisms, neither tested:

- **Field-order priming.** Schema-constrained decoding emits fields in schema
  order. `source_relevance` comes first and produces eight relevance rationales;
  by the time the `answer` field is generated the model has been primed into
  relevance-commentary register and continues in it.
- **No negative examples.** The prompt describes the correct absence behaviour
  abstractly but never shows one. `queryExpansion.js` needed a worked example to
  behave; this may too. (Whatever example is used must NOT be drawn from
  `questions.json` -- doing so caused verbatim echo once already.)

## 2. `answered_from_context` is unreliable

Four documented fix attempts, all measured, none successful:

| # | attempt | result |
|---|---------|--------|
| 1 | Explicit instruction to abstain | 8/8 `true` |
| 2 | Schema field reordering (relevance before answer) | 8/8 `true` |
| 3 | Pinned per-source verdicts with a `why` string | 8/8 `true` |
| 4 | Larger answer model (`deepseek-r1:32b`) | 4/10 `false`, but see below |

Attempt 4 moved the flag off the pin without making it informative. Across the
five absence questions, `naive` and `hybrid` retrieve near-identical document
sets yet disagree on the flag for **three of five** questions (AB-01, AB-02,
AB-04). A verdict that flips on identical evidence is noise, not signal.

One `false` was reached for an unrelated reason entirely: on AB-03,
`deepseek-r1:32b` returned *"I'm sorry, I cannot answer that question. I am an
AI assistant designed to provide helpful and harmless responses."* -- a content
refusal triggered by the subject matter of the corpus, scored as a correct
outcome by accident. Any future abstention metric must separate refusals from
abstentions or it will over-report success on this corpus.

**A fifth attempt should target section 1, not this flag.** Four attempts aimed
directly at the flag produced nothing; the flag is a symptom.

### Falsified hypothesis: cosine-distance spread

An earlier proposal held that absence questions would show a flat distance
spread (query landed near the corpus centroid, matched nothing in particular),
making spread a cheap abstention trigger. Measured across all 35 questions this
is **false**. Mean spread by stratum:

```
absence_abstention   0.0307   <- mid-range, not an outlier
entity_resolution    0.0264
aggregation          0.0223
```

The apparent 4x separation that motivated the idea came from two hand-picked
questions. Recorded here so it is not re-proposed.

## 3. Bigger is not uniformly better

`deepseek-r1:32b` costs ~178s/answer against ~65s for `qwen3:8b` (~2.8x) and is
**worse on attribution**, which is the failure mode that matters most in a legal
corpus. AB-05 asks what Prince Andrew said in his deposition; he was never
deposed in this case.

- `qwen3:8b`: *"The witness, **Ghislaine Maxwell**, testified that she
  recollected a caricature of Prince Andrew..."* -- correctly attributed, and
  therefore not a false claim about Prince Andrew.
- `deepseek-r1:32b`: *"**Prince Andrew was present** at Jeffrey Epstein's home
  in New York on multiple occasions."* -- attribution dropped, another witness's
  testimony restated as established fact.

Both fail to abstain. Only the larger model converts the failure into a
misattributed factual assertion. Model size is not a substitute for a working
grounding contract.

## 4. What does work

Not everything here is negative, and these are the parts worth keeping:

- **Citation discrimination is partially alive**, and it is the one axis that
  responds to both interventions tried. Rate of blanket "all 8 sources
  relevant" verdicts:

  ```
  all 35 questions:       qwen3:8b  naive    32/35 (91%)
                          qwen3:8b  hybrid   26/35 (74%)

  absence stratum only:   qwen3:8b  both      8/10 (80%)
                          deepseek-r1:32b     3/10 (30%)
  ```

  The second block is the like-for-like comparison: same ten
  (question, strategy) pairs, only the answer model changed.

  Both the retrieval strategy and the model move this number, in the expected
  direction, on a metric no fix was aimed at.

- **The three-channel hybrid genuinely differs from dense-vector retrieval.**
  Identical document sets on only 3 of 35 questions; ~10% latency cost.

- **Mechanical quality is clean.** Across 80 rows: 0 errors, 0 truncations,
  0 invalid citations.

## 5. Deferred, with reasons

- **Per-chunk relevance calls** (one LLM call per source rather than one per
  question) would probably fix section 1 at 8x the cost. Not attempted; the
  cost is the reason.
- **Hybrid channel weighting is hand-set, not measured.** Tuning it was stopped
  deliberately: at k=8 the reserved-slot count that fixes the Rodriguez question
  (>=3) and the count that fixes the obiter question (<=2) are mutually
  exclusive. Continuing would have been overfitting to n=2.
- **Lexical channel uses in-process BM25**, not a LanceDB FTS index, to avoid
  writing to `je_chunks` during a live read. Revisit once nothing is reading it.
- **`graphRetriever.js` does not exist yet.** `STRATEGIES` in `runEval.js` omits
  it rather than stubbing it, so no row claims a graph result that was not
  measured. It cannot be built until Steps 4-6 populate `je_entities`.

## 6. Provenance

All 35 gold answers in `questions.json` are still `verified: false`, and
`human_correct` / `human_notes` are null on all 80 rows in `results/runs.jsonl`.
Every claim in this document rests on machine-observable fields --
`answered_from_context`, citation counts, document sets, latency -- and on
direct reading of the answer text quoted above. None of it rests on graded
correctness, because no grading has been done.
