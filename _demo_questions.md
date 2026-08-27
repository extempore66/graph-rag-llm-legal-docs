# Demo questions

A staging list for the live demonstration. Each entry says what to ask, which
strategy to use, and **what to point at while it runs** — the retrieval frame
paints in ~60 ms, so there is roughly 25 seconds of talking time before the
answer starts streaming. That gap is the demo, not dead air.

Status column: `verified` means it was actually run and the behaviour below was
observed. `expected` means the mechanism is understood but the exact output has
not been watched end to end — check before relying on it in the room.

---

## Opening move — entity anchoring

**Q.** Who is Alfredo Rodriguez and what was his role in relation to Jeffrey Epstein?
**Strategy:** `graph` (or `hybrid` to show fusion) · **Status:** verified

Point at the graph path panel while it thinks: **1,957 mentions across 1,770
passages reachable, eight returned.** Then the coreference families — the same
person as `Alfredo Rodriguez`, `Rodriguez`, `Mr. Rodriguez`.

The evidence lines under each source are the payoff: role and the exact words
that put him in that passage.

---

## The hard one — declining to answer

**Q.** What is the obiter dicta in this case?
**Strategy:** `hybrid` · **Status:** verified

Two things to name out loud:

1. The **amber fallback banner** — the graph found no name to anchor on, so it
   degraded to similarity search *and said so* rather than taking credit.
2. The refusal itself. "The corpus contains only party filings, subpoenas,
   motions and deposition transcripts, but no judicial opinions or obiter dicta."

Worth saying: this failed four times before it worked, and the fix was
structural, not a better prompt. Backup slide B2 covers it.

---

## The one that surprises people

**Q.** Who were the defense attorneys in this case?
**Follow-up:** You said "Alan Dershowitz is represented by Mary Borja and Thomas
Scott". Is Alan Dershowitz a defendant in this case? Why is he "represented"?
**Strategy:** `hybrid` · **Status:** verified

The follow-up is the strong beat. The answer reads as implausible — a defense
attorney with his own attorneys — and the system explains it correctly from the
documents: defamation litigation arising from his involvement in the case and
the allegations made against him.

Corpus evidence, if challenged:

```
"Defense Attorney Alan Dershowitz"      "Dershowitz's counsel"
"Alan Dershowitz was her attorney"      "Dershowitz's attorney"
```

Both roles are genuinely in the record. **This is the moment to show the
evidence panel** — a claim that sounds wrong, traced back to the words that
produced it.

---

## The best one — a concept that is never named

**Q.** Can you find any obiter dicta reference in these documents even if it
refers to other cases?
**Strategy:** `hybrid` — and it **must** be hybrid · **Status:** verified

The system finds a real instance: the **Khalil case**, cited in argument over
the **pre-litigation privilege**, used to illustrate the intended scope of that
privilege rather than as binding precedent — which is what makes it dicta.
Every element of that is in the documents.

What makes it the strongest moment in the demo:

- **The word "obiter" appears zero times in all 3,338 passages.** Grep the
  corpus and it is not there. The system located the *concept*, not the term.
- **Only hybrid finds it.** Measured: `naive` (vector only) and `graph` both
  return eight passages, and the answering passage is in neither.
- **It arrives in slot 8 of 8** — the very last one, tagged
  `vector#21 density#3`. Plain similarity ranked it **#21 of 3,338**. A
  vector-only top-8 misses it by thirteen places.

The fusion, exactly as it happened:

| Slot | Document | Cosine | Channels |
|---|---|---|---|
| 1–4 | four different filings | 0.295–0.301 | `vector#1–4` `reserved` |
| 5 | 1332.10 p.46 | 0.301 | `vector#5` `density#1` `lexical#5` |
| 6 | 1332.10 p.36 | 0.308 | `vector#11` `density#2` |
| 7 | 1328.4_1 p.9 | 0.309 | `vector#14` `density#4` |
| 8 | **1332.10 p.47** | 0.311 | **`vector#21` `density#3`** |

The graph channel **abstained** — no name to anchor on — and said so rather
than falling back. Retrieval took 9.3 s, nearly all of it the query-widening
LLM call, which succeeded on this question.

Say out loud: *four slots are reserved for plain similarity so fusion can never
subtract. The answer came from one of the four it added.*

---

## Multi-entity — what the graph does that a vector cannot

**Q.** What did Virginia Giuffre say about Ghislaine Maxwell and Jeffrey Epstein
in her deposition?
**Strategy:** `graph` · **Status:** verified (traversal counts only)

**4,253 mentions across 2,693 passages.** A single query vector cannot express
"both X and Y" — embedding the phrase yields one point that resembles a blend
of the two, not the intersection.

This question is also the one that exposed the traversal cap: before the fix,
ranking saw 1,722 of those 2,693 passages, and six of forty-four linked
entities got no edges at all.

---

## The honest limitation

**Q.** Which courts appear in these filings?
**Strategy:** `graph` · **Status:** expected

Falls back — there is no single name to start from. This is the gap ArangoDB's
**Global Search** closes, and slide 03 says so. Showing your own system's weak
spot and naming their feature as the answer is a stronger move than hiding it.

---

## Held in reserve

Only if there is time or a specific question invites it.

- **Which organizations are associated with Jeffrey Epstein?** — aggregation,
  where similarity has nothing to rank. `expected`.
- **What did the FBI do in this investigation?** — organization anchor rather
  than a person. `expected`.

---

## Before the room

- [ ] ArangoDB up — `curl -s localhost:8529/_api/version`
- [ ] Ollama up — `curl -s localhost:11434/api/tags | head -c 60`
- [ ] `npm start` from `node/`, then `http://localhost:3000/ask.html`
- [ ] **Warm the model with one throwaway question.** A cold load adds ~10 s.
- [ ] Nothing else talking to Ollama — it serialises, and a queued request turns
      an 8-second answer into 75 seconds.
- [ ] ArangoDB web UI open on a second tab with the named graph already created.
- [ ] Never click "load full graph" — 2,014 vertices and 19,009 edges will crawl.
