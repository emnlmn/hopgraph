// Routes (DESIGN.md §4, §5.1, §7): itself, paths of two and three relations, a union of paths,
// shared prefixes read once, a step shared by several bases read once (one step per relation per
// run, on the union of the refs that reach it), independent branches in parallel, and a cycle in
// the order of the relations the requested routes use refused. The graph's type carries its routes:
// a provider asked for rows of an entity it has no route from does not compile when the rows'
// entities are literals, and the run refuses it all the same.

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import type { AnyRoute, GraphDef, Provider, Route } from "../../core/index.ts";
import { createRunner, type RoutedProviders, run } from "../index.ts";
import {
  type Behaviour,
  CTX,
  chains,
  fake,
  free,
  Inflight,
  link,
  MemoryCache,
  type Meta,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  refsOf,
  rowsOf,
  sorted,
  stepsOf,
} from "./support.ts";

type Recording = { readonly master: string }[];
type ToStudio = { readonly studio: string };

function build(b: { recordings?: Behaviour<Recording>; archive?: Behaviour<ToStudio> } = {}) {
  const tracker = new Inflight();
  const f = {
    plays: fake<{ plays: number }>({
      found: { t1: { plays: 10 }, t2: { plays: 20 } },
      delayMs: 20,
      trackers: [tracker],
    }),
    recordings: fake<Recording>({
      found: {
        t1: [{ master: "m1" }, { master: "m2" }],
        t2: [{ master: "m3" }],
        t3: [{ master: "m4" }],
      },
      delayMs: 20,
      trackers: [tracker],
      ...b.recordings,
    }),
    mastering: fake<ToStudio>({
      found: { m1: { studio: "s1" }, m2: { studio: "s1" }, m3: { studio: "s2" } },
    }),
    archive: fake<ToStudio>({
      found: { m1: { studio: "s1" }, m3: { studio: "s3" }, m4: { studio: "s4" } },
      ...b.archive,
    }),
    studioRegion: fake<{ region: string }>({
      found: { s1: { region: "north" }, s2: { region: "south" } },
    }),
    masterInfo: fake<{ minutes: number }>({
      found: { m1: { minutes: 1 }, m2: { minutes: 2 }, m3: { minutes: 3 }, m9: { minutes: 9 } },
    }),
    studioInfo: fake<{ name: string }>({
      found: {
        s1: { name: "Harbor" },
        s2: { name: "Foundry" },
        s3: { name: "Kiln" },
        s4: { name: "Lantern" },
      },
    }),
    regionInfo: fake<{ name: string }>({
      found: { north: { name: "North" }, south: { name: "South" } },
    }),
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
  const masteringL = g.loader({
    ...free,
    id: "mastering",
    keyedBy: "master",
    connectors: { allOf: ["wh"] },
    load: f.mastering.load,
  });
  const archiveL = g.loader({
    ...free,
    id: "archive",
    keyedBy: "master",
    connectors: { allOf: ["api"] },
    load: f.archive.load,
  });
  const studioRegionL = g.loader({
    ...free,
    id: "studioRegion",
    keyedBy: "studio",
    connectors: { allOf: ["db"] },
    load: f.studioRegion.load,
  });
  const masterInfoL = g.loader({
    ...free,
    id: "masterInfo",
    keyedBy: "master",
    connectors: { allOf: ["db"] },
    load: f.masterInfo.load,
  });
  const studioInfoL = g.loader({
    ...free,
    id: "studioInfo",
    keyedBy: "studio",
    connectors: { allOf: ["wh"] },
    load: f.studioInfo.load,
  });
  const regionInfoL = g.loader({
    ...free,
    id: "regionInfo",
    keyedBy: "region",
    connectors: { allOf: ["api"] },
    load: f.regionInfo.load,
  });

  const mastered = g.relation("track", "master", "mastered", {
    cardinality: "1:N",
    link: z.object({ rank: z.number() }),
    strategies: (s) => [
      s(recordingsL, {
        project: (_ref, v) => v.map((x, rank) => ({ to: x.master, attrs: { rank } })),
      }),
    ],
  });
  const masteredAt = g.relation("master", "studio", "masteredAt", {
    cardinality: "N:1",
    strategies: (s) => [s(masteringL, { project: (_ref, v) => [{ to: v.studio }] })],
  });
  const archivedAt = g.relation("master", "studio", "archivedAt", {
    cardinality: "N:1",
    strategies: (s) => [s(archiveL, { project: (_ref, v) => [{ to: v.studio }] })],
  });
  const inRegion = g.relation("studio", "region", "in", {
    cardinality: "N:1",
    strategies: (s) => [s(studioRegionL, { project: (_ref, v) => [{ to: v.region }] })],
  });

  const plays = g.provider("plays", {
    loader: playsL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ plays: v.plays }],
    raw: { plays: m("Plays") },
  });
  const masterInfo = g.provider("masterInfo", {
    loader: masterInfoL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ minutes: v.minutes }],
    raw: { minutes: m("Minutes") },
  });
  const studioSpec = {
    loader: studioInfoL,
    temporal: "current",
    rows: "one",
    project: (v: { name: string }) => [{ name: v.name }],
    raw: { name: m("Studio") },
  } as const;
  const studioInfo = g.provider("studioInfo", studioSpec);
  const studioAny = g.provider("studioAny", studioSpec);
  const regionInfo = g.provider("regionInfo", {
    loader: regionInfoL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Region") },
  });

  return {
    g,
    plays,
    graph: g.graph(
      g.route("track", plays, g.itself("track")),
      g.route("track", masterInfo, g.path(mastered)),
      g.route("master", masterInfo, g.itself("master")),
      g.route("track", studioInfo, g.path(mastered, masteredAt)),
      g.route("master", studioInfo, g.path(masteredAt)),
      g.route(
        "track",
        studioAny,
        g.union(g.path(mastered, masteredAt), g.path(mastered, archivedAt)),
      ),
      g.route("track", regionInfo, g.path(mastered, masteredAt, inRegion)),
    ),
    f,
    tracker,
    mastered,
    masteredAt,
    archivedAt,
    inRegion,
  };
}

describe("run: routes", () => {
  it("itself: reads the base keys once and gives each base row its rows, lineage one empty chain", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["plays"] }),
    );

    expect(result.status).toBe("complete");
    expect(result.gates).toEqual([]);
    expect(f.plays.calls).toHaveLength(1);
    expect(f.plays.loaded()).toEqual(["t1", "t2"]);
    const t1 = providerOf(result, "t1", "plays");
    expect(t1.outcome).toBe("found");
    expect(rowsOf(t1)).toEqual([{ ref: "t1", index: 0, fields: { plays: 10 }, lineage: [[]] }]);
    expect(t1.unknown).toEqual([]);
    expect(t1.cut).toEqual([]);
    expect(t1.coverage).toEqual([]);
    expect(rowsOf(providerOf(result, "t2", "plays"))).toEqual([
      { ref: "t2", index: 0, fields: { plays: 20 }, lineage: [[]] },
    ]);
  });

  it("a path of two relations: one job per step, a studio reached through two masters read once and given both chains", async () => {
    const { graph, f, mastered, masteredAt } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["studioInfo"] }),
    );

    expect(f.recordings.calls.map((c) => sorted(c.keys))).toEqual([["t1", "t2"]]);
    expect(f.mastering.calls.map((c) => sorted(c.keys))).toEqual([["m1", "m2", "m3"]]);
    expect(f.studioInfo.calls.map((c) => sorted(c.keys))).toEqual([["s1", "s2"]]);
    expect(stepsOf(result, "t1", mastered.id)).toMatchObject([
      { loader: "recordings", ref: "t1", outcome: "found", links: 2 },
    ]);

    const t1 = providerOf(result, "t1", "studioInfo");
    expect(t1.outcome).toBe("found");
    expect(rowsOf(t1)).toEqual([
      {
        ref: "s1",
        index: 0,
        fields: { name: "Harbor" },
        lineage: chains(
          [
            link(mastered.id, "recordings", "t1", "m1", { rank: 0 }),
            link(masteredAt.id, "mastering", "m1", "s1"),
          ],
          [
            link(mastered.id, "recordings", "t1", "m2", { rank: 1 }),
            link(masteredAt.id, "mastering", "m2", "s1"),
          ],
        ),
      },
    ]);
    expect(rowsOf(providerOf(result, "t2", "studioInfo"))).toEqual([
      {
        ref: "s2",
        index: 0,
        fields: { name: "Foundry" },
        lineage: [
          [
            link(mastered.id, "recordings", "t2", "m3", { rank: 0 }),
            link(masteredAt.id, "mastering", "m3", "s2"),
          ],
        ],
      },
    ]);
  });

  it("a path of three relations keeps the whole chain, a link without attributes carrying attrs {}", async () => {
    const { graph, mastered, masteredAt, inRegion } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t2"), providers: ["regionInfo"] }),
    );

    expect(rowsOf(providerOf(result, "t2", "regionInfo"))).toEqual([
      {
        ref: "south",
        index: 0,
        fields: { name: "South" },
        lineage: [
          [
            link(mastered.id, "recordings", "t2", "m3", { rank: 0 }),
            link(masteredAt.id, "mastering", "m3", "s2"),
            link(inRegion.id, "studioRegion", "s2", "south"),
          ],
        ],
      },
    ]);
  });

  it("union of paths: both run on every base row, the shared prefix is read once, a key both reach is read once with every chain", async () => {
    const { graph, f, mastered, masteredAt, archivedAt } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["studioAny"] }),
    );

    expect(f.recordings.loaded()).toEqual(["t1", "t2"]);
    expect(f.mastering.loaded()).toEqual(["m1", "m2", "m3"]);
    expect(f.archive.loaded()).toEqual(["m1", "m2", "m3"]);
    expect(f.studioInfo.loaded()).toEqual(["s1", "s2", "s3"]);

    const t1 = providerOf(result, "t1", "studioAny");
    expect(t1.outcome).toBe("found");
    expect(refsOf(t1)).toEqual(["s1"]);
    const s1 = rowsOf(t1)[0];
    expect(s1?.lineage).toHaveLength(3);
    expect(s1?.lineage).toEqual(
      expect.arrayContaining([
        [
          link(mastered.id, "recordings", "t1", "m1", { rank: 0 }),
          link(masteredAt.id, "mastering", "m1", "s1"),
        ],
        [
          link(mastered.id, "recordings", "t1", "m2", { rank: 1 }),
          link(masteredAt.id, "mastering", "m2", "s1"),
        ],
        [
          link(mastered.id, "recordings", "t1", "m1", { rank: 0 }),
          link(archivedAt.id, "archive", "m1", "s1"),
        ],
      ]),
    );
    expect(refsOf(providerOf(result, "t2", "studioAny"))).toEqual(["s2", "s3"]);
  });

  it("a relation that starts the routes of several requested providers is read once", async () => {
    const { graph, f } = build();
    await run(
      graph,
      options({
        refs: refs("track", "t1", "t2"),
        providers: ["masterInfo", "studioInfo", "regionInfo"],
      }),
    );

    expect(f.recordings.calls.map((c) => sorted(c.keys))).toEqual([["t1", "t2"]]);
    expect(f.mastering.calls.map((c) => sorted(c.keys))).toEqual([["m1", "m2", "m3"]]);
    expect(f.masterInfo.loaded()).toEqual(["m1", "m2", "m3"]);
  });

  it("base rows of two entities in one run: the provider step their routes share is one job", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: [...refs("track", "t2"), { row: "m9", entity: "master", key: "m9" }],
        providers: ["masterInfo"],
      }),
    );

    expect(f.masterInfo.calls.map((c) => sorted(c.keys))).toEqual([["m3", "m9"]]);
    expect(rowsOf(providerOf(result, "m9", "masterInfo"))).toEqual([
      { ref: "m9", index: 0, fields: { minutes: 9 }, lineage: [[]] },
    ]);
    expect(refsOf(providerOf(result, "t2", "masterInfo"))).toEqual(["m3"]);
  });

  it("base rows of two entities whose routes share a relation at different depths: one call for that step", async () => {
    const { graph, f, masteredAt } = build();
    const result = await run(
      graph,
      options({
        refs: [...refs("track", "t2"), { row: "m1", entity: "master", key: "m1" }],
        providers: ["studioInfo"],
      }),
    );

    // masteredAt is the second step of the track's route and the first of the master's
    expect(f.mastering.calls.map((c) => sorted(c.keys))).toEqual([["m1", "m3"]]);
    expect(f.studioInfo.calls.map((c) => sorted(c.keys))).toEqual([["s1", "s2"]]);
    expect(rowsOf(providerOf(result, "m1", "studioInfo"))).toEqual([
      {
        ref: "s1",
        index: 0,
        fields: { name: "Harbor" },
        lineage: [[link(masteredAt.id, "mastering", "m1", "s1")]],
      },
    ]);
    expect(refsOf(providerOf(result, "t2", "studioInfo"))).toEqual(["s2"]);
  });

  it("two base rows sharing a key: the key is read once and both rows get the answer", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: [
          { row: "a", entity: "track", key: "t2" },
          { row: "b", entity: "track", key: "t2" },
        ],
        providers: ["masterInfo"],
      }),
    );

    expect(f.recordings.loaded()).toEqual(["t2"]);
    expect(f.masterInfo.loaded()).toEqual(["m3"]);
    expect(refsOf(providerOf(result, "a", "masterInfo"))).toEqual(["m3"]);
    expect(refsOf(providerOf(result, "b", "masterInfo"))).toEqual(["m3"]);
  });

  it("independent branches run in parallel", async () => {
    const { graph, tracker } = build();
    await run(graph, options({ refs: refs("track", "t1"), providers: ["plays", "masterInfo"] }));

    expect(tracker.max).toBe(2);
  });
});

/** Two routes that use the same two relations in opposite orders: track › artist › track, and
 *  artist › track › artist. With one step per relation per run, each waits for the other. */
function cyclic() {
  const there = fake<{ artist: string }>({ found: { t1: { artist: "a1" } } });
  const back = fake<{ track: string }>({ found: { a1: { track: "t1" } } });
  const g = newGraph();
  const thereL = g.loader({
    ...free,
    id: "performerOf",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: there.load,
  });
  const backL = g.loader({
    ...free,
    id: "lastTrackOf",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: back.load,
  });
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    strategies: (s) => [s(thereL, { project: (_ref, v) => [{ to: v.artist }] })],
  });
  const last = g.relation("artist", "track", "last", {
    cardinality: "1:1",
    strategies: (s) => [s(backL, { project: (_ref, v) => [{ to: v.track }] })],
  });
  const trackEcho = g.provider("trackEcho", {
    loader: thereL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ artist: v.artist }],
    raw: { artist: m("Artist") },
  });
  const artistEcho = g.provider("artistEcho", {
    loader: backL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ track: v.track }],
    raw: { track: m("Track") },
  });
  // every base needs a route to every requested provider: these two are not the cycle
  return {
    graph: g.graph(
      g.route("track", trackEcho, g.path(performer, last)),
      g.route("artist", artistEcho, g.path(last, performer)),
      g.route("track", artistEcho, g.path(performer)),
      g.route("artist", trackEcho, g.path(last)),
    ),
    there,
    back,
  };
}

describe("run: step order", () => {
  it("a cycle in the order of the relations the requested routes use throws, naming a cycle, before reading anything", async () => {
    const { graph, there, back } = cyclic();

    await expect(
      run(
        graph,
        options({
          refs: [...refs("track", "t1"), ...refs("artist", "a1")],
          providers: ["trackEcho", "artistEcho"],
        }),
      ),
    ).rejects.toThrow(/cycle/i);
    expect(there.calls).toEqual([]);
    expect(back.calls).toEqual([]);
  });

  it("the same routes asked one at a time have no cycle and answer", async () => {
    const { graph } = cyclic();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: ["trackEcho"] }),
    );

    expect(refsOf(providerOf(result, "t1", "trackEcho"))).toEqual(["t1"]);
  });
});

describe("run: routes the compiler knows", () => {
  /** What every call here shares, its rows and providers left to each. */
  const shared = () => options({ refs: [], providers: [] });
  const noRoute = (error: unknown) => (error as { code?: string }).code;

  it("rows of an entity the provider has no route from: the call does not compile, and the run refuses it", async () => {
    const { graph, plays } = build();
    const master = [{ row: "m1", entity: "master", key: "m1" }] as const;
    const refused = [
      // @ts-expect-error: provider "plays" has no route from "master"
      run(graph, { ...shared(), refs: master, providers: ["plays"] }),
      // @ts-expect-error: as declared too
      run(graph, { ...shared(), refs: master, providers: [plays] }),
    ];
    for (const error of await Promise.all(refused.map((r) => r.catch((e: unknown) => e))))
      expect(noRoute(error)).toBe("HG_NO_ROUTE");
    const read = await run(graph, { ...shared(), refs: master, providers: ["masterInfo"] });
    expect(read.status).toBe("complete");
  });

  it("rows of several entities: a provider needs a route from each", async () => {
    const { graph } = build();
    const both = [
      { row: "t1", entity: "track", key: "t1" },
      { row: "m1", entity: "master", key: "m1" },
    ] as const;
    const read = await run(graph, { ...shared(), refs: both, providers: ["studioInfo"] });
    expect(read.status).toBe("complete");
    // @ts-expect-error: provider "regionInfo" has no route from "master"
    const refused = run(graph, { ...shared(), refs: both, providers: ["regionInfo"] });
    expect(noRoute(await refused.catch((e: unknown) => e))).toBe("HG_NO_ROUTE");
  });

  it("rows built at run time by g.ref keep their entity, and their providers are checked", async () => {
    const { g, graph } = build();
    const ids: string[] = ["m1", "m2"];
    const masters = ids.map((id) => g.ref("master", id));
    const read = await run(graph, { ...shared(), refs: masters, providers: ["masterInfo"] });
    expect([...read.rows.keys()]).toEqual(["m1", "m2"]);

    // @ts-expect-error: provider "plays" has no route from "master"
    const refused = run(graph, { ...shared(), refs: masters, providers: ["plays"] });
    expect(noRoute(await refused.catch((e: unknown) => e))).toBe("HG_NO_ROUTE");
    const both = [...masters, g.ref("track", "t1")];
    // @ts-expect-error: from each entity of the rows: "plays" has none from "master"
    const mixed = run(graph, { ...shared(), refs: both, providers: ["plays"] });
    expect(noRoute(await mixed.catch((e: unknown) => e))).toBe("HG_NO_ROUTE");
    const viaRunner = createRunner(graph, { cache: new MemoryCache() }).run({
      refs: masters,
      // @ts-expect-error: through a runner too
      providers: ["plays"],
      ctx: CTX,
    });
    expect(noRoute(await viaRunner.catch((e: unknown) => e))).toBe("HG_NO_ROUTE");
  });

  it("rows whose entities are not literals, or a graph typed without its routes: the run is the check", async () => {
    const { graph } = build();
    // `refs` builds rows of `string` entities: only a provider no route reaches is refused
    const wide = await run(graph, {
      ...shared(),
      refs: refs("master", "m1"),
      providers: ["plays"],
    })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(noRoute(wide)).toBe("HG_NO_ROUTE");
    // a graph with its types forgotten: no route is known, so none is refused
    const loose: GraphDef<Meta> = graph;
    const master = [{ row: "m1", entity: "master", key: "m1" }] as const;
    const untyped = await run(loose, { ...shared(), refs: master, providers: ["plays"] })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(noRoute(untyped)).toBe("HG_NO_ROUTE");
  });

  it("a runner of some routes is not one of more", () => {
    const { g, graph, plays } = build();
    const full = createRunner(graph);
    const fewer = createRunner(g.graph(g.route("track", plays, g.itself("track"))));
    // @ts-expect-error: it would let a read ask what its graph has no route for
    const _wider: typeof full = fewer;
    expectTypeOf(full).toEqualTypeOf<typeof full>();
  });

  it("says which provider has no route, and from which entity", () => {
    type Credits = Provider<
      "credits",
      "track",
      { readonly role: string },
      Record<never, never>,
      Meta
    >;
    type Routes = Route<"track", Credits>;
    expectTypeOf<RoutedProviders<readonly [Credits], Routes, "artist">>().toEqualTypeOf<
      readonly ['provider "credits" has no route from "artist"']
    >();
    // an id meets its message as a property: a string and a string message would meet as never
    expectTypeOf<RoutedProviders<readonly ["credits"], Routes, "artist">>().toEqualTypeOf<
      readonly [{ readonly 'provider "credits" has no route from "artist"': true }]
    >();
    expectTypeOf<RoutedProviders<readonly ["credits"], Routes, "track" | "artist">>().toEqualTypeOf<
      readonly [{ readonly 'provider "credits" has no route from "artist"': true }]
    >();
    // rows of entities not known: only a provider no route reaches at all
    expectTypeOf<RoutedProviders<readonly ["credits", "notes"], Routes, string>>().toEqualTypeOf<
      readonly ["credits", { readonly 'provider "notes" has no route': true }]
    >();
    // an id not known, or routes not known, ask nothing
    expectTypeOf<RoutedProviders<readonly string[], Routes, "artist">>().toEqualTypeOf<
      readonly string[]
    >();
    expectTypeOf<RoutedProviders<readonly [Credits], AnyRoute, "artist">>().toEqualTypeOf<
      readonly [Credits]
    >();
  });
});

describe("run: a graph built without the builder", () => {
  /** The built graph with its studioInfo route from track replaced by one through `relations`. */
  async function refusal(relations: readonly string[]) {
    const { graph, f } = build();
    const def: GraphDef<Meta> = {
      ...graph,
      routes: graph.routes.map((r) =>
        r.base === "track" && r.provider === "studioInfo"
          ? { ...r, how: { kind: "path", from: "track", to: "studio", relations } }
          : r,
      ),
    };
    const error = await run(
      def,
      options({ refs: refs("track", "t1"), providers: ["studioInfo"] }),
    ).catch((e: unknown) => e);
    const reads = Object.values(f).flatMap((x) => x.calls);
    return { code: (error as { code?: string }).code, reads };
  }

  it("a route through a relation that is not declared is refused before reading anything", async () => {
    expect(await refusal(["track › master:mastered", "track › master:nowhere"])).toEqual({
      code: "HG_UNKNOWN_RELATION",
      reads: [],
    });
  });

  it("a route whose relations do not chain is refused before reading anything", async () => {
    expect(await refusal(["master › studio:masteredAt"])).toEqual({ code: "HG_PATH", reads: [] });
  });

  it("a route that ends short of the provider's entity is refused before reading anything", async () => {
    expect(await refusal(["track › master:mastered"])).toEqual({ code: "HG_PATH", reads: [] });
  });

  it("a step whose loader the graph does not hold is refused before reading anything", async () => {
    const { graph, f } = build();
    const loaders = new Map(graph.loaders);
    loaders.delete("studioInfo");
    const error = await run(
      { ...graph, loaders },
      options({ refs: refs("track", "t1"), providers: ["studioInfo"] }),
    ).catch((e: unknown) => e);

    expect(error).toMatchObject({ code: "HG_FOREIGN" });
    expect(Object.values(f).flatMap((x) => x.calls)).toEqual([]);
  });
});
