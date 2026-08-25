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
