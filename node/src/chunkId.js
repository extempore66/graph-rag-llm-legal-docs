// The one place chunk_id gets constructed, project-wide -- this string is
// the only thing linking a chunk's row in LanceDB to its record in
// ArangoDB (see _project_step_by_step_plan.md, "chunk<->graph linking
// pattern"). Keeping it in one function means both databases can never
// disagree on the format.

import path from "node:path";

export function buildChunkId(sourceFilePath, chunkIndex) {
  const docId = path.basename(sourceFilePath, path.extname(sourceFilePath));
  return `${docId}_${chunkIndex}`;
}
