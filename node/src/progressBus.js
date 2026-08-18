// N.6 -- a tiny in-process pub/sub so the /upload endpoint can broadcast
// what it's doing to any browser tab listening on the SSE endpoint
// (GET /events), without the upload handler needing to know anything
// about HTTP streaming itself. Built on Node's built-in EventEmitter --
// no new dependency, consistent with this project's "install only what's
// actually needed, on a needed basis" approach so far.
//
// Single shared bus, not per-job: this system stays single-user/
// single-tenant (see the plan doc's multi-tenancy discussion), so there's
// no need to scope events to a batch/job id -- every connected browser
// tab just sees everything happening on the server right now.

import { EventEmitter } from "node:events";

export const progressBus = new EventEmitter();

// Each SSE connection (see server.js's /events route) adds a listener
// here. Default EventEmitter max is 10 -- fine for one person's browser
// tabs, but dev reloads / accidental multi-tab use could plausibly churn
// past that and trigger a noisy (harmless) MaxListenersExceededWarning.
// Raised generously since this costs nothing at this scale.
progressBus.setMaxListeners(50);

// Every event gets a server-side timestamp added automatically, so
// listeners (and anyone reading back a captured log later) don't have to
// guess ordering from arrival time on a possibly-laggy connection.
export function emitProgress(event) {
  progressBus.emit("progress", { ...event, timestamp: new Date().toISOString() });
}
