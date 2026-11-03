// The builder's refusals and checkGraph's findings that graph.test.ts does not reach: what a
// plain-JavaScript caller or a hand-built graph can still get wrong.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { checkGraph, type Envelope, entity, hopgraph } from "../index.ts";

type Ctx = { today: string };
type Meta = { label: string };
const m = (label: string): { meta: Meta } => ({ meta: { label } });

function found<K, V>(pairs: ReadonlyArray<readonly [K, V]>): Envelope<K, V> {
  return { values: pairs, absent: [], unknown: [], cut: [], billedBytes: 0, errors: [] };
}

const artist = entity({ key: z.string(), carries: { country: z.string() } });
const track = entity({ key: z.string() });
const venue = entity({ key: z.string() });

function build() {
  const g = hopgraph<Meta, "db", Ctx>().entities({ artist, track, venue });
  const loaderOf = <K extends "artist" | "track" | "venue">(id: string, keyedBy: K) =>
    g.loader({
      id,
      version: 1,
      keyedBy,
      connectors: { allOf: ["db"] },
      batch: { by: "keys", max: 10 },
      keep: () => "none",
      partial: "keep",
      load: async () => found<never, { id: string }>([]),
    });
  return { g, artistLoader: loaderOf("artistLoader", "artist"), loaderOf };
}

const refusal = (code: string) => expect.objectContaining({ code });

describe("builder refusals", () => {
  it("refuses a loader that merges refs and declares hints", () => {
    const { g } = build();
    expect(() =>
      g.loader({
        id: "merging",
        version: 1,
        keyedBy: "artist",
        hints: ["h"],
        connectors: { allOf: ["db"] },
        batch: { by: "keys", max: 1 },
        keep: () => "none",
        partial: "keep",
        load: async () => found<string, { id: string }>([]),
        merge: { needs: () => undefined, narrow: () => undefined, empty: { id: "" } },
      } as never),
    ).toThrow(refusal("HG_SPEC"));
  });

  it("refuses a hydrator whose loader is keyed by another entity, and a second hydrator", () => {
    const { g, artistLoader, loaderOf } = build();
    const trackLoader = loaderOf("trackLoader", "track");
    expect(() => g.hydrator("artist", trackLoader as never, () => ({}) as never)).toThrow(
      refusal("HG_KEYED_BY"),
    );
    g.hydrator("artist", artistLoader, () => ({ country: "IT" }) as never);
    expect(() => g.hydrator("artist", artistLoader, () => ({}) as never)).toThrow(
      refusal("HG_DUPLICATE"),
    );
  });

  it("refuses a relation strategy whose loader is keyed by another entity than the relation's from", () => {
    const { g, loaderOf } = build();
    const trackLoader = loaderOf("trackLoader", "track");
    expect(() =>
      g.relation("artist", "track", "mine", {
        cardinality: "1:N",
        strategies: (s) => [s(trackLoader as never, { project: () => [] } as never)],
      }),
    ).toThrow(refusal("HG_KEYED_BY"));
  });

  it("refuses a relation with no strategy, and one with several and no combine", () => {
    const { g, artistLoader } = build();
    expect(() =>
      g.relation("artist", "track", "none", { cardinality: "1:N", strategies: () => [] as never }),
    ).toThrow(refusal("HG_SPEC"));
    expect(() =>
      g.relation("artist", "track", "two", {
        cardinality: "1:N",
        strategies: (s) => [
          s(artistLoader, { project: () => [] } as never),
          s(artistLoader, { project: () => [] } as never),
        ],
      }),
    ).toThrow(/say combine/);
  });

  it("refuses a verification whose loader is keyed by another entity than the relation's to", () => {
    const { g, artistLoader } = build();
    expect(() =>
      g.relation("artist", "track", "checked", {
        cardinality: "1:N",
        strategies: (s: (l: unknown, x: unknown) => unknown) => [
          s(artistLoader, { project: () => [] }),
        ],
        verify: (v: never) => (v as (l: unknown, d: unknown) => unknown)(artistLoader, () => []),
      } as never),
    ).toThrow(refusal("HG_KEYED_BY"));
  });

  it("refuses a provider declared twice", () => {
    const { g, artistLoader } = build();
    const spec = {
      loader: artistLoader,
      temporal: "historical",
      rows: "one",
      project: () => ({ a: 1 }),
      raw: { a: m("A") },
    } as never;
    g.provider("p", spec);
    expect(() => g.provider("p", spec)).toThrow(refusal("HG_DUPLICATE"));
  });

  it("refuses a derived field that reads a name that is not a raw field, or is named as one", () => {
    const { g, artistLoader } = build();
    const base = {
      loader: artistLoader,
      temporal: "historical",
      rows: "one",
      project: () => ({ a: 1 }),
      raw: { a: m("A") },
    };
    expect(() =>
      g.provider("reads", {
        ...base,
        derived: (d: (i: string[], c: () => number, s: unknown) => unknown) => ({
          x: d(["ghost"], () => 1, m("X")),
        }),
      } as never),
    ).toThrow(/reads "ghost", not a raw field/);
    expect(() =>
      g.provider("named", {
        ...base,
        derived: (d: (i: string[], c: () => number, s: unknown) => unknown) => ({
          a: d(["a"], () => 1, m("A")),
        }),
      } as never),
    ).toThrow(/has the name of a raw field/);
  });

  it("refuses a path of no relation, and a union of paths that do not share ends", () => {
    const { g, artistLoader, loaderOf } = build();
    const to = g.relation("artist", "track", "to", {
      cardinality: "1:N",
      strategies: (s) => [s(artistLoader, { project: () => [] } as never)],
    });
    const back = g.relation("track", "artist", "back", {
      cardinality: "N:1",
      strategies: (s) => [s(loaderOf("trackLoader", "track"), { project: () => [] } as never)],
    });
    // @ts-expect-error a path takes one relation at least
    expect(() => g.path()).toThrow(/at least one relation/);
    expect(() => g.union(g.path(to), g.path(back))).toThrow(
      /mixes artist › track with track › artist/,
    );
    // @ts-expect-error a union takes one path at least
    expect(() => g.union()).toThrow(/at least one path/);
  });

  it("refuses a loader batch whose max, or connectors, are not what the shapes allow", () => {
    const { g } = build();
    const spec = (batch: unknown) =>
      ({
        id: `b${JSON.stringify(batch)}`,
        version: 1,
        keyedBy: "artist",
        connectors: { allOf: ["db"] },
        batch,
        keep: () => "none",
        partial: "keep",
        load: async () => found<string, number>([]),
      }) as never;
    for (const batch of [undefined, { by: "keys" }, { by: "keys", max: 0 }, { by: "one" }])
      expect(() => g.loader(spec(batch)), JSON.stringify(batch)).toThrow(refusal("HG_SPEC"));
  });
});

describe("checkGraph on a graph the builder would not make", () => {
  function routed() {
    const { g, artistLoader, loaderOf } = build();
    const to = g.relation("artist", "track", "to", {
      cardinality: "1:N",
      strategies: (s) => [s(artistLoader, { project: () => [] } as never)],
    });
    const trackLoader = loaderOf("trackLoader", "track");
    const p = g.provider("tracks", {
      loader: trackLoader,
      temporal: "historical",
      rows: "one",
      project: () => ({ a: 1 }),
      raw: { a: m("A") },
    } as never);
    const route = g.route("artist", p as never, g.path(to) as never);
    return { g, to, route, graph: g.graph(route), trackLoader };
  }

  it("reports a base that is not an entity, a route from a non-base, and a route to no provider", () => {
    const { graph, route } = routed();
    const hand = {
      ...graph,
      routes: [route, { ...route, provider: "ghost" }, { ...route, base: "track" }],
    };
    const codes = checkGraph(hand, { bases: ["artist", "nowhere"] }).problems.map((p) => p.code);
    expect(codes).toContain("HG_UNKNOWN_ENTITY");
    expect(codes).toContain("HG_NOT_A_BASE");
    expect(codes).toContain("HG_UNKNOWN_PROVIDER");
  });

  it("lists the paths of a union route as used, so only the others are alternatives", () => {
    const { g, to, graph } = routed();
    const union = g.union(g.path(to), g.path(to));
    const route = { ...graph.routes[0]!, how: union };
    const result = checkGraph({ ...graph, routes: [route] }, { bases: ["artist"] });
    expect(result.problems).toEqual([]);
    expect(result.alternatives).toEqual({});
  });

  it("stops looking for alternatives past maxDepth", () => {
    const { g, artistLoader, loaderOf } = build();
    const direct = g.relation("artist", "track", "direct", {
      cardinality: "1:N",
      strategies: (s) => [s(artistLoader, { project: () => [] } as never)],
    });
    g.relation("artist", "venue", "plays", {
      cardinality: "1:N",
      strategies: (s) => [s(artistLoader, { project: () => [] } as never)],
    });
    g.relation("venue", "track", "hosts", {
      cardinality: "1:N",
      strategies: (s) => [s(loaderOf("venueLoader", "venue"), { project: () => [] } as never)],
    });
    const p = g.provider("tracks", {
      loader: loaderOf("trackLoader", "track"),
      temporal: "historical",
      rows: "one",
      project: () => ({ a: 1 }),
      raw: { a: m("A") },
    } as never);
    const graph = g.graph(g.route("artist", p as never, g.path(direct) as never));
    const alternatives = (maxDepth: number) =>
      checkGraph(graph, { bases: ["artist"], maxDepth }).alternatives;
    expect(alternatives(1)).toEqual({});
    expect(alternatives(2)).toEqual({
      "artist › tracks": ["artist › venue:plays · venue › track:hosts"],
    });
  });

  it("does not ask a hydrator of an entity the graph does not have", () => {
    const { graph, trackLoader } = routed();
    const ghost = {
      ...graph.loaders.get(trackLoader.id)!,
      id: "ghostLoader",
      keyedBy: "ghost",
      needs: ["x"],
    };
    const hand = { ...graph, loaders: new Map([...graph.loaders, [ghost.id, ghost]]) };
    const codes = checkGraph(hand, { bases: ["artist"] }).problems.map((p) => p.code);
    expect(codes).toContain("HG_NO_HYDRATOR");
  });
});
