// A per-key async mutex, used by Step 6 to close the entity-creation race.
//
// Why this is needed at all, given Node is single-threaded: the dedup runner's
// "workers" are not threads, they're N concurrent async call chains interleaved
// by the event loop. Synchronous code between two awaits is already atomic --
// nothing can preempt it -- so there is no memory race in the C++ sense. The
// race lives *across* await points: worker A awaits findCandidates(), yields,
// worker B awaits its own findCandidates(), both see no existing "Mr. Barton",
// and both create one. Measured cost on the first clean full run was 33
// redundant nodes (1.7% of the graph), every one of them a pair or triple of
// byte-identical names that no LLM ever judged.
//
// The fix is therefore not about locking memory, it's about making a *sequence
// of awaits* non-interleavable for a given key. Promises are the only primitive
// needed: each key holds a chain, acquiring means awaiting the previous link,
// and releasing means resolving your own. No spinning, no threads -- the event
// loop simply doesn't schedule the next holder's continuation until the current
// one settles.
//
// Deliberately NOT solved with a unique DB index on (name, type). That looks
// equivalent but silently changes semantics: it would force two genuinely
// different people who share a name into one node, taking that call away from
// Step 5, which exists precisely to make it. The race is wrong because nobody
// judged; a second node for a same-named different person is correct *because*
// the LLM judged. An index cannot tell those apart. A lock doesn't have to --
// it only orders the work, it never decides anything.

const chains = new Map();

// Runs fn() with exclusive access to `key`. Callers holding different keys
// never block each other, so throughput is only affected when two workers land
// on the same entity name at the same moment.
//
// Two details that matter:
//   - `prev.then(fn, fn)` runs fn whether the predecessor fulfilled OR rejected.
//     A holder that throws must not wedge every later caller on that key.
//   - `tail` is the error-swallowed chain that the *next* caller queues behind.
//     Without it a single rejection would leave a permanently-rejected promise
//     in the map, and every subsequent acquire would inherit that rejection.
// The map entry is deleted once the chain drains, so keys don't accumulate
// across a long run (identity check first, so a caller that queued behind us in
// the meantime isn't dropped).
export function withLock(key, fn) {
  const prev = chains.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  const tail = result.catch(() => {});
  chains.set(key, tail);
  tail.finally(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return result;
}

// Entity identity for locking purposes. Lowercased because Step 4 now compares
// names case-insensitively (see dedupCandidates.js) -- "MR. BARTON" and
// "Mr. Barton" must contend for the same lock or the race reopens for exactly
// the pairs the case fix was meant to unify. The separator is an explicit
// \u0000 escape -- never a literal NUL byte in the source, which is both
// unreadable and, as this very file proved, un-greppable. It cannot occur
// in text extracted from a PDF, so no name+type pair can collide.
export function entityLockKey(name, type) {
  return `${type}\u0000${String(name).toLowerCase()}`;
}

// Test/diagnostic hook only -- how many keys are currently contended.
export function pendingLockCount() {
  return chains.size;
}
