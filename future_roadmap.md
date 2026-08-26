# Future Roadmap

Forward-looking notes, captured 2026-08-22 while the final full-corpus run was
executing. Nothing here is committed work — it is the reasoning behind possible
directions, recorded so the *why* survives.

---

## 1. Multimodal ingestion (image / PDF / OCR, video later)

**The case is already proven by this corpus, not hypothetical.**

The final ingest dropped 34 chunks across two documents — `1327.3_1` (handwritten
notes) and `1327.11` (51 pages of scanned paper phone-message slips). Their text
layers were destroyed, but *the pixels are intact*. A human can read those slips.
A vision model very likely can too. These are not unreadable documents; they are
documents where we chose the wrong reader.

**The design insight is routing, not "add vision."**

Running a VLM over all 3,338 chunks is the expensive, naive move. The right shape
is a cheap deterministic triage that escalates only what fails:

    text extraction -> quality gate -> [clean]  -> existing pipeline
                                    -> [failed] -> vision model -> pipeline

The gate already exists in fragments — the `CONTROL_CHARS` invariant in
`extract_and_chunk.py`, plus the per-document rare-char-density measurement used
to identify the two bad documents. Today those signals *reject*; in this design
they *route*. Text path stays fast and cheap; the expensive path handles ~1%.

Video is correctly the lowest priority — the corpus has none, and it is a
fundamentally different retrieval problem (temporal segmentation) rather than an
extension of this one.

## 2. Agentic orchestration (research assistant, contrarian, etc.)

**Give the skeptic tools, not just an oppositional persona.**

The common failure of adversarial multi-agent setups is theater: the contrarian
has no independent evidence, only a different system prompt, so it disagrees
*stylistically*. It sounds rigorous and adds nothing.

Worth noting what actually corrected this project repeatedly — not reasoning
harder, but measurement:

- PyMuPDF was a sound hypothesis; byte-identical output killed it.
- "Wordiness" was a plausible garbage detector; discovery search-term lists
  scoring 0.06 (worse than actual garbage at 0.257) killed it.
- The compaction speedup was predicted to save hours; it measured ~5%.

In each case the useful contrarian was *the corpus*. So the design constraint is:
a verification budget and tool access, not an argumentative tone. "Prove it
against the data" beats "consider the opposite."

## 3. Research assistant / web sourcing

**The hard part is provenance, not scouring.**

This graph's real discipline is that every entity traces back through
chunk -> page -> document. The moment web-sourced claims enter, they need the
same treatment or they contaminate everything downstream — and in a legal
context that is a credibility problem, not a quality problem. Web-sourced
assertions would need first-class provenance (source URL, retrieval timestamp,
confidence) and should probably be a *visually and structurally distinct* class
of node, never silently merged with document-derived facts by dedup.

## 4. Sequencing

Query before expansion. As of this writing the graph has never been queried —
Step 8 does not exist. Until a question can be asked and answered well, the
graph's quality is unvalidated, and every upstream investment (multimodal, more
agents) is guessing about a foundation nobody has tested.

## 5. Orchestration as tutorial material

Worth taking seriously. This repo's comments already explain decisions with
measured evidence rather than assertion — "38 separate Mr. Barton nodes,"
"110 nodes redundant purely on case," "554 fabricated mentions from 74 garbled
chunks." Most tutorials have nothing like that, because most tutorials are
written from a finished system rather than from the failures that shaped it.

## 6. Fixing abstention for production

The one known defect that would matter in real use. Documented as a limitation
in `node/eval/KNOWN_LIMITATIONS.md` §2; this is the plan for actually fixing it.

**The symptom.** Asked something the corpus cannot answer, the system describes
what the corpus *does* contain and presents that as an answer. AB-01 ("what is
the obiter dicta in this case?") is the canonical case: every sentence returned
is faithful to the retrieved passages, and none of it addresses the question. In
RAG-triad terms, context↔answer holds while question↔answer collapses.

**Why four prompt fixes failed.** The system prompt already forbids exactly this,
in the strongest terms available — "an accurate description of irrelevant
documents is still a failure to answer" — and the model does it anyway. The
grounding instructions are not the lever, because grounding was never what broke.

The root cause is a conflict of interest: one model, in one pass, is asked to
judge sufficiency *and* to write the answer. Generation pressure wins. Given
eight passages and a question, producing something is the path of least
resistance, and self-assessment is the weakest possible check on that.

### The fix, in three parts

**6.1 — Separate the decision from the generation.** Two calls instead of one.
Call one receives the question and the passages and returns *only* a verdict:
sufficient or not, plus the specific missing fact when not. It has no field in
which to write prose, so it cannot smuggle a summary in as an answer. Call two
runs only if the verdict is yes.

This is the same lesson Step 5 learned with `minItems`/`maxItems` and Step 3
learned with schema-constrained decoding: **make compliance structural rather
than instructed.** A model can shrug off an instruction; it cannot produce a
field the schema does not offer.

**6.2 — Treat sufficiency as a retrieval property, not a text one.** Score the
evidence before generation rather than asking the generator to grade itself.
Signals already available at no extra cost:

- **Vector spread** — measured at 0.0804 on a question with a real answer versus
  0.0206 on the obiter question. A 4x separation between "found something
  specific" and "returned k rows because k were asked for."
- **Whether any channel ranked anything strongly**, rather than all four
  returning flat lists.
- **Whether the graph anchored at all** — `graph_path.fallback` is already
  recorded and is a direct signal that the question named nothing the corpus
  knows.

Combined into a calibrated threshold, this is an abstention decision made from
measurable retrieval state instead of from a model's opinion of its own output.
It must be tuned against the `absence_abstention` stratum rather than guessed --
inventing the threshold would repeat exactly the mistake this project has
avoided elsewhere.

**6.3 — Use a dedicated entailment model for claim-level support.** Rather than
asking the generator whether its own answer is grounded, decompose the answer
into atomic claims and check each against the retrieved passages with an NLI
model. `answered_from_context` is self-reported and the eval already records it
as unreliable; this replaces self-assessment with an independent judge.

### Recommendation

**Build 6.1 and 6.2 together; treat 6.3 as later.** The first two are cheap,
deterministic where they can be, and between them they remove the conflict of
interest rather than arguing with it. 6.3 adds a second model to the serving
path and buys refinement, not the fix.

Critically, all three are **testable against evidence that already exists**: the
five `absence_abstention` questions, plus the deepseek probe rows in
`runs.jsonl`, plus `runs-graph-v1-name-only.jsonl`. Any proposed fix that does
not improve those five should be reported as a failure and abandoned, exactly as
the four prompt amendments were.

### What this does not fix

Answering the *wrong* question while the corpus does contain the right answer.
That is an answer-relevance problem rather than an abstention one, and nothing
above addresses it.
