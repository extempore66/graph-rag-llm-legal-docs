// Focused probe: pairs that are the SAME STRING modulo case/punctuation.
// Any verdict other than "same" here is a defect, not caution -- these
// require no contextual inference at all. Tests whether the 30b's
// "no shared docket/date" refusal is a systematic behaviour or a one-off.
import { Database, aql } from "arangojs";
import { ARANGO_URL, ARANGO_DB, ARANGO_USER, ARANGO_PASSWORD, EXTRACTION_MODEL }
  from "../src/config.js";
import { judgeCandidates }
  from "../src/dedupJudgment.js";

const db = new Database({ url: ARANGO_URL, databaseName: ARANGO_DB,
  auth: { username: ARANGO_USER, password: ARANGO_PASSWORD } });

const PAIRS = [
  ["Jeffrey Epstein", "JEFFREY EPSTEIN"],
  ["Virginia Giuffre", "VIRGINIA GIUFFRE"],
  ["Ms. Maxwell", "MS. MAXWELL"],
  ["Epstein", "EPSTEIN"],
  ["G Maxwell", "G. Maxwell"],
  ["Mr. Epstein", "Mr . Epstein"],
  ["Ms. Giuffre", "MS. Giuffre"],
];

const cur = await db.query(aql`
  FOR d IN je_raw_extractions FOR e IN d.entities FILTER e.type == "person"
    RETURN { name: e.name, textual_evidence: e.textual_evidence, chunk_id: d._key,
             docket_numbers: d.docket_numbers, dates: d.dates }`);
const mentions = await cur.all();
const find = (n) => mentions.find((m) => m.name === n) ?? null;

console.log(`model: ${EXTRACTION_MODEL}`);
let bad = 0, n = 0;
for (const [a, b] of PAIRS) {
  const pa = find(a), pb = find(b);
  if (!pa || !pb) { console.log(`  SKIP  "${a}" / "${b}"`); continue; }
  const [j] = await judgeCandidates(
    { name: pa.name, type: "person", textual_evidence: pa.textual_evidence },
    { docket_numbers: pa.docket_numbers, dates: pa.dates },
    [{ entity_id: "probe", name: pb.name, source: "jaro_winkler", chunk_id: pb.chunk_id }]);
  n++;
  const ok = j.verdict === "same";
  if (!ok) bad++;
  console.log(`  ${ok ? "ok  " : "DEFECT"} ${j.verdict.padEnd(9)} "${a}" / "${b}"${ok ? "" : `  -- ${j.reason}`}`);
}
console.log(`\n  ${EXTRACTION_MODEL}: ${n - bad}/${n} trivially-identical pairs merged correctly`);
