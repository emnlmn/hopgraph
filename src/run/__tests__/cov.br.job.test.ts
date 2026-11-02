// Edges of one job (run/job.ts): a run that stops at each point a job checks for it (before it
// starts, while the cache answers, once the cache answered, while an approval of more keys is looked
// up), a merging loader asked once per key, a merged read gated twice, and the job's guards on its
// own invariants.

import { describe, expect, it } from "vitest";
import { CostChangedError, type Envelope, envelope, HopgraphError } from "../../core/index.ts";
import { run } from "../index.ts";
import { answered, costChanged } from "../job.ts";
import type { CachedAnswer, CachePort, Tracer } from "../types.ts";
import {
  fake,
  free,
  MemoryCache,
  m,
  NOW,
  newGraph,
  options,
  providerOf,
  recorder,
  refs,
} from "./support.ts";

/** Plays of a track, read by a free loader, or by a metered one priced at 5e9 (a gate). */
function plays(metered = false) {
  const f = fake<{ plays: number }>({
    found: { t1: { plays: 10 }, t2: { plays: 20 } },
    price: 5e9,
  });
  const g = newGraph();
  const loader = g.loader({
    ...free,
    id: "plays",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.load,
    ...(metered
      ? { cost: { metered: { auto: 1e9, approve: 1e11 } }, price: f.price }
      : { cost: undefined }),
  });
  const provider = g.provider("plays", {
    loader,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ plays: v.plays }],
    raw: { plays: m("Plays") },
  });
  return { f, graph: g.graph(g.route("track", provider, g.itself("track"))) };
}

/** A tracer that records, and calls `on` with the name of each span as it starts. */
function watching(on: (name: string) => void): ReturnType<typeof recorder> {
  const r = recorder();
  const tracer: Tracer = {
    startSpan(name, attributes, parent) {
      on(name);
      return r.tracer.startSpan(name, attributes, parent);
    },
  };
  return { tracer, spans: r.spans };
}

const batchOf = (spans: ReturnType<typeof recorder>["spans"]) => {
  const batch = spans.find((s) => s.name === "hopgraph.batch");
  if (!batch) throw new Error("no job span");
  return batch;
};

describe("job: the run stops", () => {
  it("between the job's scheduling and its start: the cache is not asked, every key is unknown deadline", async () => {
    const { f, graph } = plays();
    const clock = { now: NOW };
    const cache = new MemoryCache();
    const { tracer, spans } = watching((name) => {
      if (name === "hopgraph.batch") clock.now = NOW + 5_000;
    });

    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["plays"],
        deadline: NOW + 1_000,
        clock: () => clock.now,
        cache,
        tracer,
      }),
    );

    expect(cache.gets).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(providerOf(result, "t1", "plays").unknown).toEqual([{ reason: "deadline" }]);
    expect(batchOf(spans).attributes["hopgraph.admission"]).toBe("stopped");
    expect(spans.some((s) => s.name === "hopgraph.cache.read")).toBe(false);
  });

  it("while the cache answers: the job does not wait for it, and every key is unknown deadline", async () => {
    const { f, graph } = plays();
    const asked: (readonly string[])[] = [];
    const cache: CachePort = {
      getMany: (keys) => {
        asked.push(keys);
        return new Promise<ReadonlyMap<string, CachedAnswer>>(() => undefined);
      },
      setMany: async () => undefined,
    };
    const { tracer, spans } = recorder();

    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["plays"],
        deadline: Date.now() + 20,
        clock: Date.now,
        cache,
        tracer,
      }),
    );

    expect(asked).toHaveLength(1);
    expect(f.calls).toEqual([]);
    expect(providerOf(result, "t1", "plays").unknown).toEqual([{ reason: "deadline" }]);
    const batch = batchOf(spans);
    expect(batch.attributes["hopgraph.admission"]).toBe("stopped");
    expect(batch.attributes["hopgraph.cache.hits"]).toBe(0);
    expect(spans.find((s) => s.name === "hopgraph.cache.read")?.ended).toBe(true);
  });

  it("once the cache answered: what it answered stands, the keys it did not answer are unknown deadline and not loaded", async () => {
    const { f, graph } = plays();
    const memory = new MemoryCache();
    await run(graph, options({ refs: refs("track", "t1"), providers: ["plays"], cache: memory }));
    expect(f.loaded()).toEqual(["t1"]);

    const clock = { now: NOW };
    const cache: CachePort = {
      getMany: async (keys) => {
        const hits = await memory.getMany(keys);
        clock.now = NOW + 5_000;
        return hits;
      },
      setMany: (entries) => memory.setMany(entries),
    };
    const { tracer, spans } = recorder();
    const result = await run(
      graph,
      options({
        refs: refs("track", "t1", "t2"),
        providers: ["plays"],
        deadline: NOW + 1_000,
        clock: () => clock.now,
        cache,
        tracer,
      }),
    );

    expect(f.loaded()).toEqual(["t1"]);
    expect(providerOf(result, "t1", "plays")).toMatchObject({
      outcome: "found",
      rows: [{ fields: { plays: 10 } }],
    });
    expect(providerOf(result, "t2", "plays").unknown).toEqual([{ reason: "deadline" }]);
    const batch = batchOf(spans);
    expect(batch.attributes["hopgraph.admission"]).toBe("stopped");
    expect(batch.attributes["hopgraph.cache.hits"]).toBe(1);
  });

  it("while an approval of more keys of the loader is looked up: nothing is loaded, no gate, every key unknown deadline", async () => {
    const { f, graph } = plays(true);
    const memory = new MemoryCache();
    let reads = 0;
    const cache: CachePort = {
      // the job's own lookup answers; the scopes of the approvals never come
      getMany: (keys) => {
        reads += 1;
        return reads === 1
          ? memory.getMany(keys)
          : new Promise<ReadonlyMap<string, CachedAnswer>>(() => undefined);
      },
      setMany: (entries) => memory.setMany(entries),
    };
    const { tracer, spans } = recorder();

    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["plays"],
        approved: { "plays:an-approval-of-more-keys": 1e10 },
        deadline: Date.now() + 20,
        clock: Date.now,
        cache,
        tracer,
      }),
    );

    expect(reads).toBe(2);
    expect(f.prices).toEqual([["t1"]]);
    expect(f.calls).toEqual([]);
    expect(result.gates).toEqual([]);
    expect(providerOf(result, "t1", "plays").unknown).toEqual([{ reason: "deadline" }]);
    expect(batchOf(spans).attributes["hopgraph.admission"]).toBe("stopped");
  });
});

/** Recent tracks of an artist, carrying when each was released, and a loader of tracks that reads
 *  that date and merges the refs of one track. `similar` leads a track to itself, released at
 *  another date, so a later wave reads the same track again. The loader is metered, priced at
 *  `price`: under its auto cap it runs. */
function windowed(needs: () => { releasedAt: string } | undefined, price = 0) {
  const calls: { key: string; releasedAt: string }[][] = [];
  const g = newGraph();
  const recentL = g.loader({
    ...free,
    id: "recentTracks",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: async (rs): Promise<Envelope<string, { track: string; releasedAt: string }[]>> =>
      envelope(
        rs.map((r) => [
          r.key,
          { kind: "found", value: [{ track: "t1", releasedAt: r.key === "a1" ? "1" : "2" }] },
        ]),
      ),
  });
  const similarL = g.loader({
    ...free,
    id: "similar",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: async (rs): Promise<Envelope<string, { releasedAt: string }[]>> =>
      envelope(
        rs.map((r) => [
          r.key,
          { kind: "found", value: [{ releasedAt: "3" }, { releasedAt: "4" }] },
        ]),
      ),
  });
  const windowedL = g.loader({
    ...free,
    id: "windowed",
    keyedBy: "track",
    needs: ["releasedAt"],
    connectors: { allOf: ["wh"] },
    cost: { metered: { auto: 1e9, approve: 1e11 } },
    price: async () => price,
    load: async (rs): Promise<Envelope<string, { n: number }>> => {
      calls.push(rs.map((r) => ({ key: r.key, releasedAt: r.releasedAt })));
      return envelope(rs.map((r) => [r.key, { kind: "found", value: { n: 1 } }]));
    },
    merge: { needs, narrow: (v: { n: number }) => v, empty: { n: 0 } },
  });
  const recent = g.relation("artist", "track", "recent", {
    cardinality: "1:N",
    strategies: (s) => [
      s(recentL, {
        project: (_ref, v) =>
          v.map((x) => ({ to: x.track, carries: { releasedAt: x.releasedAt } })),
      }),
    ],
  });
  const similar = g.relation("track", "track", "similar", {
    cardinality: "1:N",
    strategies: (s) => [
      s(similarL, {
        project: (ref, v) => v.map((x) => ({ to: ref.key, carries: { releasedAt: x.releasedAt } })),
      }),
    ],
  });
  const spec = {
    loader: windowedL,
    temporal: "historical",
    rows: "one",
    project: (v: { n: number }) => [{ n: v.n }],
    raw: { n: m("N") },
  } as const;
  const graph = g.graph(
    g.route("artist", g.provider("near", spec), g.path(recent)),
    g.route("artist", g.provider("far", spec), g.path(recent, similar)),
  );
  return { graph, calls };
}

describe("job: a merging loader", () => {
  it("a key one ref asks for is read as that ref reads it, without asking the merge", async () => {
    let merges = 0;
    const { graph, calls } = windowed(() => {
      merges += 1;
      return { releasedAt: "0" };
    });

    const result = await run(graph, options({ refs: refs("artist", "a1"), providers: ["near"] }));

    expect(merges).toBe(0);
    expect(calls).toEqual([[{ key: "t1", releasedAt: "1" }]]);
    expect(providerOf(result, "a1", "near").outcome).toBe("found");
  });

  it("a merged read gated in one wave and asked again in a later one is one gate, its scope kept once", async () => {
    const { graph, calls } = windowed(() => ({ releasedAt: "0" }), 5e9);
    const cache = new MemoryCache();

    const result = await run(
      graph,
      options({ refs: refs("artist", "a1", "a2"), providers: ["near", "far"], cache }),
    );

    expect(calls).toEqual([]);
    expect(result.gates).toHaveLength(1);
    const scopes = cache.sets.filter((s) => s.retention === "hour");
    expect(scopes).toHaveLength(1);
    for (const row of ["a1", "a2"])
      for (const p of ["near", "far"])
        expect(providerOf(result, row, p).unknown, `${row} ${p}`).toEqual([
          { reason: "awaiting_approval", bytes: 5e9 },
        ]);
  });
});

describe("job: guards on its own invariants", () => {
  it("a key a job left unanswered is the executor's bug, refused as such", () => {
    expect(() => answered(undefined)).toThrow(HopgraphError);
    expect(() => answered(undefined)).toThrow(expect.objectContaining({ code: "HG_INTERNAL" }));
    expect(answered({ kind: "absent" })).toEqual({ kind: "absent" });
  });

  it("what deciding a gate throws other than a cost changed goes on as it was", () => {
    const changed = new CostChangedError("g", 1, 2);
    expect(costChanged(changed)).toBe(changed);
    const bug = new TypeError("bug");
    expect(() => costChanged(bug)).toThrow(bug);
  });
});
