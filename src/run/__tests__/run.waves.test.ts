// Waves (DESIGN.md §3.1 "one job per batch of missing keys"): reads of one loader that become ready
// in the same wave, from different steps (providers, relation strategies, verifications), are one
// job: one cache lookup, one price and gate, one set of calls per the loader's batch policy, even
// when the reads that led to them took different times. A step still waiting for some of its
// inputs offers the refs it has to that job, so they are not read again in a later one.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { run } from "../index.ts";
import {
  fake,
  free,
  MemoryCache,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  refsOf,
  sorted,
} from "./support.ts";

type Tracks = { readonly track: string }[];
const METERED = { metered: { auto: 1e9, approve: 1e11 } } as const;

/** From an artist, a fast and a slow way to tracks; two providers over one loader of tracks. */
function build(o: { metered?: boolean } = {}) {
  const f = {
    recent: fake<Tracks>({ found: { a1: [{ track: "t1" }] }, delayMs: 2 }),
    old: fake<Tracks>({ found: { a1: [{ track: "t2" }] }, delayMs: 15 }),
    ids: fake<Tracks>({ found: { a1: [{ track: "t1" }, { track: "t3" }] }, delayMs: 2 }),
    tracks: fake<{ plays: number }>({
      found: { t1: { plays: 1 }, t2: { plays: 2 }, t3: { plays: 3 } },
      price: 5e9,
    }),
    plays: fake<{ plays: number }>({ found: { t1: { plays: 1 } } }),
    regions: fake<{ name: string }>({ found: { r1: { name: "North" }, r2: { name: "South" } } }),
  };
  const g = newGraph();
  const on = (id: string, load: (typeof f)["recent"]["load"]) =>
    g.loader({ ...free, id, keyedBy: "artist", connectors: { allOf: ["db"] }, load });
  const recentL = on("recent", f.recent.load);
  const oldL = on("old", f.old.load);
  const idsL = on("ids", f.ids.load);
  const tracksL = o.metered
    ? g.loader({
        ...free,
        id: "tracks",
        keyedBy: "track",
        connectors: { allOf: ["wh"] },
        cost: METERED,
        price: f.tracks.price,
        load: f.tracks.load,
      })
    : g.loader({
        ...free,
        id: "tracks",
        keyedBy: "track",
        connectors: { allOf: ["wh"] },
        load: f.tracks.load,
      });
  const playsL = g.loader({
    ...free,
    id: "plays",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.plays.load,
  });
  const toTracks = (_ref: unknown, v: Tracks) => v.map((x) => ({ to: x.track }));
  const recent = g.relation("artist", "track", "recent", {
    cardinality: "1:N",
    strategies: (s) => [s(recentL, { project: toTracks })],
  });
  const old = g.relation("artist", "track", "old", {
    cardinality: "1:N",
    strategies: (s) => [s(oldL, { project: toTracks })],
  });
  const byId = g.relation("artist", "track", "byId", {
    cardinality: "1:N",
    link: z.object({}),
    strategies: (s) => [
      s(idsL, { project: (_ref, v) => v.map((x) => ({ to: x.track, attrs: {} })) }),
    ],
    // the verification reads the same loader of tracks as the providers
    verify: (v) =>
      v(tracksL, (candidates) => candidates.map((c) => (c.state === "found" ? "keep" : "drop"))),
  });
  // a track's region, read from the same loader of tracks the verification reads
  const ofRegion = g.relation("track", "region", "of", {
    cardinality: "N:1",
    strategies: (s) => [s(tracksL, { project: (_ref, v) => [{ to: `r${v.plays}` }] })],
  });
  const regionsL = g.loader({
    ...free,
    id: "regions",
    keyedBy: "region",
    connectors: { allOf: ["db"] },
    load: f.regions.load,
  });
  const spec = {
    loader: tracksL,
    temporal: "historical",
    rows: "one",
    project: (v: { plays: number }) => [{ plays: v.plays }],
    raw: { plays: m("Plays") },
  } as const;
  return {
    graph: g.graph(
      g.route(
        "artist",
        g.provider("region", {
          loader: regionsL,
          temporal: "current",
          rows: "one",
          project: (v) => [{ name: v.name }],
          raw: { name: m("Region") },
        }),
        g.union(g.path(old, ofRegion), g.path(byId, ofRegion)),
      ),
      g.route("artist", g.provider("fast", spec), g.path(recent)),
      g.route("artist", g.provider("slow", spec), g.path(old)),
      g.route(
        "artist",
        g.provider("verified", {
          loader: playsL,
          temporal: "historical",
          rows: "one",
          project: (v) => [{ plays: v.plays }],
          raw: { plays: m("Plays") },
        }),
        g.path(byId),
      ),
    ),
    f,
  };
}

describe("run: waves", () => {
  it("two steps reading one loader at the same depth read it in one call, whatever the reads before took", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({ refs: refs("artist", "a1"), providers: ["fast", "slow"] }),
    );

    expect(f.tracks.calls.map((c) => sorted(c.keys))).toEqual([["t1", "t2"]]);
    expect(refsOf(providerOf(result, "a1", "fast"))).toEqual(["t1"]);
    expect(refsOf(providerOf(result, "a1", "slow"))).toEqual(["t2"]);
  });

  it("a verification and a provider reading one loader in the same wave are one job", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({ refs: refs("artist", "a1"), providers: ["slow", "verified"] }),
    );

    expect(f.tracks.calls.map((c) => sorted(c.keys))).toEqual([["t1", "t2", "t3"]]);
    expect(refsOf(providerOf(result, "a1", "slow"))).toEqual(["t2"]);
    expect(refsOf(providerOf(result, "a1", "verified"))).toEqual(["t1"]);
  });

  it("a step waiting for a verified input offers the refs it has to the verification's read: one job", async () => {
    const { graph, f } = build();
    const result = await run(graph, options({ refs: refs("artist", "a1"), providers: ["region"] }));

    // `track › region:of` waits for `byId`, whose verification reads tracks in the wave after
    // `old` gave t2: that read takes t2 along, and the step finds every key answered
    expect(f.tracks.calls.map((c) => sorted(c.keys))).toEqual([["t1", "t2", "t3"]]);
    expect(refsOf(providerOf(result, "a1", "region"))).toEqual(["r1", "r2"]);
  });

  it("a metered loader read by two steps in one wave is priced once and gated once, then loaded in one call", async () => {
    const { graph, f } = build({ metered: true });
    const cache = new MemoryCache();
    const ask = (approved?: Record<string, number>) =>
      run(
        graph,
        options({
          refs: refs("artist", "a1"),
          providers: ["fast", "slow"],
          cache,
          ...(approved ? { approved } : {}),
        }),
      );
    const gated = await ask();

    expect(f.tracks.prices.map((keys) => sorted(keys))).toEqual([["t1", "t2"]]);
    expect(gated.gates).toEqual([
      {
        id: expect.any(String),
        step: "provider:fast + provider:slow",
        loader: "tracks",
        keys: 2,
        bytes: 5e9,
      },
    ]);
    expect(f.tracks.calls).toEqual([]);

    const gate = gated.gates[0];
    if (!gate) throw new Error("expected a gate");
    const resumed = await ask({ [gate.id]: gate.bytes });
    expect(resumed.status).toBe("complete");
    expect(f.tracks.calls.map((c) => sorted(c.keys))).toEqual([["t1", "t2"]]);
    expect(f.tracks.calls.map((c) => c.budget.maxBytes)).toEqual([5e9]);
  });

  it("an approval names keys, not steps: one step asking part of them later runs under it, on its own price", async () => {
    const { graph, f } = build({ metered: true });
    const cache = new MemoryCache();
    const ask = (providers: string[], approved?: Record<string, number>, over = cache) =>
      run(
        graph,
        options({
          refs: refs("artist", "a1"),
          providers,
          cache: over,
          ...(approved ? { approved } : {}),
        }),
      );
    const gated = await ask(["fast", "slow"]);
    const gate = gated.gates[0];
    if (!gate) throw new Error("expected a gate");
    // the run kept what the gate covers, for a person's time
    expect(cache.sets.filter((s) => s.key.startsWith("hopgraph:1:gate:"))).toMatchObject([
      { retention: "hour" },
    ]);

    // the same approval, another cache: the scope is lost, the part stops at a gate of its own
    f.tracks.is.price = 3e9;
    const lost = await ask(["fast"], { [gate.id]: gate.bytes }, new MemoryCache());
    expect(lost.status).toBe("gated");
    expect(lost.gates.map((g) => g.id)).not.toContain(gate.id);
    expect(f.tracks.calls).toEqual([]);

    const fast = await ask(["fast"], { [gate.id]: gate.bytes });
    expect(fast.status).toBe("complete");
    expect(f.tracks.calls.map((c) => [sorted(c.keys), c.budget.maxBytes])).toEqual([[["t1"], 3e9]]);
    expect(refsOf(providerOf(fast, "a1", "fast"))).toEqual(["t1"]);
  });

  it("a part of an approved gate priced above the approval is a gate of its own, never a load", async () => {
    const { graph, f } = build({ metered: true });
    const cache = new MemoryCache();
    const base = { refs: refs("artist", "a1"), cache };
    const gated = await run(graph, options({ ...base, providers: ["fast", "slow"] }));
    const gate = gated.gates[0];
    if (!gate) throw new Error("expected a gate");

    f.tracks.is.price = 6e9;
    const fast = await run(
      graph,
      options({ ...base, providers: ["fast"], approved: { [gate.id]: gate.bytes } }),
    );
    expect(fast.status).toBe("gated");
    expect(fast.gates).toMatchObject([{ keys: 1, bytes: 6e9 }]);
    expect(f.tracks.calls).toEqual([]);
  });
});
