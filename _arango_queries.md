# ArangoDB web interface — visualising this graph

Practical notes for exploring `je_court_docs_db` in the ArangoDB web UI at
`http://localhost:8529`. Written 2026-08-26.

## Collection layout

Verified against the live database:

| collection               | type     | role                                                                     |
|--------------------------|----------|--------------------------------------------------------------------------|
| `je_entities`            | document | 2,014 resolved entities                                                  |
| `je_chunks`              | document | 3,338 metadata-only anchors (no text, no vector — those live in LanceDB) |
| `je_raw_extractions`     | document | 3,338 per-chunk Step 3 outputs                                           |
| `je_mentioned_in`        | **edge** | 19,009 entity → chunk                                                    |
| `je_same_as`             | **edge** | 488 entity → entity, coreference                                         | 
| `je_possible_duplicates` | **edge** | 413 entity → entity, flagged for human review                            |

All three edge collections are correctly typed as edges. **No named graph
exists** — which matters, because the Graph Viewer can only render a *named
graph*, not loose collections.

## Creating the named graph

1. **GRAPHS** → **Add Graph** → the **General Graph** tab. SmartGraph and
   Satellite Graph are Enterprise/cluster features and are not what this needs.
2. Name it, e.g. `je_kg`.
3. Add three edge definitions:

| edge collection          | from          | to            |
|--------------------------|---------------|---------------|
| `je_mentioned_in`        | `je_entities` | `je_chunks`   |
| `je_same_as`             | `je_entities` | `je_entities` |
| `je_possible_duplicates` | `je_entities` | `je_entities` |

4. Leave **orphan collections** empty — `je_raw_extractions` is not part of the
   graph.

**Nothing is copied or moved.** A named graph is only a definition document in
the system `_graphs` collection, describing which existing collections play which
role. Deleting the graph later removes nothing, *provided* the "drop collections"
option is not ticked.

## Viewing it without hanging the browser

**Do not click "load full graph."** That is 2,014 vertices and 19,009 edges and
it will crawl. Paste a start node instead and set depth to 1 or 2.

In the viewer's settings, set the **label attribute to `name`**, otherwise every
node renders as a numeric `_key`.

### Two start nodes worth knowing

**`je_entities/1348883` — Joseph Recarey.** The richest `je_same_as` hub in the
graph: seven surface forms unified into one person — `Mr. Recarey`,
`Det. Recarey`, `Officer Recarey`, `RECAREY, JOSEPH`, `Joseph Recarey` and more.
This is Step 7 coreference resolution made visible, and it is the strongest
single demonstration of what the pipeline does that string matching does not.

**`je_entities/1285748` — Jane Doe 2.** Fifteen `je_possible_duplicates` flags.
This is the guard *refusing* to merge: the numeric-discriminator rule keeps
`Jane Doe`, `Jane Doe 2` and `Jane Doe 3` as separate people while flagging the
resemblance for a human. Arguably the better demo of the two, because it shows
restraint rather than cleverness — the system erring toward missed merges over
false ones, which in this corpus is the only acceptable direction to err.

Other hubs found in the same sweep, for reference:

- `je_entities/1311914` Det. Recarey — 7 variants
- `je_entities/1426870` Officer Recarey — 7 variants
- `je_entities/1309781` RECAREY, JOSEPH — 6 variants
- `je_entities/1285898` Joseph Recarey — 6 variants
- `je_entities/1285494` Jane Doe — 13 flags
- `je_entities/1293588` Jane Doe 3 — 12 flags

(The Recarey keys are several members of one family seen from different ends —
`je_same_as` is symmetric, so each member reports the others as its variants.)

## Alternative: AQL, no named graph required

The query editor renders a **Graph** tab whenever the result set is paths. This
works immediately, with no graph definition:

```aql
FOR v, e, p IN 1..1 ANY 'je_entities/1348883' je_same_as
  RETURN p
```

Swap the edge collection for `je_possible_duplicates` and the key for
`je_entities/1285748` to see the review flags instead.

## Useful inspection queries

Entity counts by type:

```aql
FOR e IN je_entities
  COLLECT t = e.type WITH COUNT INTO n
  SORT n DESC
  RETURN { type: t, entities: n }
```

The richest coreference families:

```aql
FOR e IN je_same_as
  COLLECT seed = e._from WITH COUNT INTO n
  SORT n DESC LIMIT 10
  LET d = DOCUMENT(seed)
  RETURN { key: d._key, name: d.name, variants: n }
```

The most-flagged possible duplicates, i.e. the human review queue:

```aql
FOR e IN je_possible_duplicates
  COLLECT from = e._from WITH COUNT INTO n
  SORT n DESC LIMIT 10
  LET d = DOCUMENT(from)
  RETURN { key: d._key, name: d.name, flags: n }
```

One entity's whole coreference family, resolved to names:

```aql
LET seed = 'je_entities/1348883'
RETURN {
  seed: DOCUMENT(seed).name,
  variants: (FOR s IN 1..1 OUTBOUND seed je_same_as RETURN s.name)
}
```

How many chunks an entity family reaches — the number that makes graph retrieval
worth having, since a search for one surface form otherwise reaches only its own
share:

```aql
LET seed = 'je_entities/1348883'
LET family = APPEND([seed], (FOR s IN 1..1 OUTBOUND seed je_same_as RETURN s._id))
RETURN LENGTH(
  UNIQUE(
    FOR id IN family
      FOR edge IN je_mentioned_in
        FILTER edge._from == id
        RETURN edge._to
  )
)
```

## Related documents

- `arango_llm_rag_details.md` — how ArangoDB's own GraphRAG works (Importer,
  Louvain/Leiden communities, community summaries, the five retrieval methods)
  and how it compares to this project
- `_step_by_step_absolute.md` — the build recap, including what each collection
  is for and why
- `LLM_metrics_explained.md` — how retrieval quality is measured
