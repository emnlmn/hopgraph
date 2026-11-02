// The executor (run/executor.ts): the barrier rule it keeps for comparison, and a tracer that
// cannot even start the run's own span.

import { describe, expect, it } from "vitest";
import { envelope, found } from "../../core/index.ts";
import { runWith } from "../executor.ts";
import { run } from "../index.ts";
import type { Tracer } from "../types.ts";
import { free, m, newGraph, options, providerOf, refs } from "./support.ts";

function build() {
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
  return g.graph(g.route("master", duration, g.itself("master")));
}

describe("the executor", () => {
  it("under the barrier rule answers what the plan rule does", async () => {
    const graph = build();
    const call = { refs: refs("master", "m1"), providers: ["duration"] };
    const planned = await run(graph, options(call));
    const barrier = await runWith(graph, options(call), "barrier");

    expect(providerOf(barrier, "m1", "duration").rows).toEqual(
      providerOf(planned, "m1", "duration").rows,
    );
    expect(barrier.status).toBe(planned.status);
  });

  it("a tracer that cannot start the run's span does not change the answer", async () => {
    const graph = build();
    const call = { refs: refs("master", "m1"), providers: ["duration"] };
    const plain = await run(graph, options(call));
    const down: Tracer = {
      startSpan: () => {
        throw new Error("exporter down");
      },
    };
    const traced = await run(graph, options({ ...call, tracer: down }));

    expect(traced).toEqual(plain);
  });

  it("with no provider asked, each base row answers with none", async () => {
    const result = await run(build(), options({ refs: refs("master", "m1"), providers: [] }));

    expect(result.rows.get("m1")?.providers).toEqual({});
    expect(result.status).toBe("complete");
  });
});
