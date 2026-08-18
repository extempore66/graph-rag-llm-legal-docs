// Step 4: dedup candidate generation, deterministic, no LLM. For one newly-
// extracted entity mention, finds a short list (top 5) of existing
// je_entities that might be the same real-world entity, by running two
// independent channels and unioning the results -- string similarity on
// the bare name, and embedding similarity on surrounding context. Neither
// channel decides anything; Step 5's LLM judgment does that, using these as
// its shortlist (see dedupJudgment.js).

import jaroWinkler from "jaro-winkler";
import { embedChunks } from "./processFile.js";
import { getEntitiesByType, getEntity } from "./entities.js";
import { searchSimilarMentions } from "./entityMentions.js";
import { looksGeneric, looksRelated } from "./nameUtils.js";
import { SNIPPET_WINDOW_WORDS, JARO_WINKLER_THRESHOLD } from "./config.js";

// Finds where this mention actually sits in the chunk's raw text. Searches
// for textual_evidence first (more specific, less likely to collide with
// an unrelated same-name mention elsewhere in a dense chunk -- see the
// "Meredith Schultz" email-chain case in the build log) and falls back to
// the bare name. Takes the first match only -- imperfect when a name
// appears multiple times, but this only feeds a candidate *shortlist*, not
// a merge decision, so an occasionally-wrong snippet costs a slightly
// weaker candidate list, not a wrong merge (Step 5 still has to agree).
export function locateMentionInText(chunkText, entity) {
  const needles = [entity.textual_evidence, entity.name].filter(Boolean);
  for (const needle of needles) {
    const index = chunkText.indexOf(needle);
    if (index !== -1) {
      return { index, matchedText: needle };
    }
  }
  return null;
}

// Fixed word-count window, not sentence-aware -- deliberately dumb, since
// this corpus's PDF-extracted text doesn't reliably preserve sentence
// punctuation (see the garbled-font finding), and Step 5 is the real
// correctness safety net regardless of snippet quality.
export function buildSnippet(chunkText, index, matchedText, windowWords = SNIPPET_WINDOW_WORDS) {
  const beforeWords = chunkText.slice(0, index).trim().split(/\s+/).filter(Boolean).slice(-windowWords);
  const afterWords = chunkText
    .slice(index + matchedText.length)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, windowWords);
  return [...beforeWords, matchedText, ...afterWords].join(" ");
}

// Channel 1: string similarity on the bare name against every existing
// entity of the same type. Catches close variants (e.g. "J. Smith" vs
// "John Smith") that share no useful signal in surrounding context. Can
// also produce spurious matches when a generic role-phrase like "defense
// counsel" gets used as a placeholder name for two different real people --
// expected, not a bug, Step 5 is what tells them apart.
async function jaroWinklerCandidates(entity) {
  const existing = await getEntitiesByType(entity.type);
  return existing
    .map((e) => ({ entity_id: e._key, name: e.name, source: "jaro_winkler" }))
    .filter((c) => jaroWinkler(entity.name, c.name) >= JARO_WINKLER_THRESHOLD)
    .slice(0, 5);
}

// Locates the mention and embeds its snippet exactly once per entity --
// callers (the batch runner) reuse this same { snippet, vector } both for
// Channel 2's candidate search below AND for the je_entity_mentions row
// written later in Step 6, instead of paying for two Ollama calls for the
// same text. Returns null if the mention couldn't be located at all (no
// embedding channel possible for this entity, Jaro-Winkler still runs).
export async function buildMentionEmbedding(entity, chunkText) {
  const location = locateMentionInText(chunkText, entity);
  if (!location) return null;

  const snippet = buildSnippet(chunkText, location.index, location.matchedText);
  const [vector] = await embedChunks([snippet]);
  return { snippet, vector };
}

// Channel 2: embedding similarity over the mention's context snippet, not
// the bare name -- catches cases string similarity can't (e.g. "Virginia
// Roberts" vs "Virginia L. Giuffre", or a bare role-phrase like "defense
// counsel" matching an earlier explicit "Christine N. Walz" mention because
// the surrounding role/case-number language overlaps).
//
// Real-data testing on the full corpus found this channel also nominating
// e.g. "Ghislaine Maxwell" as a candidate for "Jeffrey Epstein" -- zero
// name-level connection (Jaro-Winkler ~0.44-0.57, far below the 0.85
// candidate threshold), just two names that happen to co-occur constantly
// in dense sentences. Every sampled case like this burned a Step 5 LLM call
// and came back "unsure" rather than "different", flooding
// je_possible_duplicates with noise. Filtered here, deterministically,
// before it ever becomes a candidate: an embedding match is only kept if
// its name shares a word or an acronym relation with the new mention (see
// looksRelated), unless either side is a generic role-phrase (looksGeneric)
// -- that's the legitimate case this channel exists for, and low string
// similarity there is expected, not noise.
async function embeddingCandidates(entity, mentionEmbedding) {
  if (!mentionEmbedding) return [];

  const matches = await searchSimilarMentions(mentionEmbedding.vector, entity.type, 5);
  const candidates = await Promise.all(
    matches.map(async (m) => {
      const candidateEntity = await getEntity(m.entity_id);
      return {
        entity_id: m.entity_id,
        chunk_id: m.chunk_id,
        snippet: m.context_snippet,
        name: candidateEntity?.name,
        source: "embedding",
      };
    })
  );

  return candidates.filter((c) => {
    if (!c.name) return true; // couldn't resolve a name to check -- don't block it
    if (looksGeneric(entity.name) || looksGeneric(c.name)) return true;
    return looksRelated(entity.name, c.name);
  });
}

// Unions both channels by entity_id (first occurrence wins -- Jaro-Winkler
// checked first, so a name-level match's info takes priority over an
// embedding match for the same entity), capped at 5 total candidates
// regardless of how many either channel found. mentionEmbedding is the
// result of buildMentionEmbedding, computed once by the caller and passed
// in (may be null if the mention couldn't be located).
export async function findCandidates(entity, mentionEmbedding) {
  const [jwCandidates, embedCandidates] = await Promise.all([
    jaroWinklerCandidates(entity),
    embeddingCandidates(entity, mentionEmbedding),
  ]);

  const byId = new Map();
  for (const c of [...jwCandidates, ...embedCandidates]) {
    if (!byId.has(c.entity_id)) byId.set(c.entity_id, c);
  }
  return [...byId.values()].slice(0, 5);
}
