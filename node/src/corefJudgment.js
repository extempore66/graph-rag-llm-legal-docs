// Step 7b: LLM judgment #3 -- partition one candidate cluster of similarly-named
// entities into groups that refer to the same real-world entity.
//
// Differs from Step 5 in exactly one way that matters: Step 5 asks "is A the
// same as B?" with one snippet of context, and on honorific coreference it
// answers "unsure" -- correctly, because a pair of names plus one sentence
// genuinely does not contain the answer. Here the model sees the whole family
// at once, each member annotated with how many times it appears, in how many
// distinct documents, in which roles, and with sample evidence. Given
// "Maxwell", "Ms. Maxwell", "Ghislaine Maxwell" and "baron Robert Maxwell"
// side by side -- one a defendant across hundreds of filings, one appearing
// twice in a biographical passage -- the partition is decidable. That's the
// whole point of the step.

import { OLLAMA_URL, EXTRACTION_MODEL } from "./config.js";

// Positional correspondence again, never model-echoed IDs -- same discipline
// as dedupJudgment.js, for the same reason (a real test there caught the model
// returning a mangled ":65839" entity_id lifted from the prompt's own
// formatting). Members are numbered in the prompt; the model returns one group
// label per member, in order, and real entity keys are re-attached in code from
// our own array.
//
// group_id is an integer rather than a name: asking for a canonical name would
// invite the model to invent one that matches no node in the graph. Members
// sharing a group_id are the same entity; a member alone in its group is
// simply not coreferent with anything else here, which is a perfectly good
// answer and the common case.
//
// minItems/maxItems pinned to the member count for the reason discovered in
// Step 5: without them, schema-constrained decoding still cheerfully emits a
// different number of array items than asked for. The count has to be a
// structural constraint on the JSON, not a request in the prompt.
function buildPartitionSchema(memberCount) {
  return {
    type: "object",
    properties: {
      assignments: {
        type: "array",
        minItems: memberCount,
        maxItems: memberCount,
        items: {
          type: "object",
          properties: {
            group_id: { type: "integer" },
            reason: { type: "string" },
          },
          required: ["group_id", "reason"],
        },
      },
    },
    required: ["assignments"],
  };
}

const SYSTEM_PROMPT = `You are resolving coreference among entities extracted from one US federal court \
case. You will be given a numbered list of entities whose names share a word, together with evidence \
about each: how many times it is mentioned, in how many distinct documents, the roles it appears in, \
and sample textual evidence.

Your job: decide which of them refer to the SAME real-world entity.

Assign every entity an integer group_id. Entities you judge to be the same real-world entity get the \
SAME group_id. An entity that refers to something no other listed entity refers to gets its own \
unique group_id. Most clusters contain several distinct entities -- do not assume they are all one.

Typical same-entity patterns:
- an honorific or title form and a full name ("Mr. Epstein" / "Jeffrey Epstein")
- a bare surname and a full name ("Epstein" / "Jeffrey Epstein")
- an initial and a full given name ("G Maxwell" / "Ghislaine Maxwell")
- capitalisation or punctuation variants of one name

Patterns that are NOT the same entity, and are the main thing to watch for:
- two people who share a surname but have different given names (a defendant and their relative)
- a person and a document identifier, exhibit label or Bates number that contains their name
- a person and a place, vessel, company or property named after them
- a person and a generic role-phrase that could describe several different people

Weigh the evidence, not just the strings. A name appearing in hundreds of filings in a party role and \
a name appearing twice in a background passage are usually different entities even when the surname \
matches. A false merge (treating two different real people as one) is worse than a missed merge, so \
when the evidence does not support merging, give separate group_ids.

Give a short (<=12 word) reason per entity. Return exactly one assignment per entity, in a \
"assignments" array in the SAME ORDER the entities are numbered below -- assignment 1 is about \
entity 1, and so on. Do not include names or IDs in your answer, only "group_id" and "reason".`;

function formatMember(index, member) {
  const lines = [
    `${index + 1}. name: ${member.name}`,
    `   mentions: ${member.mentions} across ${member.documents} distinct document(s)`,
  ];
  if (member.roles?.length) {
    lines.push(`   roles: ${member.roles.map((r) => `${r.role} (${r.n})`).join(", ")}`);
  }
  for (const ev of member.evidence ?? []) {
    lines.push(`   evidence: "${ev}"`);
  }
  return lines.join("\n");
}

async function callOllamaChat(userContent, memberCount) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: EXTRACTION_MODEL,
      stream: false,
      think: false,
      format: buildPartitionSchema(memberCount),
      options: { num_predict: 1200 },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama /api/chat returned HTTP ${response.status}: ${await response.text()}`);
  }
  return (await response.json()).message.content;
}

// cluster: { token, type, members: [{ key, name, mentions, documents, roles, evidence }] }
// Returns the members array with a `group` integer attached to each, in the
// same order. Grouping is the model's raw opinion -- the deterministic
// conflict guard is applied by the runner, not here, so that this module stays
// "what the LLM said" and the guard stays independently testable.
export async function partitionCluster(cluster) {
  const { members } = cluster;

  const userContent = `These ${members.length} entities are all of type "${cluster.type}" and share the word "${cluster.token}" in their names.

${members.map((m, i) => formatMember(i, m)).join("\n")}`;

  const content = await callOllamaChat(userContent, members.length);
  const parsed = JSON.parse(content);

  // A length mismatch means positional correspondence is broken, so we cannot
  // safely say which assignment belongs to which entity. Thrown rather than
  // guessed at: zipping mismatched arrays would attach a merge decision to the
  // wrong entity, which is precisely the false-merge risk this step is built
  // to avoid.
  if (parsed.assignments.length !== members.length) {
    throw new Error(
      `Assignment count mismatch: got ${parsed.assignments.length} for ${members.length} members`
    );
  }

  return members.map((m, i) => ({
    ...m,
    group: parsed.assignments[i].group_id,
    reason: parsed.assignments[i].reason,
  }));
}
