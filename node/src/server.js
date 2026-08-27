// N.4 -- wrap the proven processFile pipeline in an upload endpoint.
// N.5 -- bound how many files actually get processed at once, regardless
// of how many upload requests arrive concurrently, via a shared p-limit
// pool. Without this, Express would happily start a processFile() call
// (and its Python subprocess + Ollama call) for every single incoming
// request at once, unbounded -- fine for 2 files, a real problem for the
// full 187-file backlog hitting this endpoint close together.
// N.6 -- broadcast per-file progress (start/done/error) over Server-Sent
// Events (GET /events) so a browser watching a batch upload sees live
// status instead of just the one POST /upload response it personally
// sent. The pool/concurrency logic itself is unchanged -- this only adds
// a second place (progressBus) that gets told what's happening, on top
// of the existing console.log lines.
// N.7 -- serve the actual upload page (node/public/index.html) as a plain
// static file. No frontend framework/build step -- a single self-contained
// HTML file with inline JS is enough for a single-user internal tool, and
// keeps this consistent with the "no dependency until it's actually
// needed" approach used everywhere else so far.
// N.8 -- POST /ask, plus node/public/ask.html, so the retrieval side has a
// way in. Until now the four retrieval modules could only be invoked by
// runEval.js, which reads a fixed question file and writes JSONL: a
// measurement harness, not a way to use the system. Same server rather
// than a second process, because ingestion and querying share the same
// LanceDB and ArangoDB connections and the same config.

import express from "express";
import multer from "multer";
import pLimit from "p-limit";
import path from "node:path";
import fs from "node:fs";
import { INDEPENDENT_VERDICT, PROJECT_ROOT, UPLOAD_CONCURRENCY } from "./config.js";
import { processFile } from "./processFile.js";
import { progressBus, emitProgress } from "./progressBus.js";
import { retrieveNaive } from "./retrieval/naiveRetriever.js";
import { retrieveHybrid } from "./retrieval/hybridRetriever.js";
import { retrieveGraph } from "./retrieval/graphRetriever.js";
import {
  generateAnswer,
  judgeSufficiency,
  judgeSufficiencyIndependent,
  streamAnswer,
} from "./retrieval/answerGenerator.js";

const app = express();
const PORT = process.env.PORT || 3000;

// Needed only by /ask -- the upload route takes multipart, which multer
// parses itself. Mounted globally because the body limit is irrelevant for
// a payload that is one question string.
app.use(express.json());

// Serves node/public/index.html at GET / (and any other static assets
// dropped in that folder later) -- placed before the /upload and /events
// routes purely by convention, order doesn't matter here since the paths
// don't overlap.
app.use(express.static(path.join(PROJECT_ROOT, "node", "public")));

// Uploaded files land here temporarily before being processed. This is
// transient working storage, not a permanent store -- the permanent stores
// are LanceDB and ArangoDB, which is why it's gitignored.
const UPLOAD_DIR = path.join(PROJECT_ROOT, "node", "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// multer's default temp filenames are already collision-safe (randomly
// generated), which is exactly what concurrent uploads need -- so unlike
// N.4, this version never renames the file on disk. The original filename
// is passed to processFile separately as metadata instead (see
// processFile.js's displayName parameter).
const upload = multer({ dest: UPLOAD_DIR });

// The pool itself: only UPLOAD_CONCURRENCY calls scheduled through `limit`
// run at once, no matter how many requests are in flight. Extra calls wait
// in p-limit's internal queue until a slot frees up.
const limit = pLimit(UPLOAD_CONCURRENCY);
let inFlight = 0;

app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'no file uploaded (expected form field "file")' });
  }

  const tempPath = req.file.path;
  const originalName = req.file.originalname;

  try {
    const summary = await limit(async () => {
      inFlight++;
      console.log(`[pool] start "${originalName}" (in-flight: ${inFlight}/${UPLOAD_CONCURRENCY})`);
      emitProgress({ type: "start", file: originalName, inFlight, concurrency: UPLOAD_CONCURRENCY });
      try {
        const result = await processFile(tempPath, originalName);
        // result already carries source_file/total_words/chunk_count --
        // spread it into the event so a listening browser gets the same
        // summary this request's own JSON response gets.
        emitProgress({ type: "done", file: originalName, ...result });
        return result;
      } catch (err) {
        // Emitted here (not just left to the outer catch) so listeners get
        // an explicit "error" event distinct from "done" -- the outer
        // catch only shapes this request's own HTTP response.
        emitProgress({ type: "error", file: originalName, error: err.message });
        throw err;
      } finally {
        inFlight--;
        console.log(`[pool] done  "${originalName}" (in-flight: ${inFlight}/${UPLOAD_CONCURRENCY})`);
      }
    });
    res.json({ success: true, ...summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    // The content now lives in LanceDB/ArangoDB (or the attempt failed and
    // there's nothing worth keeping either way) -- clean up the temp file
    // regardless of outcome.
    fs.rmSync(tempPath, { force: true });
  }
});

// N.6 -- SSE stream. A browser opens this once (new EventSource("/events"))
// and keeps it open for the life of the page; every progress event fired
// anywhere in the server (currently just /upload's start/done/error) gets
// pushed down every currently-open connection.
app.get("/events", (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    // Express's default keep-alive handling is fine here, but being
    // explicit documents intent: this response is deliberately never
    // "finished" the normal way, it stays open until the client disconnects.
    Connection: "keep-alive",
  });

  const send = (event) => {
    // SSE wire format: a "data: " line (JSON payload here) followed by a
    // blank line to mark the end of the frame. Anything not starting with
    // "data:" (e.g. our heartbeat comment below) is ignored by EventSource.
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  progressBus.on("progress", send);

  // Idle SSE connections can get silently dropped by browsers/proxies
  // after a timeout with no traffic. A periodic comment line (starts with
  // ":", which EventSource treats as a no-op ping) keeps the connection
  // alive without ever looking like a real progress event to listeners.
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);

  req.on("close", () => {
    clearInterval(heartbeat);
    progressBus.off("progress", send);
  });
});

// Retrieval strategies, by the same names the eval uses. Kept as a lookup
// rather than an if-chain so an unknown strategy is a 400 listing what IS
// available, and so adding a fifth here is one line in one place.
const STRATEGIES = {
  naive: retrieveNaive,
  hybrid: retrieveHybrid,
  graph: retrieveGraph,
};

// One question in, one grounded answer out. Deliberately returns the whole
// retrieval record alongside the answer -- the sources with their page
// ranges, which channels nominated each one, and the graph traversal path --
// because for this system HOW an answer was reached is as much the product
// as the answer text. A page that showed only prose would hide the single
// most interesting thing it does.
app.post("/ask", async (req, res) => {
  const question = (req.body?.question ?? "").trim();
  const strategy = req.body?.strategy ?? "hybrid";

  if (!question) return res.status(400).json({ error: "question is required" });
  const retrieve = STRATEGIES[strategy];
  if (!retrieve) {
    return res.status(400).json({ error: `unknown strategy "${strategy}"`, available: Object.keys(STRATEGIES) });
  }

  try {
    const t0 = Date.now();
    const chunks = await retrieve(question);
    const retrievalMs = Date.now() - t0;
    const answer = await generateAnswer(question, chunks);

    res.json({
      question,
      strategy,
      answer: answer.answer,
      answered_from_context: answer.answered_from_context,
      truncated: answer.truncated,
      invalid_citations: answer.invalid_citations,
      // The cited chunk_ids, so the page can mark which sources the model
      // actually used rather than just which ones it was given.
      cited_chunk_ids: answer.citations.map((c) => c.chunk_id),
      sources: chunks.map((c) => ({
        chunk_id: c.chunk_id,
        source_file: c.source_file,
        page_start: c.page_start,
        page_end: c.page_end,
        distance: c.distance ?? null,
        channels: c.channels ?? null,
        path: c.path ?? null,
        text: c.text,
      })),
      // Present for graph and hybrid, null for naive. Carries the fallback
      // flag and reason, which is the thing worth putting on screen.
      graph_path: chunks.graph_path ?? null,
      retrieval_ms: retrievalMs,
      answer_ms: answer.latency_ms,
    });
  } catch (err) {
    console.error(`[ask] ${strategy}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// N.9 -- POST /ask/stream, the two-phase path, delivered as newline-delimited
// JSON so the page can render in three beats instead of one.
//
// The motive is correctness, not speed: phase 1 judges sufficiency with no
// field to write prose in, phase 2 writes the answer only if phase 1 said yes.
// See answerGenerator.js for why that split is the fix for abstention.
//
// The demo consequence is what makes the system showable. Retrieval lands at
// ~200ms, the verdict a few seconds later, then the answer streams. The
// single-call /ask above leaves the page blank for 60-70 seconds, which is
// fine for a batch eval and unusable in front of a room.
//
// NDJSON rather than SSE because this is one request producing one ordered
// sequence of frames -- SSE's reconnection and event-type machinery buys
// nothing here, and fetch() can read the body progressively without it.
// /ask is left exactly as it was: the eval rows were measured against it.
app.post("/ask/stream", async (req, res) => {
  const question = (req.body?.question ?? "").trim();
  const strategy = req.body?.strategy ?? "hybrid";

  if (!question) return res.status(400).json({ error: "question is required" });
  const retrieve = STRATEGIES[strategy];
  if (!retrieve) {
    return res.status(400).json({ error: `unknown strategy "${strategy}"`, available: Object.keys(STRATEGIES) });
  }

  res.writeHead(200, {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache",
    // Without this, a proxy may buffer the whole response and deliver it at
    // once -- which would silently undo the entire point of streaming.
    "X-Accel-Buffering": "no",
  });
  const send = (frame) => res.write(JSON.stringify(frame) + "\n");

  try {
    const t0 = Date.now();
    const chunks = await retrieve(question);
    const retrievalMs = Date.now() - t0;

    // Beat 1 -- everything retrieval knows. This is the frame that makes the
    // page feel instant, and it carries the graph traversal, which is the most
    // interesting thing on screen.
    send({
      type: "retrieval",
      question,
      strategy,
      retrieval_ms: retrievalMs,
      graph_path: chunks.graph_path ?? null,
      sources: chunks.map((c) => ({
        chunk_id: c.chunk_id,
        source_file: c.source_file,
        page_start: c.page_start,
        page_end: c.page_end,
        distance: c.distance ?? null,
        channels: c.channels ?? null,
        path: c.path ?? null,
        text: c.text,
      })),
    });

    // Beat 2 -- the sufficiency verdict, and the citations that come with it.
    //
    // One call per passage by default. The single-call form judges the eight
    // together and its verdict on any one of them turns out to depend on the
    // other seven -- see INDEPENDENT_VERDICT in config.js for the measurement.
    const judge = INDEPENDENT_VERDICT ? judgeSufficiencyIndependent : judgeSufficiency;
    const verdict = await judge(question, chunks);
    send({
      type: "verdict",
      sufficient: verdict.sufficient,
      missing: verdict.missing,
      cited_chunk_ids: verdict.citations.map((c) => c.chunk_id),
      invalid_citations: verdict.invalid_citations,
      verdict_ms: verdict.latency_ms,
    });

    // Beat 3 -- the answer, or an honest refusal. The refusal is assembled in
    // code rather than asked for from the model: having decided the passages
    // cannot answer, sending them back to be written up is precisely the
    // round trip that produces a confident non-answer.
    if (!verdict.sufficient) {
      send({
        type: "done",
        refused: true,
        // The model's `missing` sometimes ends in a full stop and sometimes
        // does not, so the sentence is closed here rather than concatenated
        // blindly into "... dicta..".
        answer: verdict.missing
          ? `These passages do not contain the answer -- ${verdict.missing.replace(/\s*\.*$/, "")}.`
          : "These passages do not contain the answer.",
        truncated: false,
        answer_ms: 0,
      });
      return res.end();
    }

    const result = await streamAnswer(question, chunks, (delta) => send({ type: "delta", text: delta }));
    send({ type: "done", refused: false, answer: result.answer, truncated: result.truncated, answer_ms: result.latency_ms });
    res.end();
  } catch (err) {
    console.error(`[ask/stream] ${strategy}: ${err.message}`);
    // Headers are already sent by this point, so the error has to travel as a
    // frame rather than a status code.
    send({ type: "error", error: err.message });
    res.end();
  }
});

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT} (upload concurrency: ${UPLOAD_CONCURRENCY})`);
});
