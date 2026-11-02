// The trace (DESIGN.md §6; run/types.ts TraceStep): aggregated per step, with the keys in
// (distinct), how many came from the cache, found, absent, unknown by reason, cut, and the bytes
// billed.

import { describe, expect, it } from "vitest";
import { run } from "../index.ts";
import type { BaseRef, TraceStep } from "../types.ts";
import {
  type Behaviour,
  fake,
  free,
  MemoryCache,
  m,
  newGraph,
  options,
  refs,
  traceOf,
} from "./support.ts";

function single(is: Behaviour<{ n: number }>) {
  const f = fake(is);
  const g = newGraph();
  const loader = g.loader({
    ...free,
    id: "items",
    keyedBy: "track",
    connectors: { allOf: ["wh"] },
    cost: { metered: { auto: 1e9, approve: 1e11 } },
    price: f.price,
    load: f.load,
  });
  const p = g.provider("items", {
    loader,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ n: v.n }],
    raw: { n: m("N") },
  });
  return { graph: g.graph(g.route("track", p, g.itself("track"))), f };
}

function chain() {
  const f = {
    header: fake<{ releasedAt: string }>({
      found: { t1: { releasedAt: "2026-10-01" } },
      unknown: { t5: { reason: "failed" } },
    }),
    near: fake<{ masters: string[] }>({ found: { t1: { masters: ["m1", "m2"] } } }),
    masterInfo: fake<{ minutes: number }>({ found: { m1: { minutes: 1 }, m2: { minutes: 2 } } }),
  };
  const g = newGraph();
  const headerL = g.loader({
    ...free,
    id: "trackHeader",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.header.load,
  });
  g.hydrator("track", headerL, (v) => ({ releasedAt: v.releasedAt }));
  const nearL = g.loader({
    ...free,
    id: "near",
    keyedBy: "track",
    needs: ["releasedAt"],
    connectors: { allOf: ["wh"] },
    load: f.near.load,
  });
  const masterInfoL = g.loader({
    ...free,
    id: "masterInfo",
    keyedBy: "master",
    connectors: { allOf: ["db"] },
    load: f.masterInfo.load,
  });
  const near = g.relation("track", "master", "near", {
    cardinality: "1:N",
    strategies: (s) => [s(nearL, { project: (_ref, v) => v.masters.map((p) => ({ to: p })) })],
  });
  const masterInfo = g.provider("masterInfo", {
    loader: masterInfoL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ minutes: v.minutes }],
    raw: { minutes: m("Minutes") },
  });
  return { graph: g.graph(g.route("track", masterInfo, g.path(near))), near };
}

/** found + absent + unknown of every reason = keys in */
const balanced = (t: TraceStep) =>
  t.found + t.absent + Object.values(t.unknown).reduce((a, n) => a + (n ?? 0), 0) === t.keysIn;

describe("run: trace", () => {
  it("one entry per step: distinct keys in, cached, found (cached included), absent, unknown by reason, cut, billed bytes", async () => {
    const { graph } = single({
      found: { t1: { n: 1 }, t2: { n: 2 } },
      unknown: { t4: { reason: "failed" } },
      cut: { t2: { kind: "cap", limit: 10 } },
      price: 5e5,
      billedBytes: 1234,
    });
    const cache = new MemoryCache();
    await run(graph, options({ refs: refs("track", "t1"), providers: ["items"], cache }));
    const twice: BaseRef[] = [
      ...refs("track", "t1", "t2", "t3", "t4"),
      { row: "t2-again", entity: "track", key: "t2" },
    ];
    const result = await run(graph, options({ refs: twice, providers: ["items"], cache }));

    const t = traceOf(result, "provider:items");
    expect(t).toMatchObject({
      step: "provider:items",
      loader: "items",
      keysIn: 4,
      cached: 1,
      found: 2,
      absent: 1,
      unknown: { failed: 1 },
      cut: 1,
      billedBytes: 1234,
    });
    expect(t.ms).toBeGreaterThanOrEqual(0);
    expect(result.trace).toHaveLength(1);
    expect(result.billedBytes).toBe(1234);
  });

  it("a hydration, a relation and a provider each have their entry, an unmet need counted under its reason", async () => {
    const { graph, near } = chain();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t5"), providers: ["masterInfo"] }),
    );

    expect(result.trace.map((t) => `${t.step} / ${t.loader}`).sort()).toEqual(
      [
        `${near.id} / near`,
        "hydrate:track / trackHeader",
        "provider:masterInfo / masterInfo",
      ].sort(),
    );
    expect(traceOf(result, "hydrate:track")).toMatchObject({
      keysIn: 2,
      cached: 0,
      found: 1,
      absent: 0,
      unknown: { failed: 1 },
      cut: 0,
      billedBytes: 0,
    });
    expect(traceOf(result, near.id)).toMatchObject({
      keysIn: 2,
      found: 1,
      absent: 0,
      unknown: { unmet: 1 },
    });
    expect(traceOf(result, "provider:masterInfo")).toMatchObject({
      keysIn: 2,
      found: 2,
      absent: 0,
    });
    expect(traceOf(result, "provider:masterInfo").unknown).toEqual({});
    for (const t of result.trace) expect(balanced(t), t.step).toBe(true);
  });
});
