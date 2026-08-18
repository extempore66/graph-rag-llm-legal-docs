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

import express from "express";
import multer from "multer";
import pLimit from "p-limit";
import path from "node:path";
import fs from "node:fs";
import { PROJECT_ROOT, UPLOAD_CONCURRENCY } from "./config.js";
import { processFile } from "./processFile.js";
import { progressBus, emitProgress } from "./progressBus.js";

const app = express();
const PORT = process.env.PORT || 3000;

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

app.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT} (upload concurrency: ${UPLOAD_CONCURRENCY})`);
});
