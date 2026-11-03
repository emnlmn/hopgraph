// The app's runner, made once at startup and shared by every request (and every user).

import { createRunner, memoryCache } from "hopgraph";
import { graph } from "./graph.ts";

/** In-process cache shared by every request. Production plugs Redis in here through a CachePort. */
export const cache = memoryCache();

export const runner = createRunner(graph, {
  cache,
  limits: { db: 8, analytics: 4 },
});
