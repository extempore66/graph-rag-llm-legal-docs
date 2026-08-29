On slide 06 Change 
Those reports absorb duplicate names on their own.
  On well-named documents, the problem mostly solves itself.

To



You're right, and the slide is wrong. Let me separate what's true from what I sloppily generalised.

What I got wrong

"There is no name to start from" is a fact about my retriever, not theirs.

My graph retriever links a question to entities by matching name strings against extracted entity names. No name in the question, no entry point, so it falls back. That's why 11 of 35 questions fell back.

ArangoDB's entities are nodes with embeddings. So their entry point can be found by meaning, not spelling. Ask "who handled the money" and it can land on a person nobody named — mine can't. That's a capability they have and I don't.

I took my own limitation and printed it as theirs. On their product. In front of them.

And Global Search is better than mine at conceptual questions

Global Search reads pre-written summaries of every topic in the corpus, map-reduce style. That's built for exactly the question I fail on — "what is in this collection", "which courts appear here", counting and summarising.

I have nothing like it. Slide 03 says so correctly. Slide 04 then contradicts slide 03.

What survives — and it's narrower and more interesting

There's still a real point, but it's about a default, not a limitation.

In default full_graphrag mode:

┌────────────────────┬─────────┐
│ what gets embedded │ default │
├────────────────────┼─────────┤
│ community reports  │ on      │
├────────────────────┼─────────┤
│ entity nodes       │ on      │
├────────────────────┼─────────┤
│ raw chunks         │ off     │
├────────────────────┼─────────┤
│ edges              │ off     │
└────────────────────┴─────────┘

So out of the box, the things you can search by meaning are topic summaries and entities. Not the passages themselves.

Now the Khalil case. The word "obiter" appears zero times in 3,338 passages. The answer is one paragraph, deep inside one filing, about a privilege argument. Cosine ranked it #21 of 3,338 — reachable only because I embed every chunk.

Would a summary of that document's topic mention it? Probably not. Community reports abstract upward. One unremarkable paragraph in a long filing is precisely the detail a summary drops.

So the honest claim is:

▎ A fact that lives in a single passage, and doesn't characterise the topic that passage belongs to, has no retrieval surface in the default configuration.

Not can't. Doesn't, unless you turn chunk embeddings on.

And you can turn them on. It's a parameter.

Where the four channels genuinely differ

Not "we do conceptual, they don't." It's this:

- Their design picks a surface: summaries (Global), entities (Local), or chunks (vector_rag, chosen at ingestion time — it's build-time either/or).
- Mine searches four surfaces at once for every question and fuses by rank.

The Khalil passage arrived at slot 8 tagged vector#21 density#3. Two channels that individually ranked it poorly agreed enough to promote it. That's the argument — not coverage, but not having to choose in advance which kind of question you're asking.

Their equivalent would be running Global and Local and vector and merging — which is a thing you could build on their product, and is roughly what I'd propose.

One honesty check

I don't actually know how Local Search selects its entry entity. The docs say it "anchors on specific entities" without saying how. Embedding-based is my inference from entities having embeddings, and I should say "I think" rather than state it.

---

The fix for slide 04 is to replace the bullet with something like:

▎ Questions answered by one passage rather than by a topic. Chunk embeddings are off by default, so a fact that doesn't characterise its topic has no surface to be found on — until you enable them.

Want me to make that change?
