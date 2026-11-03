// The app's runner, made once at startup and shared by every request.

import { createRunner, memoryCache } from "hopgraph";
import { graph } from "./graph.ts";

export const runner = createRunner(graph, {
  // what a run read is a cache hit on resume, so it is not billed twice
  cache: memoryCache(),
  limits: { db: 8, warehouse: 2 },
});
