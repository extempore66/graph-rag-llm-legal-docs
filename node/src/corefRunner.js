// Step 7: coreference orchestration. Builds candidate clusters (corefClusters.js),
// asks the LLM to partition each one (corefJudgment.js), applies the deterministic
// conflict guard, and writes je_same_as edges (entities.js).
//
// Runs as a separate pass AFTER the full dedup run, not inside it. That ordering
// is the design, not convenience: coreference decides using mention volume and
// role distribution across a whole name-family, and those counts are only
// meaningful once the graph is complete. Running it mid-pipeline would starve it
// of exactly the evidence that makes it work.
//
// Non-destructive by construction. Nothing is merged and nothing is deleted --
// "Jeffrey Epstein", "Mr. Epstein" and "Epstein" stay three nodes, now linked.
// Legal provenance requires that the surface form a document actually used stays
// recoverable; an edge is reversible where a merge is not; and every decision
// stays auditable instead of baked in. Retrieval resolves the family with a
// one-hop traversal at query time.
//
// Usage: node --env-file=.env src/corefRunner.js [maxClusters] [--type <group>]
//   --type person   restrict to person clusters (see the type-filter note in main)

import fs from "node:fs";
import path from "node:path";
import { PROJECT_ROOT, COREF_CONCURRENCY } from "./config.js";
import {
  ensureEntitiesCollections,
  getEntitiesWithEvidence,
  writeSameAsEdge,
  writePossibleDuplicateEdge,
} from "./entities.js";
import { buildClusters, tokensConflict } from "./corefClusters.js";
import { partitionCluster } from "./corefJudgment.js";

const logsDir = path.join(PROJECT_ROOT, "node", "logs");
fs.mkdirSync(logsDir, { recursive: true });
const failuresLogPath = path.join(logsDir, "coref_failures.jsonl");
fs.writeFileSync(failuresLogPath, "");

function logFailure(cluster, err) {
  fs.appendFileSync(
    failuresLogPath,
    JSON.stringify({
      token: cluster.token,
      type: cluster.type,
      members: cluster.members.map((m) => m.name),
      error: err.message,
      failed_at: new Date().toISOString(),
    }) + "\n"
  );
}

// Same worker-pool shape as dedupBatchRunner.js. No lock needed here: Step 7
// only ever writes edges between entities that already exist, so there is no
// check-then-act to lose, and the deterministic edge _key makes concurrent
// writes of the same pair idempotent rather than duplicative.
function runWithConcurrency(items, concurrency, worker) {
  return new Promise((resolve, reject) => {
    if (items.length === 0) return resolve();
    let nextIndex = 0;
    let inFlight = 0;
    let settled = 0;
    let failed = false;

    function launchNext() {
      if (failed) return;
      while (inFlight < concurrency && nextIndex < items.length) {
        const item = items[nextIndex++];
        inFlight++;
        worker(item)
          .catch((err) => {
            failed = true;
            reject(err);
          })
          .finally(() => {
            inFlight--;
            settled++;
            if (!failed) {
              if (settled === items.length) resolve();
              else launchNext();
            }
          });
      }
    }
    launchNext();
  });
}

const stats = { clusters: 0, groups: 0, edges: 0, blocked: 0, failures: 0, truncated: 0 };

async function processCluster(cluster, index, total) {
  const label = `[${index + 1}/${total}] ${cluster.type}/${cluster.token} (${cluster.members.length})`;
  try {
    const judged = await partitionCluster(cluster);

    // Regroup by the model's group_id. Singletons are the common and correct
    // outcome -- most cluster members share a word and nothing else.
    const groups = new Map();
    for (const m of judged) {
      if (!groups.has(m.group)) groups.set(m.group, []);
      groups.get(m.group).push(m);
    }

    let edges = 0;
    let blocked = 0;
    for (const [group, members] of groups) {
      if (members.length < 2) continue;
      stats.groups++;

      // Complete pairwise within the group, both directions, so any member
      // reaches every sibling in one hop.
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          const a = members[i];
          const b = members[j];

          // Deterministic guard over the model's opinion. Conflicting identity
          // tokens (a shared surname with different given names) are the exact
          // shape of the false merge this step could produce -- Ghislaine
          // Maxwell and baron Robert Maxwell. Blocked pairs are not discarded:
          // they become review flags, so a human can still see what the model
          // wanted to merge and why.
          if (tokensConflict(a.name, b.name)) {
            await writePossibleDuplicateEdge(
              a.key,
              b.key,
              `Step 7 coref guard: model grouped "${a.name}" with "${b.name}" but identity tokens conflict`
            );
            blocked++;
            continue;
          }

          const reason = `Step 7 coref (${cluster.type}/${cluster.token}): ${a.reason}`;
          await writeSameAsEdge(a.key, b.key, { token: cluster.token, group, reason });
          await writeSameAsEdge(b.key, a.key, { token: cluster.token, group, reason });
          edges += 2;
        }
      }
    }

    stats.clusters++;
    stats.edges += edges;
    stats.blocked += blocked;
    if (cluster.truncated) stats.truncated++;
    console.log(`${label} -- ${edges} edge(s), ${blocked} blocked`);
  } catch (err) {
    stats.failures++;
    logFailure(cluster, err);
    console.log(`${label} -- FAILED: ${err.message}`);
  }
}

// Named flag lookup; the cluster limit stays positional so existing
// invocations ("corefRunner.js 10") keep working unchanged.
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const positional = process.argv.slice(2).find((a) => /^\d+$/.test(a));
  const maxClusters = positional ? parseInt(positional, 10) : Infinity;
  const typeFilter = arg("type");

  await ensureEntitiesCollections();
  const entities = await getEntitiesWithEvidence();
  let allClusters = buildClusters(entities);

  // Type filter -- required, not cosmetic. The guard's subset rule
  // (tokensConflict: A's tokens being a subset of B's reads as "same name,
  // elaborated") is correct for people and inverted for places and
  // organizations. "Epstein" IS "Jeffrey Epstein" shortened; "New York Post"
  // is NOT "New York" elaborated, it is a newspaper named after the place.
  // Measured on a 10-cluster run over court+organization+location+facility:
  // 14 edges written, 11 of them wrong, including two distinct agencies
  // ("Palm Beach County State Attorney's Office" / "...Sheriff's Office")
  // merged after "county", "state" and "attorney" were stripped as
  // non-identifying, deleting exactly the tokens that told them apart.
  // The same run over person clusters produced zero false merges.
  // Until the subset rule is made type-aware, run this step with
  // --type person.
  if (typeFilter) {
    const before = allClusters.length;
    allClusters = allClusters.filter((c) => c.type === typeFilter);
    console.log(`type filter "${typeFilter}": ${allClusters.length} of ${before} clusters`);
    if (allClusters.length === 0) {
      const seen = [...new Set(buildClusters(entities).map((c) => c.type))];
      console.log(`no clusters of that type. Available: ${seen.join(", ")}`);
      return;
    }
  }

  // Largest first: the big name-families are where the retrieval value is, so a
  // limited run (used for testing) exercises the interesting cases rather than
  // a random tail of two-member clusters.
  allClusters.sort((a, b) => b.members.length - a.members.length);
  const clusters = allClusters.slice(0, maxClusters);

  console.log(
    `${entities.length} entities -> ${allClusters.length} candidate clusters` +
      (clusters.length < allClusters.length ? ` (processing first ${clusters.length})` : "") +
      `. Concurrency: ${COREF_CONCURRENCY}.`
  );

  const started = Date.now();
  await runWithConcurrency(
    clusters.map((c, i) => ({ c, i })),
    COREF_CONCURRENCY,
    ({ c, i }) => processCluster(c, i, clusters.length)
  );

  const minutes = ((Date.now() - started) / 60000).toFixed(1);
  console.log(
    `\nDone in ${minutes} min. Clusters: ${stats.clusters}, coreferent groups: ${stats.groups}, ` +
      `same_as edges: ${stats.edges}, guard-blocked pairs: ${stats.blocked}, ` +
      `oversized clusters truncated: ${stats.truncated}, failures: ${stats.failures}.`
  );
  if (stats.failures) console.log(`Failure detail in ${failuresLogPath}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
