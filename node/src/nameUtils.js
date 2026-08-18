// Shared name-comparison heuristics used by both Step 4 (dedupCandidates.js,
// filtering embedding-channel noise before it ever reaches an LLM call) and
// Step 5 (dedupJudgment.js, the false-merge guard) -- kept in one place so
// the two stay consistent instead of drifting.

// A name counts as "generic" if it's a role-phrase rather than a specific
// person/org name (e.g. "defense counsel"). Two names where one side is
// generic are the legitimate case the embedding channel exists for --
// Christine Walz's later "defense counsel" mention should still reach the
// LLM even though the strings share nothing, so looksRelated is never
// applied when either side is generic (see looksGeneric below).
const GENERIC_NAME_PATTERN = /\b(counsel|attorney|defendant|plaintiff|witness|petitioner|respondent|the court|this court|judge)\b/i;

export function looksGeneric(name) {
  return !name || GENERIC_NAME_PATTERN.test(name);
}

const STOPWORDS = new Set(["of", "the", "and", "for"]);

function tokenize(name) {
  return new Set(name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function sharesToken(nameA, nameB) {
  const tokensA = tokenize(nameA);
  for (const t of tokenize(nameB)) if (tokensA.has(t)) return true;
  return false;
}

function initials(name) {
  return name
    .replace(/[^a-zA-Z\s]/g, "")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w.toLowerCase()))
    .map((w) => w[0].toLowerCase())
    .join("");
}

function compactLetters(name) {
  return name.replace(/[^a-zA-Z]/g, "").toLowerCase();
}

// True if the shorter name's letters equal the longer name's initials (minor
// stopwords skipped) -- catches "S.D.N.Y." / "Southern District of New York"
// without needing a real acronym dictionary.
function acronymRelated(nameA, nameB) {
  const [longer, shorter] = nameA.length >= nameB.length ? [nameA, nameB] : [nameB, nameA];
  const shorterLetters = compactLetters(shorter);
  return shorterLetters.length > 1 && initials(longer) === shorterLetters;
}

// True if two names share at least one whole word, or one is a plausible
// acronym/initialism of the other. Two specific (non-generic) names with
// neither relation are treated as unrelated proper names -- real-data
// testing found the embedding channel nominating e.g. "Ghislaine Maxwell" as
// a candidate for "Jeffrey Epstein" purely from dense co-occurrence context,
// with zero name-level connection (Jaro-Winkler ~0.44-0.57, far below the
// 0.85 candidate threshold). This function is the deterministic check used
// to catch that shape before it burns an LLM call or becomes a spurious
// "unsure" flag.
export function looksRelated(nameA, nameB) {
  return sharesToken(nameA, nameB) || acronymRelated(nameA, nameB);
}
