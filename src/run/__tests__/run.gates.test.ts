// Gates (DESIGN.md §5.3, §5.4): a metered loader prices its missing keys before it loads; under
// `auto` it runs, up to `approve` the run stops at a gate with a stable id, above it the keys are
// unknown too heavy. An approved run is the same run again: what was read comes from the cache, the
// gated step is priced again and refused, never billed, when the price grew past the approval.

import { describe, expect, it } from "vitest";
import { CostChangedError, envelope } from "../../core/index.ts";
import { run } from "../index.ts";
import {
  fake,
  free,
  MemoryCache,
  m,
  newGraph,
  options,
  providerOf,
  recorder,
  refs,
  stepsOf,
  traceOf,
} from "./support.ts";

const METERED = { metered: { auto: 1e9, approve: 1e11 } } as const;

function build() {
  const f = {
    plays: fake<{ plays: number }>({ found: { t1: { plays: 10 }, t2: { plays: 20 } } }),
    recordings: fake<{ master: string }[]>({
      found: { t1: [{ master: "m1" }, { master: "m2" }], t2: [{ master: "m3" }] },
    }),
    scans: fake<{ events: string[] }>({
      found: { m1: { events: ["in", "out"] }, m2: { events: ["in"] }, m3: { events: ["lost"] } },
      price: 5e8,
      billedBytes: 4e8,
    }),
    guests: fake<{ artist: string }>({ found: { t1: { artist: "a1" } }, price: 5e9 }),
    profiles: fake<{ name: string }>({ found: { a1: { name: "Mira Volk" } } }),
  };
  const g = newGraph();
  const playsL = g.loader({
    ...free,
    id: "trackPlays",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.plays.load,
  });
  const recordingsL = g.loader({
    ...free,
    id: "recordings",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.recordings.load,
  });
  const scansL = g.loader({
    ...free,
    id: "scans",
    keyedBy: "master",
    connectors: { allOf: ["wh"] },
    cost: METERED,
    price: f.scans.price,
    load: f.scans.load,
  });
  const guestsL = g.loader({
    ...free,
    id: "guests",
    keyedBy: "track",
    connectors: { allOf: ["wh"] },
    cost: METERED,
    price: f.guests.price,
    load: f.guests.load,
  });
  const profilesL = g.loader({
    ...free,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.profiles.load,
  });
  const mastered = g.relation("track", "master", "mastered", {
    cardinality: "1:N",
    strategies: (s) => [s(recordingsL, { project: (_ref, v) => v.map((x) => ({ to: x.master })) })],
  });
  const featured = g.relation("track", "artist", "featured", {
    cardinality: "N:1",
    strategies: (s) => [s(guestsL, { project: (_ref, v) => [{ to: v.artist }] })],
  });
  const plays = g.provider("plays", {
    loader: playsL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ plays: v.plays }],
    raw: { plays: m("Plays") },
  });
  const scans = g.provider("scans", {
    loader: scansL,
    temporal: "historical",
    rows: "many",
    project: (v) => v.events.map((event) => ({ event })),
    raw: { event: m("Event") },
  });
  const profile = g.provider("profile", {
    loader: profilesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });
  return {
    graph: g.graph(
      g.route("track", plays, g.itself("track")),
      g.route("track", scans, g.path(mastered)),
      g.route("track", profile, g.path(featured)),
    ),
    f,
    featured,
  };
}

/** Runs once at a gate on the scans step (priced 5e9) and returns the gate and the cache. */
async function gated(b: ReturnType<typeof build>) {
  b.f.scans.is.price = 5e9;
  const cache = new MemoryCache();
  const first = await run(
    b.graph,
    options({ refs: refs("track", "t1"), providers: ["plays", "scans"], cache }),
  );
  const gate = first.gates[0];
  if (!gate) throw new Error("expected a gate");
  return { first, gate, cache };
}

describe("run: gates", () => {
  it("under auto: priced on the missing keys, then run with the priced bytes as budget; a free loader's budget is undefined", async () => {
    const { graph, f } = build();
    const result = await run(graph, options({ refs: refs("track", "t1"), providers: ["scans"] }));

    expect(result.status).toBe("complete");
    expect(result.gates).toEqual([]);
    expect(f.scans.prices.map((k) => [...k].sort())).toEqual([["m1", "m2"]]);
    expect(f.scans.calls.map((c) => c.budget.maxBytes)).toEqual([5e8]);
    expect(f.recordings.calls.map((c) => c.budget.maxBytes)).toEqual([undefined]);
    expect(providerOf(result, "t1", "scans").outcome).toBe("found");
    expect(result.billedBytes).toBe(4e8);
    expect(traceOf(result, "provider:scans").billedBytes).toBe(4e8);
  });

  it("between auto and approve: stops at a gate; the step and its dependents do not run, independent steps do", async () => {
    const { graph, f, featured } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: ["profile", "plays"] }),
    );

    expect(result.status).toBe("gated");
    expect(result.gates).toEqual([
      { id: expect.any(String), step: featured.id, loader: "guests", keys: 1, bytes: 5e9 },
    ]);
    expect(f.guests.calls).toEqual([]);
    expect(f.profiles.calls).toEqual([]);
    expect(providerOf(result, "t1", "plays").outcome).toBe("found");
    const p = providerOf(result, "t1", "profile");
    expect(p.outcome).toBe("unknown");
    expect(p.unknown).toEqual([{ reason: "awaiting_approval", bytes: 5e9 }]);
    expect(stepsOf(result, "t1", featured.id)).toMatchObject([
      { loader: "guests", ref: "t1", outcome: "unknown", reason: { reason: "awaiting_approval" } },
    ]);
    expect(result.billedBytes).toBe(0);
  });

  it("the gate id is the same for the same request, run twice", async () => {
    const a = await gated(build());
    const b = await gated(build());

    expect(a.gate.id).not.toBe("");
    expect(b.gate.id).toBe(a.gate.id);
    expect(a.gate).toEqual({
      id: a.gate.id,
      step: "provider:scans",
      loader: "scans",
      keys: 2,
      bytes: 5e9,
    });
  });

  it("above approve: unknown too heavy with the bytes, no gate, never loaded", async () => {
    const b = build();
    b.f.scans.is.price = 2e11;
    const result = await run(b.graph, options({ refs: refs("track", "t1"), providers: ["scans"] }));

    expect(result.status).toBe("complete");
    expect(result.gates).toEqual([]);
    expect(b.f.scans.calls).toEqual([]);
    const p = providerOf(result, "t1", "scans");
    expect(p.outcome).toBe("unknown");
    expect(p.unknown).toEqual([{ reason: "too_heavy", bytes: 2e11 }]);
  });

  it("resume: earlier steps come from the cache, the gated step is priced again and run with the approval as budget", async () => {
    const b = build();
    const { gate, cache } = await gated(b);
    expect(b.f.scans.calls).toEqual([]);

    const resumed = await run(
      b.graph,
      options({
        refs: refs("track", "t1"),
        providers: ["plays", "scans"],
        cache,
        approved: { [gate.id]: gate.bytes },
      }),
    );

    expect(resumed.status).toBe("complete");
    expect(resumed.gates).toEqual([]);
    expect(b.f.recordings.calls).toHaveLength(1);
    expect(b.f.plays.calls).toHaveLength(1);
    expect(b.f.scans.prices).toHaveLength(2);
    expect(b.f.scans.calls.map((c) => c.budget.maxBytes)).toEqual([5e9]);
    expect(providerOf(resumed, "t1", "scans").outcome).toBe("found");
    expect(providerOf(resumed, "t1", "scans").rows).toHaveLength(3);
    expect(resumed.billedBytes).toBe(4e8);
  });

  it("resume with the first run's prices: the gate is not priced again; each loader's job of each wave is a span", async () => {
    const b = build();
    const { first, gate, cache } = await gated(b);
    expect(first.prices.get(gate.id)).toBe(5e9);

    const { tracer, spans } = recorder();
    const resumed = await run(
      b.graph,
      options({
        refs: refs("track", "t1"),
        providers: ["plays", "scans"],
        cache,
        approved: { [gate.id]: gate.bytes },
        prices: first.prices,
        tracer,
      }),
    );

    expect(resumed.status).toBe("complete");
    expect(b.f.scans.prices).toHaveLength(1);
    expect(b.f.scans.calls.map((c) => c.budget.maxBytes)).toEqual([5e9]);
    expect(resumed.prices.get(gate.id)).toBe(5e9);
    // the tracks' reads from the cache, then the scans loaded: counts and times only
    const jobs = spans.filter((s) => s.name === "hopgraph.batch");
    const at = (key: string) => jobs.map((j) => j.attributes[key]);
    expect(
      jobs
        .map((j) => [
          j.attributes["hopgraph.wave"],
          j.attributes["hopgraph.loader"],
          j.attributes["hopgraph.keys"],
          j.attributes["hopgraph.cache.hits"],
        ])
        .sort(),
    ).toEqual([
      [1, "recordings", 1, 1],
      [1, "trackPlays", 1, 1],
      [2, "scans", 2, 0],
    ]);
    for (const key of [
      "hopgraph.waited_ms",
      "hopgraph.cache_ms",
      "hopgraph.price_ms",
      "hopgraph.load_ms",
    ])
      for (const ms of at(key)) expect(ms).toBeGreaterThanOrEqual(0);
  });

  it("resume with a price that shrank under the approval: runs, the budget is the approval", async () => {
    const b = build();
    const { gate, cache } = await gated(b);
    b.f.scans.is.price = 3e9;

    await run(
      b.graph,
      options({
        refs: refs("track", "t1"),
        providers: ["scans"],
        cache,
        approved: { [gate.id]: gate.bytes },
      }),
    );

    expect(b.f.scans.calls.map((c) => c.budget.maxBytes)).toEqual([5e9]);
  });

  it("resume with a price that grew past the approval: CostChangedError, nothing loaded or billed", async () => {
    const b = build();
    const { gate, cache } = await gated(b);
    b.f.scans.is.price = 6e9;

    const error = await run(
      b.graph,
      options({
        refs: refs("track", "t1"),
        providers: ["plays", "scans"],
        cache,
        approved: { [gate.id]: gate.bytes },
      }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(CostChangedError);
    expect(error).toMatchObject({ gate: gate.id, approved: 5e9, priced: 6e9 });
    expect(b.f.scans.calls).toEqual([]);
  });

  it("prices only the keys the cache lacks, and the gate counts those keys", async () => {
    const b = build();
    const cache = new MemoryCache();
    await run(b.graph, options({ refs: refs("track", "t1"), providers: ["scans"], cache }));
    b.f.scans.is.price = 5e9;
    const second = await run(
      b.graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["scans"], cache }),
    );

    expect(b.f.scans.prices.map((k) => [...k].sort())).toEqual([["m1", "m2"], ["m3"]]);
    expect(second.gates).toMatchObject([{ step: "provider:scans", keys: 1, bytes: 5e9 }]);
    // t1's masters were read in the first run: t1 answers, only t2 waits
    expect(providerOf(second, "t1", "scans").outcome).toBe("found");
    expect(providerOf(second, "t2", "scans").unknown).toEqual([
      { reason: "awaiting_approval", bytes: 5e9 },
    ]);
  });
});

class QuotaError extends Error {
  override name = "QuotaError";
}

/** A track's masters (a slow free read) then their scans (metered), and its featured artist
 *  (metered), whose dry run or load the test makes throw. */
function failing(is: { price?: () => number | Promise<number>; load?: () => void }) {
  const f = {
    recordings: fake<{ master: string }[]>({ found: { t1: [{ master: "m1" }] }, delayMs: 10 }),
    scans: fake<{ events: string[] }>({ found: { m1: { events: ["in"] } }, price: 5e8 }),
    guests: fake<{ artist: string }>({ found: { t1: { artist: "a1" } } }),
    profiles: fake<{ name: string }>({ found: { a1: { name: "Mira Volk" } } }),
  };
  const g = newGraph();
  const recordingsL = g.loader({
    ...free,
    id: "recordings",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.recordings.load,
  });
  const scansL = g.loader({
    ...free,
    id: "scans",
    keyedBy: "master",
    connectors: { allOf: ["wh"] },
    cost: METERED,
    price: f.scans.price,
    load: f.scans.load,
  });
  const guestsL = g.loader({
    ...free,
    id: "guests",
    keyedBy: "track",
    connectors: { allOf: ["wh"] },
    cost: METERED,
    price: async () => (await is.price?.()) ?? 5e8,
    load: async (keys, ctx, budget) => {
      is.load?.();
      return f.guests.load(keys, ctx, budget);
    },
  });
  const profilesL = g.loader({
    ...free,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.profiles.load,
  });
  const mastered = g.relation("track", "master", "mastered", {
    cardinality: "1:N",
    strategies: (s) => [s(recordingsL, { project: (_ref, v) => v.map((x) => ({ to: x.master })) })],
  });
  const featured = g.relation("track", "artist", "featured", {
    cardinality: "N:1",
    strategies: (s) => [s(guestsL, { project: (_ref, v) => [{ to: v.artist }] })],
  });
  const scans = g.provider("scans", {
    loader: scansL,
    temporal: "historical",
    rows: "many",
    project: (v) => v.events.map((event) => ({ event })),
    raw: { event: m("Event") },
  });
  const profile = g.provider("profile", {
    loader: profilesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });
  return {
    graph: g.graph(
      g.route("track", scans, g.path(mastered)),
      g.route("track", profile, g.path(featured)),
    ),
    f,
    featured,
  };
}

const settled = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e,
  );

describe("run: errors that reject the run", () => {
  it("a dry run that throws what the application calls fatal rejects the run with it; nothing starts after", async () => {
    const { graph, f } = failing({
      // once the masters' read of the same wave is running
      price: async () => {
        await new Promise((resolve) => setTimeout(resolve, 3));
        throw new QuotaError("quota spent");
      },
    });
    const error = await settled(
      run(
        graph,
        options({
          refs: refs("track", "t1"),
          providers: ["profile", "scans"],
          fatal: (e) => e instanceof QuotaError,
        }),
      ),
    );

    expect(error).toBeInstanceOf(QuotaError);
    // the masters' read was already running; the scans step it leads to never starts
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(f.recordings.calls).toHaveLength(1);
    expect(f.scans.prices).toEqual([]);
    expect(f.scans.calls).toEqual([]);
    expect(f.guests.calls).toEqual([]);
  });

  it("a load that refuses a grown cost rejects the run with its CostChangedError", async () => {
    const { graph } = failing({
      load: () => {
        throw new CostChangedError("guests:x", 5e8, 6e8);
      },
    });
    const error = await settled(
      run(graph, options({ refs: refs("track", "t1"), providers: ["profile"] })),
    );

    expect(error).toBeInstanceOf(CostChangedError);
    expect(error).toMatchObject({ approved: 5e8, priced: 6e8 });
  });

  it("without `fatal`, the same throw fails the keys it priced, by its class only; the run answers", async () => {
    const { graph, f, featured } = failing({
      price: () => {
        throw new QuotaError("quota spent for project p-123");
      },
    });
    const result = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: ["profile", "scans"] }),
    );

    expect(f.guests.calls).toEqual([]);
    expect(providerOf(result, "t1", "profile").unknown).toEqual([{ reason: "failed" }]);
    expect(traceOf(result, featured.id).errors).toEqual([{ code: "QuotaError", keys: 1 }]);
    expect(providerOf(result, "t1", "scans").outcome).toBe("found");
  });
});

/**
 * Two branches from a track: a fast relation to its master, whose scans are metered (`scans`,
 * priced 5e9, dry run `scanPriceMs` long), and a slow relation (`slow`, 60 ms) to its studio, then
 * the studio's region and the region's name. With `tracksPriced`, a provider over a second metered
 * loader (`tracks`, priced 5e9, dry run 40 ms) reads the track itself.
 */
function branches(p: { scanPriceMs?: number; tracksPriced?: boolean } = {}) {
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const slowSignals: boolean[] = [];
  const calls: string[] = [];
  const g = newGraph();
  const on = (connector: "db" | "wh") => ({ ...free, connectors: { allOf: [connector] } }) as const;
  const found =
    <V>(id: string, value: (key: string) => V, ms = 1) =>
    async (
      keys: readonly { readonly key: string }[],
      _c: unknown,
      _b: unknown,
      signal: AbortSignal,
    ) => {
      calls.push(id);
      await sleep(ms);
      if (id === "slow") slowSignals.push(signal.aborted);
      return envelope(keys.map((r) => [r.key, { kind: "found", value: value(r.key) }] as const));
    };
  const metered = (ms: number) => ({
    cost: METERED,
    price: async () => {
      await sleep(ms);
      return 5e9;
    },
  });
  const routes = g.loader({
    ...on("db"),
    id: "routes",
    keyedBy: "track",
    load: found("routes", () => ({ to: "m1" })),
  });
  const scans = g.loader({
    ...on("wh"),
    ...metered(p.scanPriceMs ?? 1),
    id: "scans",
    keyedBy: "master",
    load: found("scans", () => ({ n: 1 })),
  });
  const slow = g.loader({
    ...on("db"),
    id: "slow",
    keyedBy: "track",
    load: found("slow", () => ({ to: "s1" }), 60),
  });
  const regions = g.loader({
    ...on("db"),
    id: "regions",
    keyedBy: "studio",
    load: found("regions", () => ({ to: "r1" })),
  });
  const names = g.loader({
    ...on("db"),
    id: "names",
    keyedBy: "region",
    load: found("names", () => ({ n: 1 })),
  });
  const tracks = g.loader({
    ...on("wh"),
    ...metered(40),
    id: "tracks",
    keyedBy: "track",
    load: found("tracks", () => ({ n: 1 })),
  });
  const to = (_ref: unknown, v: { to: string }) => [{ to: v.to }];
  const routed = g.relation("track", "master", "routed", {
    cardinality: "N:1",
    strategies: (s) => [s(routes, { project: to })],
  });
  const kept = g.relation("track", "studio", "kept", {
    cardinality: "N:1",
    strategies: (s) => [s(slow, { project: to })],
  });
  const within = g.relation("studio", "region", "within", {
    cardinality: "N:1",
    strategies: (s) => [s(regions, { project: to })],
  });
  const one = {
    temporal: "current",
    rows: "one",
    project: (v: { n: number }) => [{ n: v.n }],
    raw: { n: m("N") },
  } as const;
  const providers = ["scans", "region", ...(p.tracksPriced ? ["tracks"] : [])];
  const graph = g.graph(
    g.route("track", g.provider("scans", { ...one, loader: scans }), g.path(routed)),
    g.route("track", g.provider("region", { ...one, loader: names }), g.path(kept, within)),
    g.route("track", g.provider("tracks", { ...one, loader: tracks }), g.itself("track")),
  );
  const ask = (approved?: Record<string, number>, cache = new MemoryCache()) =>
    run(
      graph,
      options({ refs: refs("track", "t1"), providers, cache, ...(approved ? { approved } : {}) }),
    );
  return { ask, slowSignals, calls };
}

describe("run: refused approvals", () => {
  it("a refusal stops the loads of its wave and after it; the reads before it finish and are kept", async () => {
    const b = branches();
    const first = await b.ask();
    const gate = first.gates.find((x) => x.loader === "scans");
    if (!gate) throw new Error("expected a gate on scans");
    b.calls.length = 0;
    b.slowSignals.length = 0;

    const cache = new MemoryCache();
    const error = await b.ask({ [gate.id]: gate.bytes - 1 }, cache).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CostChangedError);
    expect((error as CostChangedError).gates).toEqual([
      { gate: gate.id, approved: gate.bytes - 1, priced: gate.bytes },
    ]);
    // the slow read of wave 1 was running when wave 2 refused: it finished, and was kept
    expect(b.slowSignals).toEqual([false]);
    expect(cache.sets.some((s) => s.key.includes(":slow:"))).toBe(true);
    // nothing of wave 2 or after was loaded: not the scans, not the studio's region, not its name
    expect(b.calls.filter((c) => c !== "routes")).toEqual(["slow"]);
  });

  it("the run fails naming the earliest wave's refusals, even when a later wave refused first", async () => {
    const b = branches({ tracksPriced: true });
    const first = await b.ask();
    const approved = Object.fromEntries(first.gates.map((x) => [x.id, x.bytes - 1]));
    const tracks = first.gates.find((x) => x.loader === "tracks");
    if (!tracks) throw new Error("expected a gate on tracks");

    // the scans (wave 2) are priced in 1 ms, the tracks (wave 1) in 40: the scans refuse first
    const error = await b.ask(approved).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CostChangedError);
    expect((error as CostChangedError).gates).toEqual([
      { gate: tracks.id, approved: tracks.bytes - 1, priced: tracks.bytes },
    ]);
    expect((error as CostChangedError).gate).toBe(tracks.id);
  });
});
