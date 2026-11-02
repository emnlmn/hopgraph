// Batching and concurrency (DESIGN.md §3.1): batching is the loader's (N keys per statement, one
// job over the partitions, one key per call under a bound), concurrency is the connector's (every
// loader on a connector under its limit), and a failed statement voids its batch (`drop`) or only
// the keys it took (`keep`).

import { describe, expect, it } from "vitest";
import type { Batch } from "../../core/index.ts";
import { run } from "../index.ts";
import {
  type Behaviour,
  type Conn,
  fake,
  free,
  Inflight,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  sorted,
  stepsOf,
} from "./support.ts";

type Item = { readonly n: number };
const items: Record<string, Item> = {
  t1: { n: 1 },
  t2: { n: 2 },
  t3: { n: 3 },
  t4: { n: 4 },
  t5: { n: 5 },
};

/** One provider over one loader, keyed by the base entity: one step, the loader's batching
 *  alone. */
function single(batch: Batch, partial: "keep" | "drop" = "keep", is: Behaviour<Item> = {}) {
  const f = fake<Item>({ found: items, ...is });
  const g = newGraph();
  const loader = g.loader({
    ...free,
    id: "items",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    batch,
    partial,
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

/** Two providers over two loaders on the given connectors, both keyed by the base entity. */
function pair(conns: readonly [Conn, Conn], batch: Batch) {
  const shared = new Inflight();
  const a = fake<Item>({ found: items, delayMs: 10, trackers: [shared] });
  const b = fake<Item>({ found: items, delayMs: 10, trackers: [shared] });
  const g = newGraph();
  const la = g.loader({
    ...free,
    id: "a",
    keyedBy: "track",
    connectors: { allOf: [conns[0]] },
    batch,
    load: a.load,
  });
  const lb = g.loader({
    ...free,
    id: "b",
    keyedBy: "track",
    connectors: { allOf: [conns[1]] },
    batch,
    load: b.load,
  });
  const spec = { temporal: "historical", rows: "one", raw: { n: m("N") } } as const;
  return {
    graph: g.graph(
      g.route(
        "track",
        g.provider("pa", { ...spec, loader: la, project: (v) => [{ n: v.n }] }),
        g.itself("track"),
      ),
      g.route(
        "track",
        g.provider("pb", { ...spec, loader: lb, project: (v) => [{ n: v.n }] }),
        g.itself("track"),
      ),
    ),
    a,
    b,
    shared,
  };
}

const ALL = ["t1", "t2", "t3", "t4", "t5"];

describe("run: batching", () => {
  it("by keys: at most N keys per call, every key loaded exactly once", async () => {
    const { graph, f } = single({ by: "keys", max: 2 });
    const result = await run(graph, options({ refs: refs("track", ...ALL), providers: ["items"] }));

    expect(f.calls.map((c) => c.keys.length).sort()).toEqual([1, 2, 2]);
    expect(f.loaded()).toEqual(ALL);
    for (const k of ALL) expect(providerOf(result, k, "items").outcome).toBe("found");
  });

  it("by partition: one call with every key", async () => {
    const { graph, f } = single({ by: "partition" });
    await run(graph, options({ refs: refs("track", ...ALL), providers: ["items"] }));

    expect(f.calls.map((c) => sorted(c.keys))).toEqual([ALL]);
  });

  it("one at a time: one key per call, never more in flight than the loader's concurrency, and that many used", async () => {
    const { graph, f } = single({ by: "one", concurrency: 2 }, "keep", { delayMs: 10 });
    await run(graph, options({ refs: refs("track", ...ALL), providers: ["items"] }));

    expect(f.calls.every((c) => c.keys.length === 1)).toBe(true);
    expect(f.loaded()).toEqual(ALL);
    expect(f.inflight.max).toBe(2);
  });

  it("a connector's limit holds every loader on it together", async () => {
    const { graph, shared, a, b } = pair(["db", "db"], { by: "one", concurrency: 4 });
    await run(
      graph,
      options({
        refs: refs("track", "t1", "t2", "t3", "t4"),
        providers: ["pa", "pb"],
        limits: { db: 3, wh: 8, api: 8 },
      }),
    );

    expect(a.loaded()).toEqual(["t1", "t2", "t3", "t4"]);
    expect(b.loaded()).toEqual(["t1", "t2", "t3", "t4"]);
    expect(shared.max).toBe(3);
  });

  it("a limit of 1 serialises two independent loaders on the same connector", async () => {
    const { graph, shared } = pair(["db", "db"], { by: "partition" });
    await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["pa", "pb"],
        limits: { db: 1, wh: 8, api: 8 },
      }),
    );

    expect(shared.max).toBe(1);
  });

  it("loaders on different connectors are not held by each other's limit", async () => {
    const { graph, shared } = pair(["db", "wh"], { by: "partition" });
    await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["pa", "pb"],
        limits: { db: 1, wh: 1, api: 1 },
      }),
    );

    expect(shared.max).toBe(2);
  });

  it("a limit that is not a whole number from 1 or Infinity is refused before anything is read", async () => {
    const { graph, a } = pair(["db", "db"], { by: "partition" });
    // NaN is what `Number(process.env.X)` gives when X is unset: it held every load until the
    // deadline
    for (const db of [Number.NaN, 0, -1, 1.5]) {
      const error = await run(
        graph,
        options({ refs: refs("track", "t1"), providers: ["pa"], limits: { db } }),
      ).catch((e: unknown) => e);
      expect(error, String(db)).toMatchObject({ code: "HG_SPEC" });
    }
    expect(a.calls).toEqual([]);
    const unbounded = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["pa"],
        limits: { db: Number.POSITIVE_INFINITY },
      }),
    );
    expect(providerOf(unbounded, "t1", "pa").outcome).toBe("found");
  });
});

describe("run: a failed statement", () => {
  const failing = { unknown: { t3: { reason: "failed" } } } as const;

  it("partial drop: the batch holding the failure is void, every key in it unknown failed; other batches stand", async () => {
    const { graph, f } = single({ by: "keys", max: 2 }, "drop", failing);
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3", "t4"), providers: ["items"] }),
    );

    const voided = f.calls.find((c) => c.keys.includes("t3"))?.keys ?? [];
    expect(voided).toHaveLength(2);
    for (const k of ["t1", "t2", "t3", "t4"]) {
      const p = providerOf(result, k, "items");
      if (voided.includes(k)) {
        expect(p.outcome, k).toBe("unknown");
        expect(p.unknown, k).toEqual([{ reason: "failed" }]);
        expect(p.rows, k).toEqual([]);
        expect(stepsOf(result, k, "provider:items")).toMatchObject([
          { outcome: "unknown", reason: { reason: "failed" } },
        ]);
      } else {
        expect(p.outcome, k).toBe("found");
      }
    }
  });

  it("partial keep: only the key the failure took is unknown, its batch partner stays found", async () => {
    const { graph } = single({ by: "keys", max: 2 }, "keep", failing);
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3", "t4"), providers: ["items"] }),
    );

    expect(providerOf(result, "t3", "items").unknown).toEqual([{ reason: "failed" }]);
    for (const k of ["t1", "t2", "t4"])
      expect(providerOf(result, k, "items").outcome).toBe("found");
  });

  it("a load that throws anyway: its keys are unknown failed, never absent, and the run still answers", async () => {
    const { graph } = single({ by: "partition" }, "keep", { throws: true });
    const result = await run(graph, options({ refs: refs("track", "t1"), providers: ["items"] }));

    const p = providerOf(result, "t1", "items");
    expect(p.outcome).toBe("unknown");
    expect(p.unknown).toEqual([{ reason: "failed" }]);
  });
});
