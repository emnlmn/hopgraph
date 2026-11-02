// Needs and hydration (DESIGN.md §3.1, §3.2): a carried need comes from the base row, then from the
// link that reached the ref, then from the entity's hydrator; the hydrator runs once per key and
// only for the refs that lack a need; one key reached with different need values is two loader
// keys, never two refs of one key in a call, each answered and attributed along its own links; a
// need left missing by an unknown hydration makes the step unknown (`unmet`) for that ref, never
// absent; one missing because the hydration found the entity absent makes it absent, within the
// hydration's coverage. A hint (core `hints`) is read when the base row or the link brought it:
// never hydrated, never a reason to be unknown, and part of the cache key like a need.

import { describe, expect, it } from "vitest";
import { run } from "../index.ts";
import type { BaseRef } from "../types.ts";
import {
  type Behaviour,
  fake,
  free,
  link,
  MemoryCache,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  refsOf,
  rowsOf,
  stepsOf,
} from "./support.ts";

type Header = { readonly releasedAt: string; readonly catalog: string };
type Recent = { readonly track: string; readonly releasedAt?: string }[];

function build(
  b: {
    header?: Behaviour<Header>;
    archive?: Behaviour<{ masters: string[] }>;
    windowed?: Behaviour<{ masters: string[] }>;
  } = {},
) {
  const f = {
    header: fake<Header>(
      b.header ?? {
        found: {
          t1: { releasedAt: "2026-10-15", catalog: "it" },
          t2: { releasedAt: "2026-07-01", catalog: "fr" },
          t3: { releasedAt: "2026-05-05", catalog: "it" },
          t4: { releasedAt: "2026-04-04", catalog: "it" },
        },
      },
    ),
    windowed: fake<{ masters: string[] }>(
      b.windowed ?? {
        found: { t1: { masters: ["m1"] }, t2: { masters: ["m2"] }, t3: { masters: ["m3"] } },
      },
    ),
    windowedCatalog: fake<{ n: number }>({ found: { t1: { n: 1 } } }),
    typedWin: fake<{ n: number }>({ found: { t1: { n: 1 }, t2: { n: 2 } } }),
    archive: fake<{ masters: string[] }>(b.archive ?? {}),
    catalogArtists: fake<{ artist: string; catalog: string }[]>({
      found: {
        t1: [
          { artist: "a1", catalog: "it" },
          { artist: "a2", catalog: "fr" },
        ],
        t3: [
          { artist: "a1", catalog: "it" },
          { artist: "a2", catalog: "fr" },
        ],
      },
    }),
    recent: fake<Recent>({
      found: {
        a1: [
          { track: "t1", releasedAt: "2026-09-01" },
          { track: "t2", releasedAt: "2026-08-01" },
        ],
        a2: [{ track: "t3" }, { track: "t4", releasedAt: "2026-04-04" }],
        a3: [{ track: "t1", releasedAt: "2026-03-03" }],
      },
    }),
    masterInfo: fake<{ minutes: number }>({
      found: { m1: { minutes: 1 }, m2: { minutes: 2 }, m3: { minutes: 3 }, m9: { minutes: 9 } },
    }),
    profiles: fake<{ name: string }>({
      found: { a1: { name: "Mira Volk" }, a2: { name: "Ode Ferris" } },
    }),
    typed: fake<{ n: number }>({ found: { t1: { n: 1 }, t2: { n: 2 } } }),
  };

  const g = newGraph();
  const headerL = g.loader({
    ...free,
    id: "trackHeader",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.header.load,
  });
  g.hydrator("track", headerL, (v) => ({ releasedAt: v.releasedAt, catalog: v.catalog }));
  const windowedL = g.loader({
    ...free,
    id: "windowed",
    keyedBy: "track",
    needs: ["releasedAt"],
    connectors: { allOf: ["wh"] },
    load: f.windowed.load,
  });
  const archiveL = g.loader({
    ...free,
    id: "archive",
    keyedBy: "track",
    connectors: { allOf: ["wh"] },
    load: f.archive.load,
  });
  const catalogArtistsL = g.loader({
    ...free,
    id: "catalogArtists",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.catalogArtists.load,
  });
  const recentL = g.loader({
    ...free,
    id: "recentTracks",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.recent.load,
  });
  const masterInfoL = g.loader({
    ...free,
    id: "masterInfo",
    keyedBy: "master",
    connectors: { allOf: ["db"] },
    load: f.masterInfo.load,
  });
  const typedL = g.loader({
    ...free,
    id: "typed",
    keyedBy: "track",
    hints: ["catalog"],
    connectors: { allOf: ["db"] },
    load: f.typed.load,
  });
  const typed = g.provider("typed", {
    loader: typedL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ n: v.n }],
    raw: { n: m("N") },
  });
  const typedWinL = g.loader({
    ...free,
    id: "typedWin",
    keyedBy: "track",
    needs: ["releasedAt"],
    hints: ["catalog"],
    connectors: { allOf: ["db"] },
    load: f.typedWin.load,
  });
  const windowedCatalogL = g.loader({
    ...free,
    id: "windowedCatalog",
    keyedBy: "track",
    needs: ["releasedAt", "catalog"],
    connectors: { allOf: ["wh"] },
    load: f.windowedCatalog.load,
  });
  const trackWindow = g.provider("trackWindow", {
    loader: windowedCatalogL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ n: v.n }],
    raw: { n: m("N") },
  });
  const profilesL = g.loader({
    ...free,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.profiles.load,
  });

  const toMasters = (_ref: unknown, v: { masters: string[] }) => v.masters.map((p) => ({ to: p }));
  const near = g.relation("track", "master", "near", {
    cardinality: "1:N",
    strategies: (s) => [s(windowedL, { project: toMasters })],
  });
  const nearOrArchive = g.relation("track", "master", "nearOrArchive", {
    cardinality: "1:N",
    combine: "fallback",
    strategies: (s) => [s(windowedL, { project: toMasters }), s(archiveL, { project: toMasters })],
  });
  const inCatalog = g.relation("track", "artist", "inCatalog", {
    cardinality: "N:N",
    strategies: (s) => [
      s(catalogArtistsL, {
        needs: ["catalog"],
        project: (ref, v) =>
          v.filter((c) => c.catalog === ref.catalog).map((c) => ({ to: c.artist })),
      }),
    ],
  });
  const maybeCatalog = g.relation("track", "artist", "maybeCatalog", {
    cardinality: "N:N",
    strategies: (s) => [
      s(catalogArtistsL, {
        hints: ["catalog"],
        project: (ref, v) =>
          v
            .filter((c) => ref.catalog === undefined || c.catalog === ref.catalog)
            .map((c) => ({ to: c.artist })),
      }),
    ],
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
  });

  const masterSpec = {
    loader: masterInfoL,
    temporal: "historical",
    rows: "one",
    project: (v: { minutes: number }) => [{ minutes: v.minutes }],
    raw: { minutes: m("Minutes") },
  } as const;
  const masterInfo = g.provider("masterInfo", masterSpec);
  const masterInfoFb = g.provider("masterInfoFb", masterSpec);
  const profile = g.provider("profile", {
    loader: profilesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });
  const profileHint = g.provider("profileHint", {
    loader: profilesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });

  return {
    graph: g.graph(
      g.route("track", typed, g.itself("track")),
      g.route(
        "track",
        g.provider("typedWin", {
          loader: typedWinL,
          temporal: "historical",
          rows: "one",
          project: (v) => [{ n: v.n }],
          raw: { n: m("N") },
        }),
        g.itself("track"),
      ),
      g.route("track", trackWindow, g.itself("track")),
      g.route("track", masterInfo, g.path(near)),
      g.route("artist", masterInfo, g.path(recent, near)),
      g.route("track", masterInfoFb, g.path(nearOrArchive)),
      g.route("track", profile, g.path(inCatalog)),
      g.route("artist", trackWindow, g.path(recent)),
      g.route("track", profileHint, g.path(maybeCatalog)),
    ),
    f,
    near,
    nearOrArchive,
    recent,
  };
}

const row = (row: string, key: string, carries?: BaseRef["carries"]): BaseRef => ({
  row,
  entity: "track",
  key,
  ...(carries ? { carries } : {}),
});

describe("run: needs and hydration", () => {
  it("a need the base row carries is handed to the load as it is, with no hydration", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({ refs: [row("t1", "t1", { releasedAt: "2026-10-01" })], providers: ["masterInfo"] }),
    );

    expect(f.header.calls).toEqual([]);
    expect(f.windowed.calls).toHaveLength(1);
    expect(f.windowed.calls[0]?.refs).toMatchObject([{ key: "t1", releasedAt: "2026-10-01" }]);
    expect(refsOf(providerOf(result, "t1", "masterInfo"))).toEqual(["m1"]);
  });

  it("a need the reaching link carries is used, with no hydration", async () => {
    const { graph, f } = build();
    await run(graph, options({ refs: refs("artist", "a1"), providers: ["masterInfo"] }));

    expect(f.header.calls).toEqual([]);
    const handed = f.windowed.calls.flatMap((c) => c.refs);
    expect(handed).toHaveLength(2);
    expect(handed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "t1", releasedAt: "2026-09-01" }),
        expect.objectContaining({ key: "t2", releasedAt: "2026-08-01" }),
      ]),
    );
  });

  it("missing needs are hydrated once per key, only for the refs that lack them", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: [row("a", "t1"), row("b", "t1"), row("c", "t2", { releasedAt: "2026-06-30" })],
        providers: ["masterInfo"],
      }),
    );

    expect(f.header.loaded()).toEqual(["t1"]);
    const handed = f.windowed.calls.flatMap((c) => c.refs);
    expect(handed).toHaveLength(2);
    expect(handed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "t1", releasedAt: "2026-10-15" }),
        expect.objectContaining({ key: "t2", releasedAt: "2026-06-30" }),
      ]),
    );
    expect(stepsOf(result, "a", "hydrate:track")).toMatchObject([
      { loader: "trackHeader", ref: "t1", outcome: "found" },
    ]);
    expect(refsOf(providerOf(result, "b", "masterInfo"))).toEqual(["m1"]);
  });

  it("a ref reached by a link that does not carry the need is hydrated; one that does is not", async () => {
    const { graph, f } = build();
    await run(graph, options({ refs: refs("artist", "a2"), providers: ["masterInfo"] }));

    expect(f.header.loaded()).toEqual(["t3"]);
  });

  it("one hydration serves a loader's need and a strategy's need on the same entity", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({ refs: [row("t1", "t1")], providers: ["masterInfo", "profile"] }),
    );

    expect(f.header.loaded()).toEqual(["t1"]);
    // the strategy's projection sees the hydrated catalog: only the artist in that catalog links
    expect(refsOf(providerOf(result, "t1", "profile"))).toEqual(["a1"]);
    expect(refsOf(providerOf(result, "t1", "masterInfo"))).toEqual(["m1"]);
  });

  it("hydration unknown: the dependent step is unknown unmet for that ref, never absent, and its load never sees it", async () => {
    const { graph, f, near } = build({
      header: {
        found: { t1: { releasedAt: "2026-10-15", catalog: "it" } },
        unknown: { t5: { reason: "failed" } },
      },
    });
    const result = await run(
      graph,
      options({ refs: [row("t1", "t1"), row("t5", "t5")], providers: ["masterInfo"] }),
    );

    expect(f.windowed.loaded()).toEqual(["t1"]);
    expect(stepsOf(result, "t5", "hydrate:track")).toMatchObject([
      { loader: "trackHeader", ref: "t5", outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(stepsOf(result, "t5", near.id)).toMatchObject([
      { ref: "t5", outcome: "unknown", reason: { reason: "unmet", needs: ["releasedAt"] } },
    ]);
    const p = providerOf(result, "t5", "masterInfo");
    expect(p.outcome).toBe("unknown");
    expect(p.rows).toEqual([]);
    expect(p.unknown).toEqual([{ reason: "unmet", needs: ["releasedAt"] }]);
    expect(providerOf(result, "t1", "masterInfo").outcome).toBe("found");
  });

  it("hydration absent: the dependent step is absent with the hydration's coverage, never unknown, and its load never sees it", async () => {
    const TRACKS = { label: "tracks, any age" };
    const { graph, f, near } = build({
      header: {
        found: { t1: { releasedAt: "2026-10-15", catalog: "it" } },
        coverage: { t6: TRACKS },
      },
    });
    const result = await run(
      graph,
      options({ refs: [row("t1", "t1"), row("t6", "t6")], providers: ["masterInfo"] }),
    );

    expect(f.windowed.loaded()).toEqual(["t1"]);
    expect(stepsOf(result, "t6", "hydrate:track")).toMatchObject([
      { loader: "trackHeader", ref: "t6", outcome: "absent", coverage: TRACKS },
    ]);
    expect(stepsOf(result, "t6", near.id)).toMatchObject([
      { ref: "t6", outcome: "absent", coverage: TRACKS },
    ]);
    expect(providerOf(result, "t6", "masterInfo")).toEqual({
      rows: [],
      outcome: "absent",
      unknown: [],
      cut: [],
      coverage: [TRACKS],
    });
    expect(providerOf(result, "t1", "masterInfo").outcome).toBe("found");
  });

  it("fallback past an unmet strategy: the next one runs, and finding nothing there leaves the ref unknown", async () => {
    const { graph, f } = build({ header: { unknown: { t5: { reason: "failed" } } }, archive: {} });
    const result = await run(
      graph,
      options({ refs: [row("t5", "t5")], providers: ["masterInfoFb"] }),
    );

    expect(f.windowed.calls).toEqual([]);
    expect(f.archive.loaded()).toEqual(["t5"]);
    const p = providerOf(result, "t5", "masterInfoFb");
    expect(p.outcome).toBe("unknown");
    expect(p.unknown).toContainEqual({ reason: "unmet", needs: ["releasedAt"] });
  });
});

describe("run: need precedence and need values", () => {
  it("precedence: a need the base row carries beats the hydrator, which still gives the need it lacks", async () => {
    const { graph, f } = build();
    await run(
      graph,
      options({
        refs: [row("t1", "t1", { releasedAt: "2026-10-01" })],
        providers: ["trackWindow"],
      }),
    );

    expect(f.header.loaded()).toEqual(["t1"]);
    expect(f.windowedCatalog.calls.flatMap((c) => c.refs)).toEqual([
      expect.objectContaining({ key: "t1", releasedAt: "2026-10-01", catalog: "it" }),
    ]);
  });

  it("precedence: a need the reaching link carries beats the hydrator, which still gives the need it lacks", async () => {
    const { graph, f } = build();
    await run(graph, options({ refs: refs("artist", "a3"), providers: ["trackWindow"] }));

    expect(f.header.loaded()).toEqual(["t1"]);
    expect(f.windowedCatalog.calls.flatMap((c) => c.refs)).toEqual([
      expect.objectContaining({ key: "t1", releasedAt: "2026-03-03", catalog: "it" }),
    ]);
  });

  it("one key reached with two need values: two loader keys in separate calls, each answered and attributed along its own links", async () => {
    const { graph, f, near, recent } = build({
      windowed: {
        lookup: (r) => `${r.key}@${String(r.releasedAt)}`,
        found: {
          "t1@2026-09-01": { masters: ["m1"] },
          "t1@2026-03-03": { masters: ["m9"] },
          "t2@2026-08-01": { masters: ["m2"] },
        },
      },
    });
    const result = await run(
      graph,
      options({ refs: refs("artist", "a1", "a3"), providers: ["masterInfo"] }),
    );

    for (const c of f.windowed.calls) expect(new Set(c.keys).size).toBe(c.keys.length);
    expect(f.windowed.calls.filter((c) => c.keys.includes("t1"))).toHaveLength(2);
    expect(
      f.windowed.calls
        .flatMap((c) => c.refs)
        .filter((r) => r.key === "t1")
        .map((r) => r.releasedAt)
        .sort(),
    ).toEqual(["2026-03-03", "2026-09-01"]);
    expect(f.header.calls).toEqual([]);

    expect(refsOf(providerOf(result, "a1", "masterInfo"))).toEqual(["m1", "m2"]);
    expect(rowsOf(providerOf(result, "a3", "masterInfo"))).toEqual([
      {
        ref: "m9",
        index: 0,
        fields: { minutes: 9 },
        lineage: [
          [link(recent.id, "recentTracks", "a3", "t1"), link(near.id, "windowed", "t1", "m9")],
        ],
      },
    ]);
  });
});

describe("run: hints", () => {
  it("a hint is handed when the base row brings it and left out when not: never hydrated, never unknown", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: [row("t1", "t1", { catalog: "it" }), row("t2", "t2")],
        providers: ["typed"],
      }),
    );

    expect(f.header.calls).toEqual([]);
    const handed = f.typed.calls.flatMap((c) => c.refs);
    expect(handed.find((r) => r.key === "t1")).toMatchObject({ key: "t1", catalog: "it" });
    expect(handed.find((r) => r.key === "t2")?.catalog).toBeUndefined();
    expect(providerOf(result, "t1", "typed").outcome).toBe("found");
    expect(providerOf(result, "t2", "typed").outcome).toBe("found");
  });

  it("a hint's value is part of the cache key: another value, or none, reads again; the same value does not", async () => {
    const { graph, f } = build();
    const cache = new MemoryCache();
    const once = (carries?: BaseRef["carries"]) =>
      run(graph, options({ refs: [row("t1", "t1", carries)], providers: ["typed"], cache }));
    await once({ catalog: "it" });
    await once({ catalog: "fr" });
    await once();
    await once({ catalog: "it" });

    expect(f.typed.calls).toHaveLength(3);
  });

  it("a hint is passed when the ref was hydrated for a need anyway, and absent when it was not", async () => {
    const { graph, f } = build();
    await run(
      graph,
      options({
        refs: [row("t1", "t1"), row("t2", "t2", { releasedAt: "2026-06-30" })],
        providers: ["typedWin"],
      }),
    );

    expect(f.header.loaded()).toEqual(["t1"]);
    const handed = f.typedWin.calls.flatMap((c) => c.refs);
    expect(handed.find((r) => r.key === "t1")).toMatchObject({
      releasedAt: "2026-10-15",
      catalog: "it",
    });
    expect(handed.find((r) => r.key === "t2")).toMatchObject({ releasedAt: "2026-06-30" });
    expect(handed.find((r) => r.key === "t2")?.catalog).toBeUndefined();
  });

  it("a strategy's hint reaches its projection when present; without it the projection runs anyway", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: [row("t1", "t1", { catalog: "fr" }), row("t3", "t3")],
        providers: ["profileHint"],
      }),
    );

    expect(f.header.calls).toEqual([]);
    expect(refsOf(providerOf(result, "t1", "profileHint"))).toEqual(["a2"]);
    expect(refsOf(providerOf(result, "t3", "profileHint"))).toEqual(["a1", "a2"]);
  });
});
