// Shared subprocess-handoff logic: spawn the Python venv's extract_and_chunk.py
// for one PDF and return its parsed JSON. Factored out of handoff_test.js
// (N.1) so N.2 onward -- and eventually the real Express server -- can all
// call the same proven code instead of copy-pasting the spawn logic.

import { spawn } from "node:child_process";
import path from "node:path";
import { PROJECT_ROOT } from "./config.js";

// Point at the venv's own Python interpreter, not a bare "python3" -- that's
// the one with pypdf and requests actually installed into it.
const PYTHON_EXECUTABLE = path.join(PROJECT_ROOT, "python", ".venv", "bin", "python3");
const EXTRACT_SCRIPT = path.join(PROJECT_ROOT, "python", "extract_and_chunk.py");

export function runExtractAndChunk(pdfPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(PYTHON_EXECUTABLE, [EXTRACT_SCRIPT, pdfPath]);

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    // Python errors (including the "could not reach Ollama" message from
    // embed_chunks) land on stderr -- capture it so a failure is
    // explainable, not just "exited with code 1".
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    proc.on("close", (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`extract_and_chunk.py exited ${exitCode}\n${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout));
    });

    // If the Python executable itself can't be found/spawned at all (as
    // opposed to running and failing), 'close' never fires -- this catches
    // that case separately.
    proc.on("error", (err) => {
      reject(new Error(`failed to spawn python: ${err.message}`));
    });
  });
}
