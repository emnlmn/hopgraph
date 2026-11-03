// The app's runner, made once at startup and shared by every request.

import { createRunner } from "hopgraph";
import { graph } from "./graph.ts";

export const runner = createRunner(graph, {
  limits: { db: 8, warehouse: 2 },
});
