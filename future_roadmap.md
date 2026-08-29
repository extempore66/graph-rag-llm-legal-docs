# Future Roadmap

Forward-looking notes. Sections 1-6 were captured 2026-08-22 while the final
full-corpus run was executing; sections 7-8 were added 2026-08-29. Each section
carries its own date. Nothing here is committed work — it is the reasoning behind
possible directions, recorded so the *why* survives.

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

## 7. Incremental ingestion — adding filings to a matter already loaded

Captured 2026-08-29, prompted by a direct question about automating this.

**The first thing to correct is a claim made on the presentation deck.** Slide 08
said, in effect, that adding one filing means rebuilding the whole graph, and
that is too pessimistic. The 19.8 hours spent on Steps 4-6 built 2,014 entities
from nothing, so almost every one of 19,009 mentions arrived with no prior graph
to match against and triggered an LLM judgment call. A single new filing carries
roughly a hundred mentions against a fixed set of ~2,014 existing entities: about
200,000 Jaro-Winkler comparisons, which is milliseconds, and perhaps sixty LLM
calls. The incremental case is minutes. What is genuinely unsolved is narrower
than "rebuilding", and is described below.

**The pipeline splits into three phases with different concurrency rules.**
Phase A — chunk, embed, extract, write `je_raw_extractions` — is per-document and
embarrassingly parallel, because it shares no state. Phase B, entity resolution,
must be serialised *per matter*: two workers processing two filings would each
find no existing "Mr. Recarey" and each create one. `dedupBatchRunner.js` already
takes a per-name lock for exactly this reason, so the change is to widen the
scope rather than to invent the mechanism. Phase C is new, and is the real work.

**Documents must be keyed on their contents, not their filename.** Courts re-file
corrected versions of the same document constantly, and a docket number tells you
nothing about whether the bytes have been seen before. A content hash makes
re-ingestion idempotent, which matters more than it sounds: an automated watcher
over a docket feed will re-present the same file, and a pipeline that cannot
recognise it will duplicate every entity in it.

**Phase C is a backwards sweep, and it is the piece that does not exist today.**
The graph may hold `V. Roberts` and `Virginia Giuffre` as two separate people
because nothing in the corpus ever connected them. A new filing reading "Virginia
Roberts Giuffre, formerly known as Virginia Roberts" should merge them, and
nothing in the current design ever revisits an existing entity. The sweep re-runs
candidate generation for the entities a batch *created or touched*, against the
existing graph — cost proportional to the delta, not the total. The same pass
should re-examine the 413 rows in `je_possible_duplicates`, since new evidence can
settle an old "unsure" and at present nothing ever looks at them again.

**Merges are cheap here only because identity is an edge.** The architecture never
collapses two nodes into one; it links them and expands the family at query time.
A retroactive merge is therefore a single edge insert, whatever the entity's
history — rather than finding every `je_mentioned_in` edge pointing at the loser,
rewriting it, and deleting the node. Three consequences follow, and they are the
argument for the design: merging is O(1), it is reversible by deleting the edge,
and no mention is ever rewritten, so the original resolution decision stays
auditable. A destructive merge has none of those properties.

**Three things stay genuinely hard.** *Order dependence*: whichever spelling loads
first becomes the node's stored name, so `Det. Recarey` can end up canonical by
accident — fixable by choosing the family's best name at query time instead of
storing a winner. *Non-determinism*: the same documents loaded in a different
order produce a slightly different graph, which is uncomfortable for a system
producing legal evidence, and the answer is to log each resolution decision with
its inputs so a result can be *explained* rather than merely reproduced.
*Cascades*: merging A with B can make the combined family match C, and chasing a
fixed point is how one node ends up swallowing the graph — one pass, then flag.

**Operationally this wants a queue rather than a script:** per-document jobs,
retry with backoff, and one unreadable PDF that cannot stall an entire matter.
Chunk-level resumability already exists (`dedup_processed`), so a crashed job
resumes rather than restarting. For court filings specifically the RECAP/PACER
API means a docket can be watched, rather than waiting for someone to drop files
into a folder.

## 8. Onboarding a new matter, or a different kind of corpus

Captured 2026-08-29, same conversation. A different problem from section 7, and
the hard part is not compute.

**Isolation is a requirement before it is a feature.** Two matters will both
contain a John Smith and they are not the same man, so name resolution must be
scoped to the matter and must never look across the boundary. This is not only a
correctness concern: matters carry ethical walls, and one client's data appearing
in another client's graph is a serious professional problem rather than a bug
report. Any design that relies on every future query remembering to include a
filter has put a legal requirement in the hands of whoever writes the next AQL.

**A database per matter is the safer default, and it is a real trade rather than
an obvious call.** It buys hard isolation and makes closing an engagement a single
`dropDatabase` — which is a retention requirement in this domain, not a
convenience. It costs cross-matter queries and leaves several hundred databases to
administer. The alternative, one database with the matter as a SmartGraph shard
key, keeps cross-matter questions available and turns deletion into a large
filtered delete. The tie-breaker is that the isolation requirement here is ethical,
and requirements of that kind should not rest on a `WHERE` clause.

**Cross-matter people need a separate, curated registry.** The same expert witness
appears in thirty cases, as does the same opposing firm, and a firm genuinely
wants to see that. The shape is two-level: per-matter entities stay isolated, and
a small firm-wide roster holds the people tracked across matters, linked outward
from each matter's own node. *Curated* is load-bearing — that link is a decision a
person makes, never an automatic merge, because an automatic one would breach
exactly the isolation the previous point exists to protect.

**Settings belong to the corpus, not to the environment.** Chunk separators,
`entity_types`, `JARO_WINKLER_THRESHOLD`, `SNIPPET_WINDOW_WORDS`, and whether
Step 7 coreference runs at all are properties of the material being ingested.
Deposition transcripts and markdown product documentation want different values
for most of them. Today these are environment variables and therefore global,
which is fine for one corpus and wrong for many. This is the presentation's own
argument turned into a config file: if the kind of documents decides the approach,
the pipeline should take the kind of documents as a parameter.

**Calibrate before committing, and quote the cost first.** For a new corpus there
is no reason to believe 0.85 is the right threshold. The bootstrap is: ingest a
sample, run candidate generation at several thresholds, have a person label about
a hundred pairs, then fix the threshold and record it *with the corpus*. Cost can
be projected the same way, since LLM call count scales with mentions that have
candidates — which means someone can be told "this will take nine hours" before
they start rather than after.

**The trap, and it is the single most important line in both sections. A sample
predicts cost. It does not predict correctness.** The unsorted-slice defect that
produced 38 separate "Mr. Barton" nodes — 9.6% of the graph — could not have
appeared in the 200-chunk test run, because it only triggers once enough names
clear the similarity threshold to crowd out the true match, and at ~220 entities
too few did. Onboarding a new corpus therefore needs an audit of the *full* first
run, not a sample check: sort entities by name similarity and read the top few
hundred clusters. That is an afternoon of work, and it is the step that catches
the class of defect that only exists at scale. Both of the worst bugs in this
build were library defaults behaving reasonably — case-sensitive comparison, and
slicing an unsorted list — and neither was visible by reading the code while both
were obvious in the output.
