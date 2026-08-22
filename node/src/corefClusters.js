// Step 7a: coreference candidate clustering. Deterministic, no LLM.
//
// Why Step 7 exists at all. Steps 4-6 resolve a mention against existing
// entities one *pair* at a time, and after the clean v3 run the graph still
// held three separate nodes for one man -- "Jeffrey Epstein" (944 mentions),
// "Mr. Epstein" (445), "Epstein" (198) -- plus four for Ghislaine Maxwell.
// The pairs were not missed: they reached Step 5 and came back "unsure".
//
// That is the important diagnosis. It is not a candidate-generation failure,
// it is a judgment failure, and no threshold tuning fixes it. Proof: the
// v2 flag table contained BOTH
//     "Ms. Maxwell"          <-> "Maxwell"     (same person)
//     "baron Robert Maxwell" <-> "Maxwell"     (her father, different person)
// Two flags of identical surface shape -- honorific-or-forename plus shared
// surname -- with opposite correct answers. If two inputs are indistinguishable
// in a given representation but need different outputs, the information needed
// to decide is not present in that representation. Better prompting cannot
// recover what isn't there; only a larger frame can.
//
// So Step 7 changes the frame from pairwise to cluster. What separates
// Ghislaine from her father is not the strings -- it's that one appears in
// hundreds of filings as a named defendant and the other twice in a passage
// about family background. That is role distribution and mention volume across
// the whole family of similar names, which is exactly what a cluster carries
// and a pair cannot.

import { tokenize } from "./nameUtils.js";
import { COREF_MAX_CLUSTER_SIZE, comparableTypes } from "./config.js";

// Clusters are formed per shared token, NOT by transitive union-find. Union
// would chain: "Virginia Giuffre" links to "Robert Giuffre" on {giuffre} and to
// "Virginia Roberts" on {virginia}, dragging an unrelated person into the
// cluster, and each such link invites the next. Per-token clusters stay
// bounded and let one entity appear in several clusters independently -- which
// is fine, because same_as edges are additive and get resolved transitively at
// query time anyway.
//
// Scoped by type so a person never clusters with an organization: "Maxwell"
// the person and a "Maxwell" corporation share a token and nothing else.
//
// Measured on the real graph: 1,816 entities produce 2,115 (type, token) pairs,
// 630 of which have 2..15 members. No token produced a runaway cluster -- the
// non-identifying-token stripping in nameUtils.tokenize (honorifics, corporate
// suffixes, court scaffolding) already removes everything common enough to
// over-group.
export function buildClusters(entities, maxSize = COREF_MAX_CLUSTER_SIZE) {
  const byToken = new Map();
  for (const entity of entities) {
    for (const token of tokenize(entity.name)) {
      // Single characters don't form meaningful families. The first live run
      // produced 15-member clusters keyed on "s" and "p" -- stray initials and
      // OCR debris sharing nothing -- burning an LLM call each to conclude
      // nothing. Single letters still matter inside tokensConflict, where they
      // are read as initials, so they are filtered here only.
      if (token.length < 2) continue;
      // Keyed on the comparable-type GROUP, not the raw type. A place typed
      // "court" in one chunk and "location" in another must land in the same
      // cluster or coreference inherits the mistype and can never repair it.
      // comparableTypes returns a stable array, so its join is a stable key.
      const key = `${comparableTypes(entity.type).join("+")}\u0000${token}`;
      if (!byToken.has(key)) byToken.set(key, []);
      byToken.get(key).push(entity);
    }
  }

  const clusters = [];
  for (const [key, members] of byToken) {
    if (members.length < 2) continue; // nothing to corefer against

    const [type, token] = key.split("\u0000");
    // Highest-mention members first: they carry the most evidence, and if the
    // cluster has to be truncated they're the ones retrieval actually depends
    // on. truncated is surfaced so the runner can log it rather than silently
    // dropping tail members.
    const sorted = [...members].sort((a, b) => b.mentions - a.mentions);
    clusters.push({
      token,
      type,
      members: sorted.slice(0, maxSize),
      truncated: Math.max(0, sorted.length - maxSize),
    });
  }
  return clusters;
}

// Deterministic false-merge guard, applied AFTER the LLM partitions a cluster.
// Same philosophy as dedupJudgment.js's guardAgainstFalseMerge: never trust the
// model alone on something a cheap check can verify.
//
// The rule is subset compatibility of identity tokens. Two names may corefer if
// one's token set is a subset of (or equal to) the other's. If each side has an
// identity token the other lacks, they carry conflicting identifiers and must
// not be merged:
//
//   {epstein}            vs {jeffrey, epstein}    subset      -> allowed
//   {ghislaine, maxwell} vs {robert, maxwell}     conflicting -> blocked
//   {virginia, giuffre}  vs {robert, giuffre}     conflicting -> blocked
//
// The middle case is the exact failure this guard exists for, taken from real
// flag data. Note the known cost, accepted deliberately: a married-name change
// ("Virginia Roberts" -> "Virginia Giuffre") is also conflicting under this
// rule and gets blocked. That's a missed merge, which this project consistently
// prefers over a false one -- and blocked pairs are not discarded, they're
// written as review flags instead (see corefRunner.js), so the information
// survives for a human.
// Single-letter tokens are initials, not competing identifiers. "G Maxwell"
// (431 mentions in this corpus) must stay mergeable with "Ghislaine Maxwell",
// and "J. Smith" with "John Smith". So a one-character token counts as
// "conflicting" only if nothing on the other side begins with it -- which
// still blocks "G Maxwell" vs "Robert Maxwell", since no token there starts
// with g. Caught by testing the guard against real graph data rather than
// invented pairs; the naive version silently blocked the third-largest
// Maxwell node in the graph.
function hasConflictingToken(own, other) {
  for (const t of own) {
    if (other.has(t)) continue;
    if (t.length === 1 && [...other].some((o) => o.startsWith(t))) continue;
    return true;
  }
  return false;
}

// A token containing a digit is a discriminator, never an elaboration. This is
// the one asymmetry in the subset rule, and it exists because the first live
// Step 7 run merged "Jane Doe 3" into "Jane Doe" and "Jane Doe #1 and #2" into
// "Jane Doe 2" -- distinct pseudonymous plaintiffs collapsed into one person.
// Subset compatibility alone reads {jane, doe, 3} as "Jane Doe, elaborated",
// which is right for "Jeffrey Epstein" vs "Epstein" and badly wrong for a
// numbered pseudonym, a Bates stamp (GIUFFRE000046) or a docket-bearing name.
// So: if either side carries a digit-bearing token the other lacks, they
// conflict, regardless of subset. In this corpus the false merges that rule
// prevents are victim pseudonyms, which makes it the highest-stakes check in
// the file.
function hasUnmatchedNumericToken(own, other) {
  for (const t of own) {
    if (/\d/.test(t) && !other.has(t)) return true;
  }
  return false;
}

export function tokensConflict(nameA, nameB) {
  const a = tokenize(nameA);
  const b = tokenize(nameB);
  if (a.size === 0 || b.size === 0) return false; // no identity signal either way

  if (hasUnmatchedNumericToken(a, b) || hasUnmatchedNumericToken(b, a)) return true;

  return hasConflictingToken(a, b) && hasConflictingToken(b, a);
}
