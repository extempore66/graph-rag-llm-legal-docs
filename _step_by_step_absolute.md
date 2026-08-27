# Graph RAG LLM — Step-by-Step Recap

**Prompt (step1):** we import the files (PDF). For this we use src/server.js and src/processFile.js. Correct? Am I missing anything?

**Answer:** Correct on the entry point, but missing the workhorses underneath. Full Step 1 file list:

- `server.js` — Express `POST /upload` endpoint
- `processFile.js` — orchestrates: extract → chunk → embed → write LanceDB → write ArangoDB
- `pythonExtractor.js` — spawns the Python subprocess
- `python/extract_and_chunk.py` — actual PDF text extraction/chunking (PDF parsing happens in Python, not Node)
- `chunkId.js` — builds the shared `chunk_id`
- `config.js` — all infra config (Arango/LanceDB connection, paths)
- `progressBus.js` — in-app progress events for the UI

So: server.js/processFile.js are the right *entry point*, but PDF parsing itself is Python, called as a subprocess.

---

**Prompt (step 2):** Now we have the chunks, the embeddings in je_chunks tables in ArangoDB and the same table in LanceDB. Now we go to rawExtractions.js which goes to LanceDB, reads each chunk and on each read it calls the deterministic regex or function to get the case numbers and dates. On the same chunk reading and calling those functions there is also a call to the qwen LLM in Ollama with the respective prompt and the simulated conversation (inside the prompt) to infer entities and also - if word is adjacent to entity - it becomes candidate role. All this information is stored in je_raw_extractions in ArangoDB only. Am I right?

**Answer:** Close, one file mix-up: it's `extractionBatchRunner.js` that reads LanceDB per chunk and drives the loop — not `rawExtractions.js`. Correct chain:

1. `extractionBatchRunner.js` — reads `je_chunks` from LanceDB, loops per chunk, skips if `hasRawExtraction()` already true.
2. `entityExtraction.js` — does both the regex (dates/docket) and the Qwen LLM call (with the few-shot "simulated conversation") in one function, `extractChunkEntities()`.
3. `rawExtractions.js` — pure persistence layer only. Doesn't read LanceDB, doesn't call regex/LLM — just writes the combined result to ArangoDB via `writeRawExtraction()`.

Everything else right: result goes to `je_raw_extractions` in ArangoDB only, nothing written back to LanceDB.


**Prompt (step 3):** after first entity in the first chunk processing ... we get the "dumb" string search of textual_evidence with fallback on name, we get the snippets around this first find and embed it. We have nothing to compare it with , we insert this data into je_entities and je_entities_mentioned. (By the way where do we get the je_mentioned_in table? ... still tired brain). So what are the columns in each of these tables and also don't forget mentioning the je_mentioned_in

**Answer:** Quick naming untangle first: je_entity_mentions (LanceDB) and je_mentioned_in (ArangoDB) are two different tables, not the same thing said two ways — easy mix-up when tired.

Your walkthrough is right, with one small addition: since this is the very first entity ever, there are no candidates to compare against, so Step 5 (the LLM judgment call) doesn't even run — it only runs if Step 4 found candidates. No candidates → straight to "genuinely new" in Step 6 → three writes happen:

1. je_entities (ArangoDB, node collection — brand new here)
- _key / _id — the entity_id
- name
- type

That's it, kept deliberately thin — no role/evidence/confidence here, those live on the edge below.

2. je_mentioned_in (ArangoDB, edge collection — this is the one you asked "where do we get it")
- _from — je_entities/<entity_id> (points at what you just created in #1)
- _to — je_chunks/<chunk_id> (points at the chunk this mention came from)
- role
- textual_evidence
- confidence

This is what "gets built" right alongside the entity — same step, right after, using the entity_id that now exists.

3. je_entity_mentions (LanceDB, vector table — the one you're calling "je_entities_mentioned")
- entity_id
- mention_text
- context_snippet
- vector
- entity_type

So: one entity node, one edge, one vector row — all three written for this single first mention, entity written first so the other two have a real entity_id to point at.

---

**Prompt:** elaborate on each column of je_entity_mentions please, very succintly.

**Answer:**
- `entity_id` — links this row back to its `je_entities` node in ArangoDB (which entity this mention belongs to).
- `mention_text` — the literal name string as it appeared *this* time ("Ms. Giuffre," "Virginia Roberts," etc.) — preserves the exact phrasing variant.
- `context_snippet` — the trimmed surrounding text (name/role phrase + nearby words) — the actual thing that gets embedded.
- `vector` — the embedding of `context_snippet` (1024-dim, `bge-large`) — what cosine similarity actually compares.
- `entity_type` — person/org/court — scopes the KNN search so a person mention is never compared against a court mention.

---

**Prompt:** mention_text is the snippet which we still have to determine how to get around the match in the chunk, right?

**Answer:** No — `mention_text` is just the `name` field we already have straight from Step 3's output (e.g. "Ms. Giuffre") — no searching needed, it's already sitting right there in `je_raw_extractions`. The thing still undetermined (how many words around the match) is `context_snippet` — the *separate* column that actually requires locating the mention in the chunk text and grabbing surrounding words. `mention_text` = the bare name, already known. `context_snippet` = the surrounding text, still to be built.

---

**Prompt:** oh I remember, we are allowing for the possibility of matching Christine Walts with the "defense attorney in this case" (which might be the textual_evidence) or maybe I am mixing it again. So Chrsitine Walts might have been saved before in je_entity_mentions from another chunk, but the raw extractions found her name in this chunk somehow plus the contextual_evidence and we are now associating defense counsel with Ms Walts or something like that

**Answer:** You've basically got it, just one flip to fix: in this scenario, the current chunk does **not** contain her actual name at all — that's the whole point. If it did, Jaro-Winkler alone would already catch the match and we wouldn't need embeddings.

Corrected walkthrough:

- **Earlier chunk (already processed):** text explicitly says "Christine N. Walz, representing defendant..." → entity created, `je_entities` gets a node for her, `je_entity_mentions` gets a row: `mention_text: "Christine N. Walz"`, snippet something like "Christine N. Walz, representing defendant, docket 447706".
- **Current chunk:** text only says "defense counsel argued that..." — her name is never restated here, just her role. Step 3 has zero memory of other chunks, so it can't resolve "defense counsel" back to her name — it just extracts `name: "defense counsel"` as-is, since that's all this chunk gives it.
- **Step 4 candidate search for this mention:** Jaro-Winkler compares `"defense counsel"` against `"Christine N. Walz"` — zero similarity, finds nothing. But the embedding channel compares *snippets*: "defense counsel, representing defendant, docket 447706" vs. the stored snippet from before — high similarity, since role + case number overlap even though the name is missing. This surfaces her `entity_id` as a candidate.
- **Step 5:** LLM sees the candidate's known facts (her stored name, role, case number) and judges "same entity." — `dedupJudgment.js`
- **Step 6:** the vague "defense counsel" mention gets merged onto her *existing* `entity_id` — no new entity created, just a new edge (`role: counsel`, `textual_evidence: "defense counsel"`) added onto the same node, and a new `je_entity_mentions` row (`mention_text: "defense counsel"`) also tagged with her `entity_id`. — `dedupBatchRunner.js` (orchestrates the match-or-create decision), `entities.js` (`createEntity`, `writeMentionedInEdge`), `entityMentions.js` (`writeEntityMention`)

So yes — you land in the right place, "defense counsel" ends up associated with Ms. Walz — just via the embedding channel catching what string comparison couldn't, not because her name showed up again.

---

**Prompt:** re-explain this new algorithm/flow to me especially the pre-filter, then the actual deduplication, and document it here.

**Answer:** The real-corpus dedup run kept flooding `je_possible_duplicates` with noise: the embedding channel (Step 4) was nominating things like "Ghislaine Maxwell" as a candidate for "Jeffrey Epstein" — zero name-level connection (Jaro-Winkler ~0.44-0.57), just two names that constantly co-occur in the same dense sentences. Every one of those burned a Step 5 LLM call and came back "unsure" instead of "different."

**The pre-filter (new file, `nameUtils.js`, shared by Steps 4 and 5 so they can't drift apart):**
- `looksGeneric(name)` — is this a role-phrase ("defense counsel," "the court") rather than a specific name?
- `looksRelated(nameA, nameB)` — true if the two names share a whole word (`sharesToken`), or one is a plausible acronym/initialism of the other (`acronymRelated`, e.g. "FBI" / "Federal Bureau of Investigation").
- `tokenize(name)` — the word-splitter both of the above sit on. Strips `NON_IDENTIFYING_TOKENS` (structural words, honorifics/ranks, corporate suffixes, court scaffolding) so shared filler doesn't count as a shared word. See the correctness-fix section below for why this was added.

`embeddingCandidates()` in `dedupCandidates.js` now filters every embedding-channel match: keep it if either name is generic (that's the legitimate Christine Walz case above — low string similarity there is *expected*, not noise), otherwise keep it only if `looksRelated` says so. The Jaro-Winkler channel is untouched — string similarity was never the noisy channel. Verified on a 200-chunk real-data test run: every possible-duplicate flag the filtered candidate list produced was a legitimate token/acronym-related pair (e.g. "LAP" / "Case 1:15-cv-07433-LAP", "FBI" / "Federal Bureau of Investigation"); zero pure-noise pairs like the Maxwell/Epstein case.

**The other change: concurrency, in `dedupBatchRunner.js`.** Entities used to resolve strictly one at a time (~31s/chunk on the real corpus — multi-day for the full backlog). Now up to `DEDUP_CONCURRENCY` (3, in `config.js`) resolve at once via a dependency-free worker pool (`runWithConcurrency`) — roughly 2x faster in practice (~15s/chunk on the 200-chunk test). The tradeoff was a "late arrival" race: two workers independently resolving the same not-yet-created entity at the same instant, both seeing an empty candidate list, both creating a node. Originally accepted deliberately, with a cleanup pass deferred. **Superseded — the race is now closed by `asyncLock.js`; see the correctness-fix section below.**

**Files, Steps 4-6, current state:**

- Step 4 (candidate generation): `dedupCandidates.js`, pre-filter logic in `nameUtils.js`
- Step 5 (LLM judgment): `dedupJudgment.js`
- Step 6 (merge/write) + concurrency orchestration: `dedupBatchRunner.js`, persistence in `entities.js` and `entityMentions.js`
- Entity-creation mutex: `asyncLock.js`
- Config: `DEDUP_CONCURRENCY`, `JARO_WINKLER_THRESHOLD`, `SNIPPET_WINDOW_WORDS` all in `config.js`

---

**Prompt:** the full-corpus run produced 9.6% duplicate entities, way over the ~1.4% predicted. What was actually wrong?

**Answer:** Four separate defects, all invisible at 200-chunk scale, all found by auditing real full-corpus output rather than by reading code.

**1. Unsorted candidate slice — `dedupCandidates.js`, `jaroWinklerCandidates()`.** `.filter(score >= 0.85).slice(0, 5)` with no `.sort()` in between. Returned an arbitrary 5 of everything above threshold, not the best 5. On a corpus dense with honorific names, 80–130 names clear 0.85 for a single probe, so the exact 1.000 self-match was routinely crowded out. Step 5 then saw five wrong people, correctly judged them all "different", and Step 6 created yet another node — 38 separate "Mr. Barton" nodes by the end. Scales with entity count, which is why a 200-chunk test never surfaced it. Fix: `.sort((a, b) => b.score - a.score)` before the cap.

**2. Case-sensitive comparison — same function.** The `jaro-winkler` package defaults to case-sensitive. `"SOUTHERN DISTRICT OF NEW YORK"` vs `"Southern District of New York"` scored **0.517**, never became a candidate. Court captions and deposition transcripts are full of ALL-CAPS names, so this cost 110 nodes (5.6% of the graph) plus 35 of 240 possible-duplicate flags. Fix: `{ caseSensitive: false }` — those pairs now score 1.000.

**3. Shared filler words — `nameUtils.js`, `tokenize()`.** Every word counted as identity-bearing, so `"Peter Guirguis, Esq."` matched `"Bradley Edwards, ESQ."` on `"esq"`, and every "X of Y" name matched every other on `"of"`. Fix: strip `NON_IDENTIFYING_TOKENS` before comparison. Also a throughput win — those pairs each burned an LLM call to return "unsure".

**4. LanceDB cold-start race — `entityMentions.js`.** `tableNames()` then open-or-create is check-then-act; under concurrency 3 the table could report present while its `_versions` directory was uncommitted. Cost one chunk per full run. Fix: an in-process creation promise, plus the same open-inside-try treatment on `searchSimilarMentions`.

**And the entity-creation race itself — `asyncLock.js` (new).** `withLock(key, fn)` serialises `findCandidates → judgeCandidates → createEntity` per `name+type`. Node is single-threaded, so this is not a memory lock: the workers are concurrent async chains, code between two `await`s is already atomic, and the race lives only *across* await points. The lock is a promise chain per key — acquiring means awaiting the previous holder. Different names never contend.

Deliberately **not** a unique DB index on `(name, type)`: that would force two genuinely different same-named people into one node, taking a decision that belongs to Step 5. The race is wrong because nobody judged; a second node for a same-named different person is correct *because* the LLM judged. An index can't tell those apart; a lock only orders work.

**One more, found while benchmarking — `rawExtractions.js`, `getUnprocessedForDedup()`.** No `SORT` clause, so ArangoDB returned storage order and "the first 200 unprocessed chunks" meant a different 200 every run. Silently invalidated a parallelism benchmark (the two arms drew slices of 570 and 1079 entities). Fix: `SORT d._key`.

**Measured result, full corpus, v2 → v3:**

|                             | before      | after     |
| --------------------------- | ----------- | --------- |
| wall clock                  | 1,162.7 min | 907.4 min |
| failures                    | 1           | 0         |
| entities                    | 1,947       | 1,816     |
| mentions                    | 17,556      | 17,557    |
| possible-duplicate flags    | 240         | 177       |
| exact redundancy            | 33 (1.7%)   | 3 (0.17%) |
| case-insensitive redundancy | 110 (5.6%)  | 5 (0.28%) |

131 fewer nodes for the same mention count — fragmentation consolidated, nothing lost. Faster despite doing strictly more real judgment work, because fix 3 stopped paying for noise pairs.

**Ollama parallelism, measured not assumed.** `OLLAMA_NUM_PARALLEL=2` against the identical slice: 35.6 min vs 36.2 min — 1.7%, inside noise. Not adopted. The pipeline isn't purely GPU-bound: the embedding runner never parallelizes, the Jaro-Winkler scan is single-threaded JS, and the lock serialises same-name work.

---

**Prompt:** we still have "Jeffrey Epstein" / "Mr. Epstein" / "Epstein" as three nodes. What is Step 7?

**Answer:** Coreference resolution — a separate pass over the finished graph, not part of the dedup run.

The diagnosis matters more than the fix. Those pairs were **not** missed by Step 4; they reached Step 5 and came back "unsure". Proof that no threshold tuning helps: the v2 flag table contained both `"Ms. Maxwell" <-> "Maxwell"` (same person) and `"baron Robert Maxwell" <-> "Maxwell"` (her father) — identical surface shape, opposite correct answers. When two inputs are indistinguishable in a representation but need different outputs, the deciding information isn't in that representation. Only a larger frame recovers it. So Step 7 moves from **pairwise** to **cluster**: what separates Ghislaine from her father is that one is a defendant across hundreds of filings and the other appears twice in a background passage — mention volume and role distribution across the whole name-family.

- `corefClusters.js` — `buildClusters()` groups entities by shared identity token, scoped by type, no transitive union (union chains "Virginia Giuffre" → "Robert Giuffre" → unrelated people). Tokens shorter than 2 chars are skipped. `tokensConflict()` is the deterministic guard.
- `corefJudgment.js` — `partitionCluster()`, one schema-constrained LLM call per cluster. Returns a `group_id` per member, positionally, never names or IDs — same discipline as Step 5.
- `corefRunner.js` — orchestration, `COREF_CONCURRENCY` (3), writes edges, logs to `logs/coref_failures.jsonl`.
- `entities.js` — `getEntitiesWithEvidence()` (mentions, distinct documents, role distribution, sample evidence per entity), `writeSameAsEdge()`.

**`je_same_as` (ArangoDB, edge collection — new):**

- `_key` — `<fromKey>_<toKey>`, deterministic so re-running the pass overwrites rather than duplicates
- `_from` / `_to` — `je_entities/<id>`, written in **both** directions so retrieval reaches every surface form in one hop
- `cluster_token` — the shared word the cluster was built on
- `cluster_group` — the LLM's group id within that cluster
- `reason`, `linked_at`

Non-destructive on purpose: nothing merges, nothing is deleted. Legal provenance requires the surface form a document actually used to stay recoverable, an edge is reversible where a merge is not, and every decision stays auditable.

**`tokensConflict()` — the guard, and what live testing taught it.** Base rule is subset compatibility: `{epstein}` ⊂ `{jeffrey, epstein}` may corefer; `{ghislaine, maxwell}` vs `{robert, maxwell}` conflict. Two amendments, both from real data:

- *Single letters are initials, not competing identifiers.* The naive version blocked `"G Maxwell"` (431 mentions) from `"Ghislaine Maxwell"`. A one-char token conflicts only if nothing on the other side starts with it — which still blocks `"G Maxwell"` vs `"Robert Maxwell"`.
- *Digit-bearing tokens are discriminators, never elaborations.* The first live run merged `"Jane Doe 3"` into `"Jane Doe"` and `"Jane Doe #1 and #2"` into `"Jane Doe 2"` — distinct pseudonymous plaintiffs collapsed into one person. Subset alone reads `{jane, doe, 3}` as "Jane Doe, elaborated", right for `"Epstein"`/`"Jeffrey Epstein"` and badly wrong for a numbered pseudonym or a Bates stamp. Highest-stakes check in the file.

Guard-blocked pairs are written as review flags to `je_possible_duplicates`, not discarded.

**Known limitation, unresolved:** organization/court clusters produce false merges a token guard can't catch — `"Royal Palm Beach Police Department"` == `"Palm Beach Police Department"` (different towns), `"New Mexico"` == `"Santa Fe, New Mexico"` (state vs city), `"Palm Beach"` == `"Palm Beach mansion"` (place vs building). Subset compatibility assumes extra tokens elaborate; for place-derived names they often discriminate, and telling those apart needs to know "Royal" makes a different municipality while "Jeffrey" doesn't make a different person. Root cause is the Step 3 enum having no `location`/`facility` type, so places are forced into `organization`. Step 7 inherits and amplifies that type error. **Addressed by the taxonomy change below; Step 7 was held at 6 test clusters rather than run in full, since the re-run replaces the graph it would operate on.**

---

**Prompt:** Step 7 keeps mis-merging places. Is the entity type enum the real problem, and is it worth a re-run to fix?

**Answer:** Yes to both. The audit evidence, from the finished v3 graph:

**1. 68 names carry two or more types.** `"county of palm beach"` is both `court` and `organization`; `"abernathy"` is `court`, `organization` and `person`. This is the finding that forced the change, because **type is a hard partition in every downstream step** — `getEntitiesByType` scopes Jaro-Winkler, `searchSimilarMentions` scopes the vector search, `buildClusters` scopes coreference. A name typed inconsistently lands in disjoint pools and can never be merged by any pass, at any threshold. Those 68 were structurally unreachable.

**2. Places forced into `court`,** because courts are named after jurisdictions: `State of Florida` (17 mentions), `New York` (14), `Palm Beach County` (9), `County of Miami-Dade` (6), `United States Virgin Islands` (5).

**3. Addresses and objects forced into `organization`:** `One Florida Park Drive South Suite 214 Palm Coast, Florida 32137`, `12959 Rackley Road, Loxahatchee, Florida 33470`, and `2004 black Chevy Suburban` — a vehicle typed as an organization.

**4. Role placeholders split across types:** `Defendant` = 280 `organization` + 38 `person` + 3 `organization`; `Plaintiff` = 99 `organization` + 88 `person`. Over 500 mentions on meaningless nodes that could not even consolidate with themselves.

**5. Reference leakage:** `Case 1:15-cv-07433-LAP` as a `court` with 71 mentions; the Bates stamp `GIUFFRE000046` as a `person` with 14.

**The non-obvious part: adding types alone would have made this worse.** Every new box is another chance the model picks a different one for the same name in a different chunk — which is precisely defect 1. A richer enum only pays off paired with relaxed scoping. Both changes were made together.

**What changed:**

- `entityExtraction.js` — enum is now `person, organization, court, location, facility, reference`. GPE and LOC are deliberately merged into one `location` rather than split OntoNotes-style: the political-actor-vs-geography distinction almost never changes an answer for this corpus, and it would double the decision burden for no gain.
- `entityExtraction.js`, `SYSTEM_PROMPT` — type definitions listed in check order, with the two observed confusions named outright ("a court is an institution, NOT the place it is named after"; "a police department is an organization, not a location and not a court"). Generic party phrases (`Defendant`, `Plaintiff`, `the Court`, `defense counsel`) are forced to `person`, with an explicit instruction not to let the word "Court" pull toward type `court`.
- `entityExtraction.js`, `REFERENCE_SIGNAL_PATTERN` — extended with `\bCase\s+\d+:\d+-[a-z]{2}-` and `[A-Z]{3,}\d{4,}` for case captions and Bates stamps. Second layer on purpose: the prompt says it, the regex verifies it, because the model's own `reference` tagging is not self-consistent.
- `config.js` — `comparableTypes(type)` and the `TYPE_GROUPS` table. `person` is alone; `court`/`organization`/`location`/`facility` share a candidate pool. Applied in all three places type acts as a partition: `entities.js` (`getEntitiesByType`), `entityMentions.js` (`searchSimilarMentions`), `corefClusters.js` (`buildClusters`).
- `config.js` — `ARANGO_RAW_EXTRACTIONS_COLLECTION` and `ARANGO_ENTITIES_COLLECTION` made env-overridable, so a schema change can be trial-run into a scratch collection before the real extraction is destroyed.

**Why no `role` type,** though role phrases are ~500 mentions of noise: it would break the Christine Walz mechanism. `defense counsel` has to be able to search against `person` candidates to resolve onto her node, and a separate type would put it in its own pool. Typing role phrases as `person` is also semantically right here — in this case the defendant *is* a person.

**Cost:** the type is baked into the extraction schema, so this re-runs from Step 3. Step 1 (`je_chunks`, embeddings) is untouched. Estimated ~6 h extraction + ~15 h dedup + ~30 min coref.

**Measured result: PENDING.** Validated first on a 200-chunk trial extraction into `je_raw_extractions_test`, before committing to the full run. What the trial has to show: places landing as `location`/`facility` rather than `court`/`organization`, `Defendant` consolidating as `person`, captions and Bates stamps gone, and no collapse in overall extraction quality. If qwen ignores the new types and keeps answering `court`, the prompt needs work before any 22-hour commitment.

---

**Prompt:** did the type re-extraction actually work? The section above still says PENDING.

**Answer:** It worked, and the PENDING is now resolved. The full graph as it stands:

| type | entities |
|------|---------:|
| person | 916 |
| organization | 481 |
| location | 302 |
| facility | 203 |
| court | 112 |
| **total** | **2,014** |

`location` and `facility` hold 505 entities between them — a quarter of the graph that previously had nowhere correct to go and was being forced into `organization` or `court`. That is the defect the re-run existed to fix, and the numbers say it was real rather than theoretical.

Graph totals: 3,338 chunks, 3,338 raw extractions, 19,009 `je_mentioned_in` edges, 2,014 entities, 488 `je_same_as` edges, 413 `je_possible_duplicates` flags awaiting human review.

---

**Prompt:** how did the full Steps 4-6 run go?

**Answer:** 3,338 of 3,338 chunks, zero failures, zero orphan edges, 1,188.4 minutes (19.8 hours). 19,009 mentions collapsed onto 2,014 entities.

Two things worth carrying forward:

**It is the most expensive stage in the pipeline** — more than extraction. The cost scales with *mention* count, not chunk count, because every mention runs a candidate search and possibly an LLM judgment. This is why ArangoDB's managed Importer cannot casually add such a stage (see `arango_llm_rag_details.md`).

**A throughput mystery that was a laptop, not a bug.** Instantaneous rate was 4.0 chunks/min while the lifetime rate was 2.14. The gap was the machine sleeping on battery. Diagnosed from the discrepancy between the two rates rather than from any log line, and fixed with `caffeinate -i -w <pid>`. Worth remembering: on a multi-hour local run, a rate that is fine when observed and bad on average means the process was not running the whole time.

---

**Prompt:** Step 7 wrote wrong links in the smoke test. What happened and what did we change?

**Answer:** The smoke test wrote 11 wrong links out of 14. The run was stopped, the 28 edges deleted, and the cause traced to one rule.

`tokensConflict` in `corefClusters.js` implements a **subset rule**: if A's tokens are a subset of B's, treat the extra tokens as elaboration and allow the merge. For persons that is right — `Giuffre` ⊂ `Virginia L. Giuffre` is the same person elaborated. **For places it is inverted**: the extra token usually *discriminates* rather than elaborates. `Palm Beach Police Department` ⊂ `Royal Palm Beach Police Department` is two different municipalities. `New Mexico` ⊂ `Santa Fe, New Mexico` is a state and a city.

Telling those apart requires knowing that "Royal" makes a different town while "Jeffrey" does not make a different person — which is world knowledge the token rule does not have.

**The fix was scope, not cleverness.** `corefRunner.js` gained a `--type` filter, and Step 7 was run over persons only: 297 clusters, 18.5 minutes, 488 edges, zero failures. Maxwell (1,480 mentions), Epstein (1,490) and Giuffre (890) each unified across their surface forms, while **Robert Maxwell was correctly held apart from Ghislaine Maxwell** — the exact pair that made the old pairwise frame provably insufficient.

Place and organisation coreference remains **deferred, not solved.** Making the subset rule type-aware is the open work.

---

**Prompt:** is a bigger local model better for the dedup judgment?

**Answer:** Measured, not assumed, and the answer was no.

`qwen3:30b-a3b-instruct` was pulled and A/B'd against `qwen3:8b` on hand-labelled gold pairs weighted toward false-merge traps (`eval/dedupModelAB.js`, which mirrors Step 4's channel labelling so the real guard code runs). Results: **8b scored 15/16 and 12/15 where 30b scored 11/16 and 7/15**, at the same latency and a third of the memory.

The reason is architectural: `30b-a3b` is a mixture-of-experts model with roughly 3B *active* parameters. It is a 30B download, not 30B of thinking per token.

A proposed prompt amendment was also tested and **made both models worse** (8b 12/15 → 10/15). It was reported as a failure and abandoned rather than iterated on.

---

**Prompt:** what does Step 8 actually consist of now?

**Answer:** Four retrieval modules in `node/src/retrieval/`, all returning the same row shape so `answerGenerator.js` consumes any of them without knowing which produced it. That interchangeability is what keeps the comparison honest — the only variable between strategies is which chunks were chosen.

**`naiveRetriever.js`** — dense vector search over LanceDB. The baseline.

**`hybridRetriever.js`** — four channels, each searching the whole corpus, fused by Reciprocal Rank Fusion. Deliberately *not* retrieve-then-rerank: a reranker can only reorder what stage one returned, so anything ranked badly first is unrecoverable.

- *vector* — best chunks by cosine.
- *density* — documents with the most chunks in the pool, represented by their own best chunks. Catches a long transcript where every chunk is moderately relevant and none is outstanding.
- *lexical* — BM25 in-process over an LLM-expanded query. This is the channel that handles jargon: the corpus contains **zero** occurrences of "obiter", "dicta" or "dictum", but 35 chunks containing "held that". Expansion translates the Latin into the phrasing a filing actually uses.
- *graph* — added last, see below.

**RRF** fuses by `Σ 1/(RRF_K + rank)`, reading only rank order, so cosine distance, a chunk count and an unbounded BM25 score combine without invented weights. Half the top-k slots are nonetheless **reserved for plain vector**, because equal-weight fusion once broke a question it had previously answered: density outvoted the channel that was right. Reserving slots makes hybrid a strict improvement on naive — it can add, never subtract.

**`graphRetriever.js`** — entity-anchored retrieval. See the next entry.

---

**Prompt:** where is the LLM in graph retrieval, if the graph needs an entry point?

**Answer:** The LLM is at **build time and answer time, never in the retrieval path.**

Build time: the LLM read the prose and produced the entities (Step 3), judged which mentions were the same entity (Step 5), and partitioned the name families (Step 7). Answer time: it composes the cited answer. The traversal between those two is deterministic AQL and runs in 30-91 ms.

The entry point is found by **string matching the question against the entity index**, not by an LLM call. Multi-token names must match on more than one token, because one shared token between two multi-token names is a coincidence rather than a reference.

The chain: link entities named in the question → expand each one hop over `je_same_as` into its coreference family → collect chunks via `je_mentioned_in` → rank by how many *distinct seed entities* a chunk covers, then by mention count.

That ranking rule is the thing a query vector cannot express: "filings mentioning both Maxwell and Epstein" embeds as one point resembling a *blend* of the two, not the set containing both.

**There is no entity-to-entity traversal**, because no relationship edges exist — Step 9 was deferred. A second hop over what we have would cross "co-mentioned in the same chunk", which in this corpus is near-meaningless: Step 4 already measured that Maxwell and Epstein co-occur constantly. So this is a coreference-resolved entity index over chunks, not a relationship graph, and for a corpus whose hard problem was identity rather than relations that was the right place to spend the effort.

---

**Prompt:** what is the fallback, and why does it matter so much?

**Answer:** When a question names no known entity and matches no recognised category, `retrieveGraph` returns vector results and records `graph_path.fallback = true` with the reason.

It is recorded rather than hidden for two reasons. A strategy that silently returned nothing would look artificially precise in the eval while being useless in the product. One that fell back quietly would take credit for the vector channel's work.

**The fallback rate is itself a finding: 11 of 35 eval questions**, concentrated in the `aggregation` and `completeness_counting` strata — "which courts appear in this corpus", "how many distinct people are attorneys". Those name nothing, so there is nothing to anchor on. It measures how much of a question set is entity-shaped.

This is also precisely the gap ArangoDB's **Global Search** addresses by reading pre-computed community summaries instead of traversing from an entity. We have no equivalent.

**Type linking** covers the narrower case: a question saying "which courts" links entities of type `court` (112 of them) or `organization` (481). `person` is deliberately excluded — at 916 of 2,014 entities it is most of the graph, and anchoring on it would return everything. A type is a usable anchor only when it is small and well defined.

---

**Prompt:** graph is now a fourth hybrid channel. Anything subtle in that?

**Answer:** One decision that is easy to get wrong.

When the question is unanchored, the graph channel **abstains with an empty list** rather than falling back to vector. Falling back would feed the vector ranking into RRF a second time under a different channel name — not a fallback but double-counting, silently doubling vector's voting weight on exactly the questions where graph contributes nothing.

Two supporting details: `resolveGraph()` is shared by the standalone strategy and the channel, so the two cannot drift apart and make an eval measure the drift instead of the fusion; and graph chunk ids are filtered against the LanceDB corpus first, because a few chunks exist as graph anchors in ArangoDB without a LanceDB row and would otherwise hydrate into a row with no text.

Verified live: an anchored question nominated 50 chunks with one surviving into the top 8; an unanchored one nominated zero and the other three channels decided.

---

**Prompt:** how do I actually use the thing?

**Answer:** `POST /ask` on the existing Express server, plus `node/public/ask.html`.

Until this existed, the four retrieval modules could only be driven by `runEval.js` — which reads a fixed question file and writes JSONL. A measurement harness, not a way to use the system. Same server as ingestion rather than a second process, because both share the same LanceDB and ArangoDB connections and the same config.

The page shows the traversal, not only the prose: linked entities with mention counts, the coreference families they expanded into, per-source channel provenance, and an explicit amber banner when graph fell back. Amber rather than red on purpose — falling back is correct behaviour, not an error.

**Operational note:** Ollama serialises generation. A query issued while an eval run is in flight queues behind it and took 75 seconds instead of a few. Do not run an eval while demonstrating.

---

**Prompt:** what has actually been measured, and what has not?

**Answer:** Worth being blunt about, because the distinction is easy to lose.

**Measured, objectively:** which chunks each strategy retrieved, which documents, cosine distances, which channels fired, traversal paths, fallback rate, citation counts and rates, invalid citations, `answered_from_context`, truncation, and latency split into retrieval and generation.

**Not measured:** correctness. There are no relevance labels, so no recall@k, no nDCG, no MRR. `human_correct` and `human_notes` are `null` in every row.

That is a deliberate validity choice, not laziness: real relevance labels need a human reading the source PDFs, and an LLM-generated gold set would make both systems' scores a function of one model's reading of the corpus. What exists instead measures *difference* — inter-strategy document overlap, disagreement, fallback rate. It establishes the strategies behave differently, not which is right.

The cheap next step is an **answer-in-context rate**: for extractive questions, check whether the expected answer string appears anywhere in the retrieved text. One label per question instead of thousands, and it splits the error cleanly — string present but answer wrong is a generation bug, string absent is a retrieval bug. Not built.

See `LLM_metrics_explained.md` for the full vocabulary and `node/eval/KNOWN_LIMITATIONS.md` for what is known broken — chiefly **abstention**: asked something the corpus cannot answer, the system describes what the corpus does contain and presents that as an answer. Four fixes were attempted and all four failed. The answer is faithful to its sources and non-responsive to the question, which is why prompt-level grounding instructions cannot touch it.
