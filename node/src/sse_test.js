// N.6 verification -- opens a real SSE connection to /events and logs
// every event as it arrives, live. Meant to be run in one terminal while
// `npm run test-concurrency` (or any real upload) runs in another --
// this proves progress events actually reach a listening client while
// uploads are happening, not just that the server code compiles.
//
// Requires the server to already be running (`npm start`) -- this script
// is just an SSE client, the same relationship concurrency_test.js has
// to the server as a plain HTTP client.

const SSE_URL = "http://localhost:3000/events";
// No fixed file count is known here -- unlike concurrency_test.js this
// script doesn't drive the uploads itself, it just listens. Exits after
// a period of silence instead of a fixed timeout, so it naturally covers
// runs of any length.
const IDLE_EXIT_MS = 8000;

console.log(`Connecting to ${SSE_URL} ...`);
const response = await fetch(SSE_URL);

if (!response.ok || !response.body) {
  console.error(`Failed to connect: HTTP ${response.status}`);
  process.exit(1);
}

console.log(`Connected. Listening for progress events (exits after ${IDLE_EXIT_MS / 1000}s of silence)...\n`);

const decoder = new TextDecoder();
let buffer = "";
let eventCount = 0;

let idleTimer = setTimeout(exitIdle, IDLE_EXIT_MS);
function resetIdleTimer() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(exitIdle, IDLE_EXIT_MS);
}
function exitIdle() {
  console.log(`\nNo events for ${IDLE_EXIT_MS / 1000}s -- exiting. Total events received: ${eventCount}`);
  process.exit(0);
}

for await (const chunk of response.body) {
  buffer += decoder.decode(chunk, { stream: true });

  // SSE frames are separated by a blank line; split on that and handle
  // whatever full frames have arrived so far, keeping any trailing
  // partial frame in the buffer for the next chunk.
  const frames = buffer.split("\n\n");
  buffer = frames.pop();

  for (const frame of frames) {
    if (frame.startsWith(":")) continue; // heartbeat comment line, not a real event
    if (!frame.startsWith("data: ")) continue;

    resetIdleTimer();
    const event = JSON.parse(frame.slice("data: ".length));
    eventCount++;
    const label = event.type.toUpperCase().padEnd(5);
    console.log(`[${event.timestamp}] ${label} ${event.file}`);
  }
}
