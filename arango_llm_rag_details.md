# ArangoDB's native GraphRAG — how it works

Researched 2026-08-25, **substantially revised 2026-08-26** after reading the
official documentation first-hand.

A note on provenance, because it changed the confidence of nearly everything
below. The first pass was assembled from search-result summaries: the two most
important pages (the GraphRAG Technical Overview and the Importer reference)
returned HTTP 403 to automated fetching, so the architecture was reconstructed
rather than read. On 2026-08-26 the user supplied direct links and the pages
were opened in a real browser, which the bot filter allows. **The pipeline,
parameter, and retrieval sections below are now quoted from ArangoDB's own
documentation.** Where something remains inference, it says so explicitly.

## The pipeline

Their Technical Overview states the workflow in four steps:

1. **Chunking** — breaking raw documents into text chunks.
2. **Entity and relation extraction** — LLM-assisted description of entities and
   relations. Entities are inserted as **nodes with embeddings**. Relations
   become edges, of three kinds: entity-entity, entity-chunk, chunk-document.
3. **Topology-based clustering into mini-topics ("communities")** — each entity
   points to its community; each community points to its higher-level community,
   so mini-topics roll up into major topics.
4. **LLM-assisted community summarization** — a summary per community, built
   from all information available about that topic.

Two services deliver this. The **Importer** is the entry point: raw file in,
Knowledge Graph in ArangoDB out. The **Retriever** queries that graph.

Structurally, steps 1 and 2 are the same first move we made: an LLM reads
unstructured text and produces graph structure. Steps 3 and 4 are the divergence
— see below.

### Where the LLM sits

Both privately and publicly hosted. Two supported paths:

- **Self-hosted via Triton Inference Server**, for air-gapped or
  strict-data-governance deployments — runs both the chat model and the
  embedding model on your own hardware.
- **Any OpenAI-compatible endpoint** — OpenAI, OpenRouter, Gemini, Anthropic, or
  a corporate self-hosted model.

Worth noting for the presentation: our Ollama-on-a-laptop setup is the same
architectural choice as their Triton path — local inference for data that cannot
leave. We just did it with far cheaper machinery.

## Community detection — the part we do not have

Beyond entities and relationships, the Importer forms **hierarchical
communities** and has an LLM write a **community report** for each one, stored as
a first-class artifact and (by default) embedded — `enable_community_embeddings`
defaults to `true`, while chunk and edge embeddings default to `false`. That
default ordering is itself a statement of what they consider the primary
retrieval surface.

This is the mechanism behind Global Search, and it is the piece our architecture
lacks entirely.

## Retrieval: five methods, not two

The earlier version of this document described two retrieval modes. The
Retriever documentation lists **five**:

| Method | `query_type` | Best for | Latency |
|--------|--------------|----------|---------|
| Global Search | 1 (GLOBAL) | themes, patterns, high-level insight | medium |
| Local Search | 2 (LOCAL) | specific entities and relationships | low |
| Deep Search | 2 (LOCAL) + `use_llm_planner: true` | detailed multi-step research | higher |
| Unified / Instant Search | 3 (UNIFIED) | fast answers with document references | low |
| Custom Retriever | 4 (CUSTOM) | domain-specific logic on custom collections | varies |

The web interface exposes only **Instant Search** and **Deep Search**. Global and
Local are API-only, "for access to all search methods with advanced parameters."

**Local Search** combines the extracted knowledge graph with text chunks from the
raw documents, anchoring on specific entities and walking outward to connected
entities and their relationships. This is close to what our `graphRetriever.js`
does.

**Global Search** answers by searching over all AI-generated community reports in
a **map-reduce fashion**. Their documentation calls it resource-intensive but
says it "often gives good responses for questions that require an understanding
of the dataset as a whole."

**This is the direct answer to our measured gap.** Our graph retriever fell back
to vector search on 11 of 35 eval questions, concentrated in exactly two strata:
`completeness_counting` and `aggregation` — "which courts appear in this corpus",
"how many distinct people are identified as attorneys". Those fail for us because
our retrieval needs a *named entry point*, and a corpus-wide question names
nothing. Global Search sidesteps the problem: you do not traverse from an entity,
you read pre-computed summaries of the whole graph.

Say this plainly in the presentation. This is where our design stops, this is the
published technique that addresses it, and it is the one they have productised.

**Deep Search** is worth a second look too: Local Search with an LLM *planner*
orchestrating multiple steps. That is an agentic loop over the graph, and it is a
different answer to multi-hop than our single-pass traversal.

## `vector_rag` is a first-class mode

A detail with real presentational value. The Importer takes a `rag_mode`
parameter:

- `"full_graphrag"` (default) — entities, relationships, communities.
- `"vector_rag"` — **entity extraction, relationships, and community detection
  are all skipped**; chunk embeddings are force-enabled; you get plain semantic
  search over chunks.

So ArangoDB ships naive RAG as a supported mode of the same product, chosen at
*ingestion* time.

Contrast with ours, and it is a genuine architectural difference rather than a
scoring one: our fallback is a **runtime** decision inside a single retriever.
When a question names no known entity and matches no recognised category,
`graphRetriever.js` degrades to vector search for that question and records
`graph_path.fallback = true` so the fallback rate is measurable. Theirs is a
build-time either/or; ours is a per-question either/or over one corpus.

## Entity resolution — the documented answer (2026-08-26)

This was the open question. It is now answerable from ArangoDB's own reference
documentation rather than by inference from a blog post.

### What the Import Parameter Reference contains

The reference page enumerates the complete Importer parameter surface: file
source, RAG mode, chunking, entity and relationship extraction, custom prompts,
embeddings, vector index, semantic units, graph/sharding, and storage.

**There is no resolution, deduplication, disambiguation, merge, or
identity-matching parameter anywhere in it.**

The entity-extraction group is four parameters, and none of them resolves
identity:

- `entity_types` — default `["person", "organization", "geo", "event"]`
- `relationship_types` — free-form, or left to the LLM's judgment
- `enable_strict_types` — filter extractions to the declared types
- `entity_extract_max_gleaning` — maximum *re-extraction iterations* per chunk
  (default 1). This finds entities that were **missed**; it does not decide
  whether two found entities are the same one.

### The one prompt that looks like resolution, and is not

`custom_prompts` exposes six overridable prompt keys. Five are extraction and
reporting. The sixth is the interesting one:

> `"summarize_entity_descriptions"`: Prompt for combining multiple entity
> descriptions into one.

This is the closest thing in the product to entity merging, and it is worth being
precise about what it does. It **combines descriptions of entities already
treated as the same node**. It presupposes that the identity decision has been
made; it does not make it. Nothing in the documented surface makes it.

The full prompt-key list, for completeness: `entity_extraction`,
`entity_continue_extraction`, `entity_if_loop_extraction`, `community_report`,
`claim_extraction`, `summarize_entity_descriptions`.

### What the merge key probably is — labelled as inference

The parameter and prompt vocabulary is the Microsoft GraphRAG / nano-graphrag
lineage almost verbatim: `entity_extract_max_gleaning`, `claim_extraction`, the
`<|>` / `##` / `<|COMPLETE|>` tuple-record-completion delimiters, and the default
entity types `person, organization, geo, event`. In that lineage, cross-chunk
entity merge is **exact match on the normalised name string**, after which the
accumulated descriptions are LLM-summarised — which is exactly the job
`summarize_entity_descriptions` describes.

**This is informed inference, not documentation.** ArangoDB's docs never state
their merge key. Present it as "consistent with", not as "is", and if it matters
in the room, ask them directly.

### The consequence, stated carefully

On the published evidence, `Ms. Giuffre` and `Virginia L. Giuffre` extracted from
two different chunks become **two nodes**. So do `Southern District of New York`
and `S.D.N.Y.`. So do the 38 separate `Mr. Barton` variants that our own first
full run produced before the candidate-sorting fix.

That is not a claim their product is broken. It is a claim about **where they
chose to spend the LLM budget**: they spend it on community structure — the
corpus-wide, thematic layer — and we spent ours on identity. Both are expensive.
Neither pipeline does both.

## Their published entity-resolution pattern (separate from GraphRAG)

ArangoDB *does* publish entity resolution, but as **an AQL pattern users
implement themselves, not a feature of the GraphRAG pipeline**:

- **Jaccard similarity**, via the built-in AQL array function
- **Hand-assigned attribute weights** — the worked example uses 25 for a deviceID
  match, 15 for an IP address, 10 for a last name
- **2-hop traversal** to find entities sharing attributes
- Results written with `INSERT ... INTO sameAs`; `UPSERT` for probabilistic
  updates
- **No ML, no LLM, no blocking** anywhere in the article

One pleasing convergence: they write into a `sameAs` edge collection. We arrived
at `je_same_as` independently, and non-destructively — nothing merged, nothing
deleted, retrieval resolves the family in one hop.

### Why that pattern does not solve our problem

Weighted Jaccard over shared attributes works when entities carry **structured
fields to compare** — device IDs, IP addresses, postcodes, account numbers. That
is customer-360 and fraud detection, and it is a good fit there.

Our entities are **names in prose**. `Ms. Giuffre` and `Virginia L. Giuffre`
share no attributes whatsoever. What connects them is identity inferred from
context, mention volume, role distribution and document spread — evidence an LLM
can weigh and a Jaccard score has nothing to operate on.

|                 | ArangoDB's documented pattern      | This project |
|-----------------|------------------------------------|--------------|
| evidence        | shared structured attributes       | language and context |
| mechanism       | weighted Jaccard, hand-set weights | LLM judgment + deterministic guard |
| fits            | records with fields                | prose with names |
| edge collection | `sameAs`                           | `je_same_as` |

So the two are **complementary, not competing**: same modelling, different
evidence, different mechanism, different corpus shape.

A methodological contrast worth noting too. Their example assigns weights of
25 / 15 / 10 by hand. Inventing weights is exactly what this project avoided —
Reciprocal Rank Fusion for channel fusion, because it uses only rank *order* and
so needs no weighting across incomparable scales, and a structural token rule in
the dedup guard rather than a tuned similarity score.

## Their stated position on vector vs graph

More moderate in their engineering blog than on their comparison page, and the
blog is the better guide.

They concede vector search wins on **semantic matching when the wording
differs** — their example is retrieving "Adaptive Algorithms for Data-Driven
Decision Making" for a query about "machine learning". And they state that graph
retrieval "struggles with semantic connections based on conceptual meaning rather
than explicit relationships."

That is precisely our AB-01 finding (the obiter dicta question), reached
independently: a purely conceptual question with no entity to anchor on is where
graph retrieval has nothing to offer and dense vector search does. Useful
corroboration — we measured on our corpus what they document generally.

On HybridRAG they are deliberately unenthusiastic: it "can be beneficial and
sometimes necessary", but they argue GraphRAG alone often suffices and that the
additional complexity should be justified per application.

## Cost claims — handle with care

Their comparison page and the "ArangoDB vs. Vector store RAG" video put annual
TCO at **$127,025 for GraphRAG against $205,290 for vector-database RAG** (1 TB
of data, 10K queries/day), the saving resting largely on not recomputing
embeddings.

Two reasons not to repeat this uncritically:

1. It is vendor marketing with unstated assumptions.
2. **It does not transfer to our system anyway** — we use embeddings for chunk
   retrieval and for the dedup candidate channel, so "no embedding maintenance"
   is not a property we share.

## Maturity note

The Technical Overview carries a **"pre-release version"** limitations section.
The generated graph lands in a named graph `{project_name}_kg` with collections
prefixed by the project name. Job history is held in memory per pod, capped at
100 terminal jobs. SmartGraph creation through the Importer currently accepts
only `shard_count: 1`.

None of this is a criticism — it is a young productised pipeline, and knowing it
is pre-release is useful context for how firmly to state anything about it.

## Engine note: C++ vs JVM

ArangoDB is written in C++; Neo4j runs on the JVM. The honest consequences are no
garbage-collection pauses, a lower memory floor, and more predictable tail
latency. Our measured 30-91 ms traversal is *consistent* with a low-overhead
engine.

It is not proof. **We never benchmarked against a JVM graph database**, and the
presentation should say so rather than imply a comparison we did not run.

## Crucial observations — why they do not emphasise disambiguation

> **The question (user, 2026-08-26):** why do they not emphasise disambiguation
> and deduplication?

**It's not an oversight. It's a consequence of what community detection buys
you.**

If your primary retrieval surface is the community summary, entity fragmentation
partly launders itself. `Ms. Giuffre` and `Virginia L. Giuffre` co-occur in the
same text, so they land in the same community. The LLM writing that community's
report reads both descriptions and, in most cases, narrates them as one person in
prose. The summary layer papers over the split. For Global Search, unresolved
identity costs you less than you would think.

**But it does not launder for Local Search** — the entity-anchored mode, the one
that looks like ours. Two nodes means two half-neighbourhoods. You anchor on one,
traverse, and get half the evidence with full confidence and no signal that
anything is missing. That is the failure mode to raise with them, and it should
be raised as a question, not a charge.

**Genre explains most of the rest.** The GraphRAG canon was built for reports,
wikis, product docs, technical documentation. In that genre names are written
consistently — a doc about Kubernetes says "Kubernetes" every time. Coreference
density is low, so name-string merge captures most of it. Legal and investigative
prose sits at the opposite extreme: honorifics, initials, maiden names,
deposition shorthand, ALL-CAPS captions. Their default corpus is close to best
case; ours is close to worst. They optimised for their median customer, and we
are not it.

The Importer's own affordances give the target corpus away more plainly than the
marketing does: the worked chunking example is `["\n## ", "\n\n", "\n"]`, which
the docs recommend "for documents with clear structural boundaries (like markdown
headers)"; every file in a multi-import carries a `citable_url`; semantic units
exist to extract web URLs and image references. That is a markdown-and-web-docs
pipeline described by what it is built to handle.

The difference runs deeper than spelling consistency. Documentation has three
properties this corpus does not:

1. **Names are declared, then reused verbatim** — good technical writing
   introduces a thing and repeats the exact token. The name *is* the identifier.
2. **One authorial voice**, usually working to a style guide, so there is no
   cross-speaker variation.
3. **The entities are mostly concepts and products, not people.** A concept has
   no honorific, no maiden name, no initials, and no formal-caption form distinct
   from how it is spoken aloud.

Our corpus inverts all three: multi-author and adversarial, quoted speech nested
inside transcripts nested inside exhibits, and entities who are people whose
names vary *by register on purpose* — `GIUFFRE, VIRGINIA L.` in a caption,
`Ms. Giuffre` at deposition, `Virginia Roberts` in a 2011 filing, all within one
docket.

One qualifier on all of the above, in fairness: their default `entity_types` is
`["person", "organization", "geo", "event"]`, which is not a documentation
default — it is the Microsoft GraphRAG default, demoed on news corpora and
podcast transcripts. So "their corpus is documentation" is inference from the
tooling, and their stated target is broader. Report- and intelligence-shaped
corpora *do* have the person-naming problem, and those defaults say they are
aiming there too.

**Then there is what demos.** Deduplication is invisible when it works. You
cannot screenshot "these two nodes were secretly one person." Community summaries
demo beautifully — a graph blooming into topics, an answer about the corpus as a
whole. Product surface follows demo-ability, and that is not cynicism, it is how
roadmaps actually get prioritised.

**And the cost is brutal.** Ours was the single most expensive stage in the whole
pipeline: 19.8 hours for Steps 4-6 across 3,338 chunks, 19,009 mentions collapsed
to 2,014 entities — more than extraction itself. A managed service billing per
import cannot casually add a stage whose LLM call count scales with *mention*
count rather than chunk count. Their pricing model argues against it before their
engineering does.

### The sharpest single observation

Their parameter surface has a **recall knob for entities and no precision knob**.
`entity_extract_max_gleaning` exists to catch entities you *missed*. There is
nothing anywhere that asks whether you *double-counted* one. That is a revealed
preference, and it is the cleanest way to say the whole thing in one line.

### The question to actually ask them — and it is not about court filings

Arguing from our corpus invites the easy dismissal: *legal prose is unusually
hard, and you are not our target user.* Both halves of that are true, so do not
hand them the argument.

Ask about **acronyms in their own documentation instead**:

> How does the Importer handle `k8s` versus `Kubernetes`? `AWS` versus
> `Amazon Web Services`? `ADB` versus `ArangoDB`?

Acronym expansion *is* coreference. It is rampant in exactly the technical
documentation the pipeline is built for, and name-string equality fails on it
precisely as hard as it fails on `Ms. Giuffre` — two nodes, split neighbourhoods,
half the evidence returned with full confidence. Note that our corpus produced
the identical failure in the identical shape:
`Southern District of New York` versus `S.D.N.Y.`

Why this framing is the better one:

- It is **their home turf**, so the "your corpus is exotic" reply is unavailable.
- It is **a genuine question, not a critique.** If they have an answer, we learn
  something about the internals the documentation does not describe — which is
  exactly the gap flagged in the honesty check below.
- If they do not have an answer, this project's most expensive stage has just
  become relevant to their roadmap, without anyone having to argue that court
  filings are difficult.

### The honesty check before saying any of it

Two things that will get caught if they are not said first:

1. **Absence from documentation is not absence from implementation.** It is much
   stronger evidence now — it is the complete parameter reference, not a blog
   post — but it is still an argument from silence about internals.

2. **"We do resolution, they don't" is too clean, and it is not true of us
   either.** We resolved *persons*. Step 7 ran on 297 person clusters. We found
   the `tokensConflict` subset rule is inverted for places, stopped the run,
   deleted 28 bad edges, and deferred place and organisation coreference
   entirely. It is still deferred. If someone asks "does it work for locations",
   the answer is no — we scoped it to people on purpose after the smoke test
   wrote 11 wrong links out of 14.

The defensible framing is narrower and stronger: **identity resolution is
corpus-dependent, they left it to the user, and their own published `sameAs`
pattern is where you would bolt it on** — post-import, over
`{project_name}_Entities`. That is constructive, it is true, and it hands them a
use case rather than a complaint.

## Sources

Read first-hand in a browser on 2026-08-26 (the whole `docs.arango.ai` host
returns 403 to automated fetching, so these were opened in Chrome):

- GraphRAG Technical Overview — https://docs.arango.ai/agentic-ai-suite/graphrag/technical-overview/
- Import Files to build your Knowledge Graph — https://docs.arango.ai/agentic-ai-suite/importer/importing-files/
- Import Parameter Reference — https://docs.arango.ai/agentic-ai-suite/importer/reference/parameters/
- Retriever Search Methods — https://docs.arango.ai/agentic-ai-suite/retriever/search-methods/

Supplied by the user:

- ArangoDB vs. Vector store RAG (video) — https://www.youtube.com/watch?v=pvXnDNrOOQw — the TCO comparison above; transcript could not be extracted, claims taken from the matching comparison page
- Entity Resolution in ArangoDB — https://arango.ai/blog/entity-resolution-in-arangodb/

Earlier research (2026-08-25):

- GraphRAG Notebook Tutorial — https://docs.arangodb.com/3.12/data-science/graphrag/tutorial-notebook/
- Some Perspectives on HybridRAG in an ArangoDB World — https://arango.ai/blog/some-perspectives-on-hybridrag-in-an-arangodb-world/
- Comparison: RAG with Vector Databases vs. ArangoDB GraphRAG — https://arango.ai/resources/comparison-rag-with-vector-databases-vs-arangodb-graphrag-with-knowledge-graphs/
