# Step 7: Coreference

Step 5 (dedup) asks a **pairwise** question at write time — "is this new mention
the same entity as this one candidate?" — using one snippet and the two chunks'
docket/date facts. It only ever sees pairs that Step 4 surfaced, and Step 4
surfaces on name-string similarity (Jaro-Winkler >= 0.85). That threshold cannot
reach honorifics: `Ms. Giuffre` vs `Virginia Giuffre` scores 0.617, so the
question was never asked, and the pair never reached the review queue either --
a queue can only hold questions that got asked.

Step 7 asks a **partition** question after the graph is complete: given a whole
name-family at once, carve it into groups. It clusters entities by shared token
within a comparable-type group (`roberts`, `epstein`), caps each cluster at
COREF_MAX_CLUSTER_SIZE, and hands the LLM aggregate evidence Step 5 never had --
mention volume, distinct document count, role distribution, sample evidence. That
aggregate view is the whole point: mention counts and roles across the family are
what separate Ghislaine Maxwell (534 mentions, defendant) from Robert Maxwell
(1 mention, her father). A deterministic guard then blocks pairs it rejects.

It is **non-destructive**: nothing is merged or deleted. `Jeffrey Epstein`,
`Mr. Epstein` and `Epstein` stay three nodes, now joined by `je_same_as` edges,
because the surface form a filing actually used must stay recoverable for legal
provenance, an edge is reversible where a merge is not, and every decision stays
auditable. Retrieval resolves the family with a one-hop traversal at query time.

## Measured, 2026-08-25

Sound for persons: unified Maxwell (1,503 mentions), Epstein (1,490), Giuffre
(890), and three spellings of Marcinkova, while holding apart Robert Maxwell,
Victoria/Kimberley/Carol Roberts, and Robert Giuffre. One false merge (Sky and
Lynn Roberts, her father and mother, grouped together); the rest of the errors
are missed merges, the safe direction.

**Broken for places and organizations.** The same shared-token clustering that
correctly pulls `Ms. Roberts` next to `Virginia Roberts` also pulls
`New York Post` next to `New York`. A 10-cluster smoke test produced 14 links,
11 of them wrong -- including `Palm Beach County State Attorney's Office` linked
to `Palm Beach County Sheriff's Office`, two distinct agencies. Those 28 edges
were deleted; `je_same_as` is empty.

Root cause is the guard, not the prompt: `tokensConflict` treats "A's tokens are
a subset of B's" as elaboration, which is right for people (`Epstein` IS
`Jeffrey Epstein` shortened) and inverted for places (`New York Post` is not
`New York` elaborated). Until that rule is made type-aware, run with
`--type person`:

    node --env-file=.env src/corefRunner.js --type person

Note the guard also blocks the one false merge the person test appeared to
produce (`Sky Roberts` / `Lynn, Roberts`) -- that test called partitionCluster
directly and bypassed it. With the guard in place, person clusters produced no
false merges.

Known model defect: a `reason` may read "Same as X, variant spelling" while
assigning X a different group number.
