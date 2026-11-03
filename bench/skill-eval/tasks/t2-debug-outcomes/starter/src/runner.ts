// The app's runner, made once at startup and shared by every request.

import { createRunner, memoryCache } from "hopgraph";
import { graph } from "./graph.ts";

// In-process cache. Production plugs Redis in here through a CachePort.
export const runner = createRunner(graph, {
  cache: memoryCache(),
  limits: { db: 8 },
});
