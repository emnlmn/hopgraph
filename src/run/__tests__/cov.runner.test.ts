// The runner's `read` (run/runner.ts): a provider given as itself when no key is given.

import { describe, expect, it } from "vitest";
import { envelope, found } from "../../core/index.ts";
import { createRunner } from "../index.ts";
import { CTX, free, m, newGraph } from "./support.ts";

describe("a runner's read", () => {
  it("with no key and a provider passed as itself, answers no rows", async () => {
    const g = newGraph();
    const loader = g.loader({
      ...free,
      id: "durations",
      keyedBy: "master",
      connectors: { allOf: ["wh"] },
      load: async (keys) => envelope(keys.map((k) => [k.key, found({ minutes: 3 })])),
    });
    const duration = g.provider("duration", {
      loader,
      temporal: "current",
      rows: "one",
      project: (v) => [{ minutes: v.minutes }],
      raw: { minutes: m("Minutes") },
    });
    const graph = g.graph(g.route("master", duration, g.itself("master")));
    const runner = createRunner(graph, { limits: { db: 1, wh: 1, api: 1 } });

    const result = await runner.read("master", [], [duration], { ctx: CTX });
    expect(result.rows.size).toBe(0);
  });
});
