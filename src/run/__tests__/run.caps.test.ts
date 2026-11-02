// Caps (run/types.ts `RunOptions.caps`, a relation's and a provider's `caps`; DESIGN.md §5.8): the
// most refs one step reads, links one ref follows, rows one ref gets. Past a cap the ref is cut,
// never absent; the refs a step reads are the first in key order, the links and rows a ref keeps
// are the first its source gave.

import { describe, expect, it } from "vitest";
import { DefinitionError } from "../../core/index.ts";
import { run } from "../index.ts";
import type { Caps } from "../types.ts";
import {
  fake,
  free,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  refsOf,
  stepsOf,
  traceOf,
} from "./support.ts";

type Artists = readonly { readonly artist: string }[];
type Streams = readonly { readonly market: string }[];

/** Tracks and their performers (t1 has three), and the streams of each artist (a1 three). */
function build(own: { links?: number; rows?: number } = {}) {
  const f = {
    performers: fake<Artists>({
      found: {
        t1: [{ artist: "a1" }, { artist: "a2" }, { artist: "a3" }],
        t2: [{ artist: "a4" }, { artist: "a5" }],
      },
    }),
    streams: fake<Streams>({
      found: {
        a1: [{ market: "a" }, { market: "b" }, { market: "c" }],
        a2: [{ market: "d" }],
        a3: [{ market: "e" }],
      },
    }),
  };
  const g = newGraph();
  const performers = g.loader({
    ...free,
    id: "performers",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.performers.load,
  });
  const streamsL = g.loader({
    ...free,
    id: "streams",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.streams.load,
  });
  const performer = g.relation("track", "artist", "performers", {
    cardinality: "N:N",
    strategies: (s) => [s(performers, { project: (_ref, v) => v.map((b) => ({ to: b.artist })) })],
    ...(own.links === undefined ? {} : { caps: { links: own.links } }),
  });
  const streams = g.provider("streams", {
    loader: streamsL,
    temporal: "historical",
    rows: "many",
    project: (v) => v.map((l) => ({ market: l.market })),
    raw: { market: m("Market") },
    ...(own.rows === undefined ? {} : { caps: { rows: own.rows } }),
  });
  return {
    graph: g.graph(
      g.route("track", streams, g.path(performer)),
      g.route("artist", streams, g.itself("artist")),
    ),
    f,
    performer,
  };
}

const capped = (cap: "refs" | "links" | "rows", limit: number) =>
  ({ kind: "capped", cap, limit }) as const;

describe("run: caps", () => {
  it("refs: a step reads the first refs in key order; the others are cut, never absent", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: refs("artist", "a3", "a9", "a1", "a2"),
        providers: ["streams"],
        caps: { refs: 2 },
      }),
    );

    expect(f.streams.loaded()).toEqual(["a1", "a2"]);
    expect(providerOf(result, "a1", "streams").outcome).toBe("found");
    for (const row of ["a3", "a9"]) {
      const p = providerOf(result, row, "streams");
      expect(p.outcome).toBe("unknown");
      expect(p.cut).toEqual([capped("refs", 2)]);
      expect(p.unknown).toEqual([]);
    }
  });

  it("refs: targets past the cap are not read, and the base row that reached them is cut", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: ["streams"], caps: { refs: 2 } }),
    );

    expect(f.streams.loaded()).toEqual(["a1", "a2"]);
    const p = providerOf(result, "t1", "streams");
    expect(p.outcome).toBe("found");
    expect(refsOf(p)).toEqual(["a1", "a2"]);
    expect(p.cut).toEqual([capped("refs", 2)]);
  });

  it("links: a ref follows its first links; the run's cap and the relation's own, the smaller", async () => {
    for (const [run_, own, kept] of [
      [{ links: 2 }, undefined, ["a1", "a2"]],
      [{ links: 2 }, 1, ["a1"]],
      [{}, 1, ["a1"]],
    ] as const) {
      const { graph, f, performer } = build({ ...(own === undefined ? {} : { links: own }) });
      const caps: Caps = run_;
      const result = await run(
        graph,
        options({ refs: refs("track", "t1", "t2"), providers: ["streams"], caps }),
      );

      const p = providerOf(result, "t1", "streams");
      expect(refsOf(p)).toEqual(kept);
      expect(p.outcome).toBe("found");
      expect(p.cut).toEqual([capped("links", kept.length)]);
      // the strategy's row step says what it found, before the cap
      expect(stepsOf(result, "t1", performer.id)).toMatchObject([{ outcome: "found", links: 3 }]);
      expect(f.streams.loaded()).not.toContain("a3");
    }
  });

  it("links: a cut ref whose kept targets have nothing is unknown, never absent", async () => {
    const { graph } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t2"), providers: ["streams"], caps: { links: 1 } }),
    );

    const p = providerOf(result, "t2", "streams");
    expect(p.outcome).toBe("unknown");
    expect(p.cut).toEqual([capped("links", 1)]);
  });

  it("rows: a ref gets its first rows, cut on the result and the row step; the smaller cap wins", async () => {
    for (const [caps, own, kept] of [
      [{ rows: 2 }, undefined, ["a", "b"]],
      [{ rows: 2 }, 1, ["a"]],
    ] as const) {
      const { graph } = build({ ...(own === undefined ? {} : { rows: own }) });
      const result = await run(
        graph,
        options({ refs: refs("artist", "a1", "a2"), providers: ["streams"], caps }),
      );

      const p = providerOf(result, "a1", "streams");
      expect(p.rows.map((r) => r.fields.market)).toEqual(kept);
      expect(p.outcome).toBe("found");
      expect(p.cut).toEqual([capped("rows", kept.length)]);
      expect(stepsOf(result, "a1", "provider:streams")).toMatchObject([
        { outcome: "found", cuts: [capped("rows", kept.length)] },
      ]);
      expect(providerOf(result, "a2", "streams").cut).toEqual([]);
    }
  });

  it("a cap that is not a whole number from 1 is refused, by the builder and by the run", async () => {
    expect(() => build({ links: 0 })).toThrow(DefinitionError);
    expect(() => build({ rows: 1.5 })).toThrow(DefinitionError);
    const { graph, f } = build();
    const error = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: ["streams"], caps: { refs: -1 } }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(DefinitionError);
    expect((error as DefinitionError).code).toBe("HG_SPEC");
    expect(f.performers.calls).toEqual([]);
  });

  it("refs: a step waiting for its inputs offers none of them ahead, so nothing past its cap is read", async () => {
    // `both` is fed a2 by a fast way and a1 by a slow one; `third` reads profiles meanwhile. With
    // no cap, a2 is offered to the job `third` starts, and read before `both` knows its refs
    const read = async (caps: Caps) => {
      const g = newGraph();
      const way = (id: string, to: string | undefined, delayMs: number) =>
        g.loader({
          ...free,
          id,
          keyedBy: "track",
          connectors: { allOf: ["db"] },
          load: fake<{ to: string }>({ found: to ? { t1: { to } } : {}, delayMs }).load,
        });
      const profiles = fake<{ name: string }>({
        found: { a1: { name: "Mira Volk" }, a2: { name: "Ode Ferris" }, a3: { name: "Kit Lune" } },
      });
      const profilesL = g.loader({
        ...free,
        id: "profiles",
        keyedBy: "artist",
        connectors: { allOf: ["db"] },
        load: profiles.load,
      });
      const to = (_ref: unknown, v: { to: string }) => [{ to: v.to }];
      const a = g.relation("track", "artist", "a", {
        cardinality: "N:1",
        strategies: (s) => [s(way("a1", "a2", 1), { project: to })],
      });
      const b = g.relation("track", "artist", "b", {
        cardinality: "N:1",
        combine: "fallback",
        strategies: (s) => [
          s(way("b1", undefined, 30), { project: to }),
          s(way("b2", "a1", 1), { project: to }),
        ],
      });
      const c = g.relation("track", "artist", "c", {
        cardinality: "N:1",
        strategies: (s) => [s(way("c1", "a3", 1), { project: to })],
      });
      const spec = {
        loader: profilesL,
        temporal: "current",
        rows: "one",
        project: (v: { name: string }) => [v],
        raw: { name: m("Name") },
      } as const;
      await run(
        g.graph(
          g.route("track", g.provider("both", spec), g.union(g.path(a), g.path(b))),
          g.route("track", g.provider("third", spec), g.path(c)),
        ),
        options({ refs: refs("track", "t1"), providers: ["both", "third"], caps }),
      );
      return profiles.calls.map((call) => [...call.keys].sort());
    };

    expect(await read({})).toEqual([["a2", "a3"], ["a1"]]);
    expect(await read({ refs: 1 })).toEqual([["a3"], ["a1"]]);
  });

  it("refs: key order is the order of key ids (a1 before a10), whatever the entity's name", async () => {
    const { graph, f } = build();
    await run(
      graph,
      options({ refs: refs("artist", "a10", "a1"), providers: ["streams"], caps: { refs: 1 } }),
    );

    expect(f.streams.loaded()).toEqual(["a1"]);
  });

  it("refs: a ref past the cap has its row step, unknown and cut, and the trace counts it", async () => {
    const { graph, performer } = build();
    const cut = [capped("refs", 1)];
    const artists = await run(
      graph,
      options({ refs: refs("artist", "a1", "a2"), providers: ["streams"], caps: { refs: 1 } }),
    );

    expect(stepsOf(artists, "a2", "provider:streams")).toEqual([
      { step: "provider:streams", loader: "streams", ref: "a2", outcome: "unknown", cuts: cut },
    ]);
    expect(traceOf(artists, "provider:streams")).toMatchObject({ keysIn: 2, found: 1, cut: 1 });

    const tracks = await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["streams"], caps: { refs: 1 } }),
    );
    expect(stepsOf(tracks, "t2", performer.id)).toEqual([
      { step: performer.id, loader: "performers", ref: "t2", outcome: "unknown", cuts: cut },
    ]);
    expect(traceOf(tracks, performer.id)).toMatchObject({ keysIn: 2, cut: 1 });
  });

  it("refs: a verification reads its first candidates' targets only; the others are cut", async () => {
    const g = newGraph();
    const f = {
      performers: fake<Artists>({
        found: { t1: ["a4", "a3", "a2", "a1"].map((artist) => ({ artist })) },
      }),
      checks: fake<{ readonly ok: boolean }>({
        found: { a1: { ok: true }, a2: { ok: true }, a3: { ok: true }, a4: { ok: true } },
      }),
      streams: fake<Streams>({ found: { a1: [{ market: "a" }] } }),
    };
    const performers = g.loader({
      ...free,
      id: "performers",
      keyedBy: "track",
      connectors: { allOf: ["db"] },
      load: f.performers.load,
    });
    const checks = g.loader({
      ...free,
      id: "checks",
      keyedBy: "artist",
      connectors: { allOf: ["db"] },
      load: f.checks.load,
    });
    const streamsL = g.loader({
      ...free,
      id: "streams",
      keyedBy: "artist",
      connectors: { allOf: ["db"] },
      load: f.streams.load,
    });
    const verified = g.relation("track", "artist", "verified", {
      cardinality: "N:N",
      strategies: (s) => [
        s(performers, { project: (_ref, v) => v.map((b) => ({ to: b.artist })) }),
      ],
      verify: (v) => v(checks, (cs) => cs.map((c) => (c.value?.ok ? "keep" : "undecided"))),
    });
    const result = await run(
      g.graph(
        g.route(
          "track",
          g.provider("streams", {
            loader: streamsL,
            temporal: "historical",
            rows: "many",
            project: (v) => v.map((l) => ({ market: l.market })),
            raw: { market: m("Market") },
          }),
          g.path(verified),
        ),
      ),
      options({ refs: refs("track", "t1"), providers: ["streams"], caps: { refs: 1 } }),
    );

    expect(f.checks.loaded()).toEqual(["a1"]);
    const p = providerOf(result, "t1", "streams");
    expect(refsOf(p)).toEqual(["a1"]);
    expect(p.cut).toEqual([capped("refs", 1)]);
    const verifySteps = stepsOf(result, "t1", `verify:${verified.id}`);
    expect([...verifySteps].sort((x, y) => (x.ref < y.ref ? -1 : 1))).toEqual(
      ["a1", "a2", "a3", "a4"].map((ref) =>
        ref === "a1"
          ? { step: `verify:${verified.id}`, loader: "checks", ref, outcome: "found" }
          : {
              step: `verify:${verified.id}`,
              loader: "checks",
              ref,
              outcome: "unknown",
              cuts: [capped("refs", 1)],
            },
      ),
    );
  });

  it("refs: a fallback past a strategy whose candidates were dropped at the cap keeps the cut, so what the next leads to is never absent", async () => {
    const g = newGraph();
    const f = {
      performers: fake<Artists>({ found: { t1: [{ artist: "a3" }, { artist: "a4" }] } }),
      backup: fake<Artists>({ found: { t1: [{ artist: "a5" }] } }),
      // a3 is refused; a4, past the cap, is never read; a5 is confirmed and has no streams
      checks: fake<{ readonly ok: boolean }>({ found: { a3: { ok: false }, a5: { ok: true } } }),
      streams: fake<Streams>({}),
    };
    const trackLoader = (id: string, load: (typeof f)["backup"]["load"]) =>
      g.loader({ ...free, id, keyedBy: "track", connectors: { allOf: ["db"] }, load });
    const performers = trackLoader("performers", f.performers.load);
    const backup = trackLoader("backup", f.backup.load);
    const checks = g.loader({
      ...free,
      id: "checks",
      keyedBy: "artist",
      connectors: { allOf: ["db"] },
      load: f.checks.load,
    });
    const streamsL = g.loader({
      ...free,
      id: "streams",
      keyedBy: "artist",
      connectors: { allOf: ["db"] },
      load: f.streams.load,
    });
    const to = (_ref: unknown, v: Artists) => v.map((b) => ({ to: b.artist }));
    const verified = g.relation("track", "artist", "verified", {
      cardinality: "N:N",
      combine: "fallback",
      strategies: (s) => [s(performers, { project: to }), s(backup, { project: to })],
      verify: (v) => v(checks, (cs) => cs.map((c) => (c.value?.ok ? "keep" : "drop"))),
    });
    const streams = g.provider("streams", {
      loader: streamsL,
      temporal: "historical",
      rows: "many",
      project: (v) => v.map((l) => ({ market: l.market })),
      raw: { market: m("Market") },
    });
    const result = await run(
      g.graph(g.route("track", streams, g.path(verified))),
      options({ refs: refs("track", "t1"), providers: ["streams"], caps: { refs: 1 } }),
    );

    expect(f.backup.loaded()).toEqual(["t1"]);
    expect(providerOf(result, "t1", "streams")).toMatchObject({
      outcome: "unknown",
      rows: [],
      cut: [capped("refs", 1)],
    });
  });
});
