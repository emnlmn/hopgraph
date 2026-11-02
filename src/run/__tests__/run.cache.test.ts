// The per-key cache (DESIGN.md §5.2; run/types.ts CachePort): every key of a step asked at once,
// only the missing keys loaded, an entry per (loader id, version, key, needs' and declared ctx
// values, restriction), found and absent kept with the loader's retention, an unknown never kept.

import { describe, expect, it } from "vitest";
import type { Batch, Kept, Retention } from "../../core/index.ts";
import { run } from "../index.ts";
import type { BaseRef } from "../types.ts";
import {
  type Behaviour,
  CTX,
  Deps,
  fake,
  free,
  MemoryCache,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  rowsOf,
  stepsOf,
  traceOf,
} from "./support.ts";

type Item = { readonly n: number };

function single(
  o: { version?: number; keep?: (k: Kept) => Retention; is?: Behaviour<Item>; batch?: Batch } = {},
) {
  const f = fake<Item>(o.is ?? { found: { t1: { n: 1 }, t2: { n: 2 }, t3: { n: 3 } } });
  const kept: Kept[] = [];
  const g = newGraph();
  const loader = g.loader({
    ...free,
    id: "items",
    version: o.version ?? 1,
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    batch: o.batch ?? { by: "partition" },
    keep: (k) => {
      kept.push(k);
      return (o.keep ?? free.keep)(k);
    },
    load: f.load,
  });
  const p = g.provider("items", {
    loader,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ n: v.n }],
    raw: { n: m("N") },
  });
  return { graph: g.graph(g.route("track", p, g.itself("track"))), f, kept };
}

/** A loader that needs a carried attribute: its answer depends on the key and that value. */
function windowed() {
  const header = fake<{ releasedAt: string }>({});
  const w = fake<Item>({ found: { t1: { n: 1 } } });
  const g = newGraph();
  const headerL = g.loader({
    ...free,
    id: "trackHeader",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: header.load,
  });
  g.hydrator("track", headerL, (v) => ({ releasedAt: v.releasedAt }));
  const loader = g.loader({
    ...free,
    id: "windowed",
    keyedBy: "track",
    needs: ["releasedAt"],
    connectors: { allOf: ["wh"] },
    load: w.load,
  });
  const p = g.provider("items", {
    loader,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ n: v.n }],
    raw: { n: m("N") },
  });
  return { graph: g.graph(g.route("track", p, g.itself("track"))), header, w };
}

/** A loader that reads the run's `today` (data: an entry per day) and its `deps` (a service). */
function daily() {
  const f = fake<Item>({ found: { t1: { n: 1 } } });
  const g = newGraph();
  const loader = g.loader({
    ...free,
    id: "daily",
    keyedBy: "track",
    ctx: ["today", "deps"],
    connectors: { allOf: ["db"] },
    load: f.load,
  });
  const p = g.provider("items", {
    loader,
    temporal: "current",
    rows: "one",
    project: (v) => [{ n: v.n }],
    raw: { n: m("N") },
  });
  return { graph: g.graph(g.route("track", p, g.itself("track"))), f };
}

const common = (a: Set<string>, b: Set<string>) => [...a].filter((k) => b.has(k));

describe("run: cache", () => {
  it("a second run loads only the keys the first did not answer, and cached answers project like loaded ones", async () => {
    const { graph, f } = single();
    const cache = new MemoryCache();
    const first = await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["items"], cache }),
    );
    const second = await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3"), providers: ["items"], cache }),
    );

    expect(f.calls.map((c) => [...c.keys].sort())).toEqual([["t1", "t2"], ["t3"]]);
    expect(rowsOf(providerOf(second, "t1", "items"))).toEqual(
      rowsOf(providerOf(first, "t1", "items")),
    );
    expect(rowsOf(providerOf(second, "t1", "items"))).toEqual([
      { ref: "t1", index: 0, fields: { n: 1 }, lineage: [[]] },
    ]);
    expect(traceOf(second, "provider:items")).toMatchObject({ keysIn: 3, cached: 2 });
  });

  it("asks the cache for every key of a step at once, whatever the loader's batches", async () => {
    const { graph } = single({ batch: { by: "keys", max: 2 } });
    const cache = new MemoryCache();
    await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3", "t4", "t5"), providers: ["items"], cache }),
    );

    expect(cache.gets.map((g) => g.length)).toEqual([5]);
  });

  it("keeps found and absent with the retention `keep` gives, never an unknown, which the next run reads again", async () => {
    const { graph, f } = single({
      is: { found: { t1: { n: 1 } }, unknown: { t3: { reason: "failed" } } },
      keep: (k) => (k.found ? "day" : "brief"),
    });
    const cache = new MemoryCache();
    await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3"), providers: ["items"], cache }),
    );

    expect(
      cache.sets
        .map((s) => ({ answer: s.answer, retention: s.retention }))
        .sort((a, b) => (a.answer.kind < b.answer.kind ? -1 : 1)),
    ).toEqual([
      { answer: { kind: "absent" }, retention: "brief" },
      { answer: { kind: "found", value: { n: 1 } }, retention: "day" },
    ]);

    await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3"), providers: ["items"], cache }),
    );
    expect(f.calls.map((c) => [...c.keys].sort())).toEqual([["t1", "t2", "t3"], ["t3"]]);
  });

  it("a retention of none writes nothing", async () => {
    const { graph, f } = single({ keep: () => "none" });
    const cache = new MemoryCache();
    await run(graph, options({ refs: refs("track", "t1", "t2"), providers: ["items"], cache }));
    await run(graph, options({ refs: refs("track", "t1", "t2"), providers: ["items"], cache }));

    expect(cache.sets).toEqual([]);
    expect(f.calls).toHaveLength(2);
  });

  it("a cut is shown to `keep`, kept with the value, and given back on a hit", async () => {
    const { graph, f, kept } = single({
      is: { found: { t1: { n: 1 } }, cut: { t1: { kind: "cap", limit: 50 } } },
    });
    const cache = new MemoryCache();
    await run(graph, options({ refs: refs("track", "t1"), providers: ["items"], cache }));
    const second = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: ["items"], cache }),
    );

    expect(kept).toEqual([{ found: true, absent: false, cut: { kind: "cap", limit: 50 } }]);
    expect(cache.sets.map((s) => s.answer)).toEqual([
      { kind: "found", value: { n: 1 }, cuts: [{ kind: "cap", limit: 50 }] },
    ]);
    expect(f.calls).toHaveLength(1);
    expect(providerOf(second, "t1", "items").cut).toEqual([{ kind: "cap", limit: 50 }]);
    expect(traceOf(second, "provider:items")).toMatchObject({ keysIn: 1, cached: 1, cut: 1 });
  });

  it("every cut and the per-key coverage are kept with the answer, found or absent, and given back on a hit", async () => {
    const SEARCHED = { label: "escalated to 180 days", days: 180 };
    const cuts = [
      { kind: "cap", limit: 50 },
      { kind: "days", days: 7 },
    ] as const;
    const { graph, f } = single({
      is: {
        found: { t1: { n: 1 } },
        cut: { t1: cuts },
        coverage: { t1: SEARCHED, t2: SEARCHED },
      },
    });
    const cache = new MemoryCache();
    await run(graph, options({ refs: refs("track", "t1", "t2"), providers: ["items"], cache }));
    const second = await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["items"], cache }),
    );

    expect(cache.sets.map((s) => s.answer).sort((a, b) => (a.kind < b.kind ? -1 : 1))).toEqual([
      { kind: "absent", coverage: SEARCHED },
      { kind: "found", value: { n: 1 }, cuts, coverage: SEARCHED },
    ]);
    expect(f.calls).toHaveLength(1);
    expect(providerOf(second, "t1", "items").cut).toEqual(cuts);
    expect(stepsOf(second, "t1", "provider:items")).toMatchObject([
      { outcome: "found", cuts, coverage: SEARCHED },
    ]);
    expect(providerOf(second, "t2", "items")).toMatchObject({
      outcome: "absent",
      coverage: [SEARCHED],
    });
  });

  it("the restriction is part of every key: two restrictions never share an entry", async () => {
    const { graph, f } = single();
    const cache = new MemoryCache();
    await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["items"], cache, restriction: "a" }),
    );
    const writtenA = cache.written();
    const asked = cache.gets.length;
    await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["items"], cache, restriction: "b" }),
    );
    const askedB = new Set(cache.gets.slice(asked).flat());

    expect(f.calls.map((c) => [...c.keys].sort())).toEqual([
      ["t1", "t2"],
      ["t1", "t2"],
    ]);
    expect(common(askedB, writtenA)).toEqual([]);
    expect(cache.written().size).toBe(2 * writtenA.size);
  });

  it("the loader version is part of every key: a bumped loader reads again", async () => {
    const v1 = single({ version: 1 });
    const v2 = single({ version: 2 });
    const cache = new MemoryCache();
    await run(v1.graph, options({ refs: refs("track", "t1"), providers: ["items"], cache }));
    const writtenV1 = cache.written();
    await run(v2.graph, options({ refs: refs("track", "t1"), providers: ["items"], cache }));

    expect(v2.f.loaded()).toEqual(["t1"]);
    expect(cache.written().size).toBe(2 * writtenV1.size);
  });

  it("the needs' values are part of the key: the same key with another need value is read again, the same one is not", async () => {
    const { graph, w, header } = windowed();
    const cache = new MemoryCache();
    const at = (releasedAt: string): BaseRef[] => [
      { row: "t1", entity: "track", key: "t1", carries: { releasedAt } },
    ];
    await run(graph, options({ refs: at("2026-10-01"), providers: ["items"], cache }));
    await run(graph, options({ refs: at("2025-06-01"), providers: ["items"], cache }));
    await run(graph, options({ refs: at("2026-10-01"), providers: ["items"], cache }));

    expect(header.calls).toEqual([]);
    expect(w.calls.map((c) => c.refs)).toEqual([
      [expect.objectContaining({ key: "t1", releasedAt: "2026-10-01" })],
      [expect.objectContaining({ key: "t1", releasedAt: "2025-06-01" })],
    ]);
  });

  it("a ctx value the loader declares is part of the key: another `today` reads again, the same one does not", async () => {
    const { graph, f } = daily();
    const cache = new MemoryCache();
    const on = (today: string) =>
      run(
        graph,
        options({
          refs: refs("track", "t1"),
          providers: ["items"],
          cache,
          ctx: { ...CTX, today },
        }),
      );
    await on("2026-11-01");
    await on("2026-11-02");
    await on("2026-11-01");

    expect(f.calls).toHaveLength(2);
  });

  it("a declared service in the ctx is not part of the key: another `deps` instance is a hit", async () => {
    const { graph, f } = daily();
    const cache = new MemoryCache();
    const using = (deps: Deps) =>
      run(
        graph,
        options({ refs: refs("track", "t1"), providers: ["items"], cache, ctx: { ...CTX, deps } }),
      );
    await using(new Deps(1));
    await using(new Deps(2));

    expect(f.calls).toHaveLength(1);
  });
});
