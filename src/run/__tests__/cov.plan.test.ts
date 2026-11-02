// Edges of the evaluators of relations and providers reached from outside: a verification whose
// targets cannot be read or whose rule answers short, a found value with no candidate to verify,
// a relation waiting on its inputs under a refs cap or with a fallback, a projected row missing a
// raw field. The refs store's two defaults are tested directly.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { entity, hopgraph } from "../../core/index.ts";
import { run } from "../index.ts";
import { RefStore } from "../refs.ts";
import { fake, free, m, newGraph, options, providerOf, refs, refsOf, stepsOf } from "./support.ts";

type Tracks = readonly { readonly track: string; readonly releasedAt?: string }[];

/** artist › track found by `recent`, verified by a loader keyed by track that needs releasedAt. */
function verified(decide: ((n: number) => ("keep" | "drop" | "undecided")[]) | "states") {
  const f = {
    recent: fake<Tracks>({
      found: {
        a1: [{ track: "t1", releasedAt: "2026-09-01" }, { track: "t2" }],
        a2: [],
      },
    }),
    check: fake<{ ok: boolean }>({ found: { t1: { ok: true }, t2: { ok: true } } }),
    info: fake<{ title: string }>({ found: { t1: { title: "One" }, t2: { title: "Two" } } }),
  };
  const seen: { to: string; state: string }[][] = [];
  const g = newGraph();
  const recentL = g.loader({
    ...free,
    id: "recent",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.recent.load,
  });
  const checkL = g.loader({
    ...free,
    id: "check",
    keyedBy: "track",
    needs: ["releasedAt"],
    connectors: { allOf: ["db"] },
    load: f.check.load,
  });
  const infoL = g.loader({
    ...free,
    id: "info",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.info.load,
  });
  const recent = g.relation("artist", "track", "recent", {
    cardinality: "1:N",
    strategies: (s) => [
      s(recentL, {
        project: (_ref, v) =>
          v.map((x) => ({
            to: x.track,
            ...(x.releasedAt === undefined ? {} : { carries: { releasedAt: x.releasedAt } }),
          })),
      }),
    ],
    verify: (v) =>
      v(checkL, (candidates) => {
        seen.push(candidates.map((c) => ({ to: c.link.to, state: c.state })));
        const out = typeof decide === "function" ? decide(candidates.length) : decide;
        return out === "states"
          ? candidates.map((c) => (c.state === "found" ? "keep" : "drop"))
          : out;
      }),
  });
  const info = g.provider("info", {
    loader: infoL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ title: v.title }],
    raw: { title: m("Title") },
  });
  return { f, seen, graph: g.graph(g.route("artist", info, g.path(recent))) };
}

describe("run: a verification at its edges", () => {
  it("a target whose needs cannot be met is not read: the rule sees it unknown, and drops it", async () => {
    const { f, seen, graph } = verified("states");
    const result = await run(graph, options({ refs: refs("artist", "a1"), providers: ["info"] }));

    expect(f.check.loaded()).toEqual(["t1"]);
    expect(seen).toEqual([
      [
        { to: "t1", state: "found" },
        { to: "t2", state: "unknown" },
      ],
    ]);
    expect(refsOf(providerOf(result, "a1", "info"))).toEqual(["t1"]);
    expect(
      stepsOf(result, "a1", "verify:artist › track:recent").map((s) => [s.ref, s.outcome]),
    ).toEqual([
      ["t1", "found"],
      ["t2", "absent"],
    ]);
  });

  it("a rule that answers fewer verdicts than candidates leaves the rest undecided, marked ambiguous", async () => {
    const { graph } = verified(() => []);
    const result = await run(graph, options({ refs: refs("artist", "a1"), providers: ["info"] }));

    const p = providerOf(result, "a1", "info");
    expect(refsOf(p)).toEqual(["t1", "t2"]);
    expect(p.unknown).toEqual([{ reason: "ambiguous" }]);
  });

  it("a found value that projects to no link has nothing to verify: absent, and no verify read", async () => {
    const { f, graph } = verified("states");
    const result = await run(graph, options({ refs: refs("artist", "a2"), providers: ["info"] }));

    expect(providerOf(result, "a2", "info").outcome).toBe("absent");
    expect(f.check.calls).toHaveLength(0);
  });
});

/** Two ways to an artist, then a relation to a region fed by both, then a provider on regions. */
function waiting(combine: "union" | "fallback", caps: { refs?: number }) {
  const regions = fake<{ to: string }>({ found: { a1: { to: "r1" }, a2: { to: "r2" } } });
  const info = fake<{ name: string }>({ found: { r1: { name: "North" }, r2: { name: "South" } } });
  const g = newGraph();
  const way = (id: string, to: string, delayMs: number) =>
    g.loader({
      ...free,
      id,
      keyedBy: "track",
      connectors: { allOf: ["db"] },
      load: fake<{ to: string }>({ found: { t1: { to } }, delayMs }).load,
    });
  const to = (_ref: unknown, v: { to: string }) => [{ to: v.to }];
  const fast = g.relation("track", "artist", "fast", {
    cardinality: "N:1",
    strategies: (s) => [s(way("fastWay", "a1", 1), { project: to })],
  });
  const slow = g.relation("track", "artist", "slow", {
    cardinality: "N:1",
    strategies: (s) => [s(way("slowWay", "a2", 30), { project: to })],
  });
  const regionsL = g.loader({
    ...free,
    id: "regions",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: regions.load,
  });
  const regionsL2 = g.loader({
    ...free,
    id: "regions2",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: fake<{ to: string }>({ found: {} }).load,
  });
  const home = g.relation("artist", "region", "home", {
    cardinality: "N:1",
    combine,
    strategies: (s) => [s(regionsL, { project: to }), s(regionsL2, { project: to })],
  });
  const infoL = g.loader({
    ...free,
    id: "regionInfo",
    keyedBy: "region",
    connectors: { allOf: ["db"] },
    load: info.load,
  });
  const regionInfo = g.provider("regionInfo", {
    loader: infoL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });
  return {
    regions,
    graph: g.graph(g.route("track", regionInfo, g.union(g.path(fast, home), g.path(slow, home)))),
    run: () =>
      run(graph(), options({ refs: refs("track", "t1"), providers: ["regionInfo"], caps })),
  };
  function graph() {
    return g.graph(g.route("track", regionInfo, g.union(g.path(fast, home), g.path(slow, home))));
  }
}

describe("run: a relation waiting for its inputs", () => {
  it.each(["union", "fallback"] as const)(
    "a %s relation fed by a fast and a slow way answers both artists, offered ahead without a cap",
    async (combine) => {
      const w = waiting(combine, {});
      const result = await w.run();

      expect(refsOf(providerOf(result, "t1", "regionInfo"))).toEqual(["r1", "r2"]);
      expect(w.regions.loaded()).toEqual(["a1", "a2"]);
    },
  );

  it("under a refs cap it offers nothing ahead and still answers both artists", async () => {
    const w = waiting("union", { refs: 5 });
    const result = await w.run();

    expect(refsOf(providerOf(result, "t1", "regionInfo"))).toEqual(["r1", "r2"]);
    expect(w.regions.loaded()).toEqual(["a1", "a2"]);
  });
});

describe("run: a projected row missing a raw field", () => {
  it("the field is absent from the row's fields, not undefined", async () => {
    const f = fake<{ market: string; note?: string }>({ found: { a1: { market: "it" } } });
    const g = newGraph();
    const streamsL = g.loader({
      ...free,
      id: "streams",
      keyedBy: "artist",
      connectors: { allOf: ["db"] },
      load: f.load,
    });
    const streams = g.provider("streams", {
      loader: streamsL,
      temporal: "current",
      rows: "one",
      project: (v) => [v],
      raw: { market: m("Market"), note: m("Note") },
    });
    const result = await run(
      g.graph(g.route("artist", streams, g.itself("artist"))),
      options({ refs: refs("artist", "a1"), providers: ["streams"] }),
    );

    const rows = providerOf(result, "a1", "streams").rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.fields).toEqual({ market: "it" });
    expect(Object.hasOwn(rows[0]?.fields ?? {}, "note")).toBe(false);
  });
});

describe("RefStore defaults", () => {
  const entities = hopgraph<object, unknown>()
    .entities({ track: entity({ key: z.string(), carries: { releasedAt: z.string() } }) })
    .graph().entities;

  it("learning from a hydrator that said nothing keeps nothing", () => {
    const store = new RefStore(entities);
    const ref = store.intern("track", "t1");
    store.learn(ref, undefined);
    expect(store.missing(ref, ["releasedAt"])).toEqual(["releasedAt"]);
  });

  it("an entity with no context attributes lacks every need its given values do not hold", () => {
    const store = new RefStore(entities);
    expect(store.lacks(store.intern("track", "t1"), ["releasedAt"])).toBe(true);
    expect(
      store.lacks(store.intern("track", "t1", { releasedAt: "2026-09-01" }), ["releasedAt"]),
    ).toBe(false);
  });
});
