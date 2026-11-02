// Readable connectors (run/types.ts `readable`, DESIGN.md §3.4 `unread`): a loader whose connectors
// are not readable (`allOf`: every one; `oneOf`: at least one) is not run, its keys are unknown
// `unread` with why and which connectors, and the branches that do not depend on it still answer.

import { describe, expect, it } from "vitest";
import type { Connectors, Unread } from "../../core/index.ts";
import { run } from "../index.ts";
import {
  type Conn,
  fake,
  free,
  MemoryCache,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  refsOf,
  stepsOf,
  traceOf,
} from "./support.ts";

type Item = { readonly n: number };

function build() {
  const f = {
    wh: fake<Item>({ found: { t1: { n: 1 } } }),
    mixed: fake<Item>({ found: { t1: { n: 2 } } }),
    either: fake<Item>({ found: { t1: { n: 3 } } }),
    db: fake<Item>({ found: { t1: { n: 4 } } }),
    viaWh: fake<{ artist: string }>({ found: { t1: { artist: "a1" } } }),
    viaDb: fake<{ artist: string }>({ found: { t1: { artist: "a2" } } }),
    profiles: fake<{ name: string }>({
      found: { a1: { name: "Mira Volk" }, a2: { name: "Ode Ferris" } },
    }),
  };
  const g = newGraph();
  const itemsOn = (id: string, connectors: Connectors<Conn>, load: (typeof f)["wh"]["load"]) => {
    const loader = g.loader({ ...free, id, keyedBy: "track", connectors, load });
    const p = g.provider(id, {
      loader,
      temporal: "historical",
      rows: "one",
      project: (v) => [{ n: v.n }],
      raw: { n: m("N") },
    });
    return g.route("track", p, g.itself("track"));
  };
  const items = [
    itemsOn("whItems", { allOf: ["wh"] }, f.wh.load),
    itemsOn("mixedItems", { allOf: ["db", "wh"] }, f.mixed.load),
    itemsOn("anyItems", { oneOf: ["db", "wh"] }, f.either.load),
    itemsOn("dbItems", { allOf: ["db"] }, f.db.load),
  ];

  const viaWhL = g.loader({
    ...free,
    id: "viaWh",
    keyedBy: "track",
    connectors: { allOf: ["wh"] },
    load: f.viaWh.load,
  });
  const viaDbL = g.loader({
    ...free,
    id: "viaDb",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.viaDb.load,
  });
  const profilesL = g.loader({
    ...free,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.profiles.load,
  });
  const fromWh = g.relation("track", "artist", "fromWh", {
    cardinality: "N:1",
    strategies: (s) => [s(viaWhL, { project: (_ref, v) => [{ to: v.artist }] })],
  });
  const fromDb = g.relation("track", "artist", "fromDb", {
    cardinality: "N:1",
    strategies: (s) => [s(viaDbL, { project: (_ref, v) => [{ to: v.artist }] })],
  });
  const profile = g.provider("profile", {
    loader: profilesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });
  const graph = g.graph(
    ...items,
    g.route("track", profile, g.union(g.path(fromWh), g.path(fromDb))),
  );
  return { graph, f };
}

const only =
  (why: Unread, ...blocked: string[]) =>
  (c: string): true | Unread =>
    blocked.includes(c) ? why : true;

describe("run: readable connectors", () => {
  it("a loader whose connector is not readable is not run: unknown unread with why and the connector, never kept", async () => {
    const { graph, f } = build();
    const cache = new MemoryCache();
    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["whItems"],
        readable: only("forbidden", "wh"),
        cache,
      }),
    );

    const unread = { reason: "unread", why: "forbidden", connectors: ["wh"] };
    expect(f.wh.calls).toEqual([]);
    const p = providerOf(result, "t1", "whItems");
    expect(p.outcome).toBe("unknown");
    expect(p.rows).toEqual([]);
    expect(p.unknown).toEqual([unread]);
    expect(stepsOf(result, "t1", "provider:whItems")).toMatchObject([
      { loader: "whItems", ref: "t1", outcome: "unknown", reason: unread },
    ]);
    expect(traceOf(result, "provider:whItems")).toMatchObject({
      keysIn: 1,
      unknown: { unread: 1 },
    });
    expect(cache.sets).toEqual([]);

    await run(graph, options({ refs: refs("track", "t1"), providers: ["whItems"], cache }));
    expect(f.wh.loaded()).toEqual(["t1"]);
  });

  it("allOf: one unreadable connector stops the loader, and the reason names the unreadable one only", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["mixedItems"],
        readable: only("forbidden", "wh"),
      }),
    );

    expect(f.mixed.calls).toEqual([]);
    expect(providerOf(result, "t1", "mixedItems").unknown).toEqual([
      { reason: "unread", why: "forbidden", connectors: ["wh"] },
    ]);
  });

  it("oneOf: one readable connector is enough to run", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["anyItems"],
        readable: only("forbidden", "wh"),
      }),
    );

    expect(f.either.loaded()).toEqual(["t1"]);
    expect(providerOf(result, "t1", "anyItems").outcome).toBe("found");
  });

  it("oneOf: none readable is unread, naming every connector", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["anyItems"],
        readable: only("disabled", "db", "wh"),
      }),
    );

    expect(f.either.calls).toEqual([]);
    const p = providerOf(result, "t1", "anyItems");
    expect(p.unknown).toHaveLength(1);
    const reason = p.unknown[0];
    expect(reason).toMatchObject({ reason: "unread", why: "disabled" });
    expect(reason?.reason === "unread" ? [...reason.connectors].sort() : []).toEqual(["db", "wh"]);
  });

  it("independent branches still answer: the other path and the other provider are read", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["profile", "dbItems"],
        readable: only("not_configured", "wh"),
      }),
    );

    expect(f.viaWh.calls).toEqual([]);
    const p = providerOf(result, "t1", "profile");
    expect(p.outcome).toBe("found");
    expect(refsOf(p)).toEqual(["a2"]);
    expect(p.unknown).toEqual([{ reason: "unread", why: "not_configured", connectors: ["wh"] }]);
    expect(providerOf(result, "t1", "dbItems").outcome).toBe("found");
  });
});
