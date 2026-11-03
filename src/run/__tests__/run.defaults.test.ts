// What a run and a loader do with what they leave out (README, "Running"; DESIGN.md §5.2): a
// loader without `keep` keeps a whole found answer for a day and an absent or cut one briefly;
// without `partial`, a failed statement fails only the keys it reports; without `version`, it is
// version 1. A run without `restriction` reads as one with `""`; without `digest`, a personal key
// shows as the SHA-256 of its entity and key id, never as itself; without `readable`, every
// connector is readable; without `cache`, nothing is kept; without `limits`, nothing is bounded;
// and without `ctx` when the graph's `Ctx` admits `undefined`, which is the only time the types
// let it out.

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { type Batch, type Entities, entity, type Graph, hopgraph } from "../../core/index.ts";
import { run } from "../executor.ts";
import { keyDigest } from "../ids.ts";
import type { RunOptions } from "../types.ts";
import {
  CTX,
  type Ctx,
  dump,
  fake,
  MemoryCache,
  type Meta,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  stepsOf,
} from "./support.ts";

/** One provider over artists, from a loader on `db` that declares neither `keep` nor
 *  `partial`, nor a version unless `over` gives one; `over` may replace its batch (ten keys per
 *  call). */
function build(
  is: Parameters<typeof fake<{ readonly name: string }>>[0],
  over: { readonly version?: number; readonly batch?: Batch } = {},
) {
  const g = newGraph();
  const f = fake<{ readonly name: string }>(is);
  const loader = g.loader({
    id: "names",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    batch: { by: "keys", max: 10 },
    load: f.load,
    ...over,
  });
  return {
    graph: g.graph(
      g.route(
        "artist",
        g.provider("names", {
          loader,
          temporal: "current",
          rows: "one",
          project: (v) => [{ name: v.name }],
          raw: { name: m("Name") },
        }),
        g.itself("artist"),
      ),
    ),
    f,
  };
}

describe("run: defaults", () => {
  it("a loader without keep keeps a whole found answer for a day, an absent or a cut one briefly", async () => {
    const { graph } = build({
      found: { c1: { name: "Mira Volk" }, c2: { name: "Ode Ferris" } },
      cut: { c2: { kind: "cap", limit: 1 } },
    });
    const cache = new MemoryCache();
    await run(
      graph,
      options({ refs: refs("artist", "c1", "c2", "c3"), providers: ["names"], cache }),
    );

    const byAnswer = new Map(
      cache.sets.map((w) => [
        w.answer.kind === "found" ? (w.answer.cuts ? "cut" : "whole") : w.answer.kind,
        w.retention,
      ]),
    );
    expect(Object.fromEntries(byAnswer)).toEqual({ whole: "day", cut: "brief", absent: "brief" });
  });

  it("a loader without partial keeps the keys a failed statement did not take", async () => {
    const { graph } = build({
      found: { c1: { name: "Mira Volk" } },
      unknown: { c2: { reason: "failed" } },
    });
    const result = await run(
      graph,
      options({ refs: refs("artist", "c1", "c2"), providers: ["names"] }),
    );

    expect(providerOf(result, "c1", "names").outcome).toBe("found");
    expect(providerOf(result, "c2", "names").unknown).toEqual([{ reason: "failed" }]);
  });

  it("a run without restriction reads and writes the entries of one with an empty restriction", async () => {
    const { graph, f } = build({ found: { c1: { name: "Mira Volk" } } });
    const cache = new MemoryCache();
    const { restriction: _, ...without } = options({
      refs: refs("artist", "c1"),
      providers: ["names"],
      cache,
    });
    await run(graph, without as RunOptions<Ctx>);
    await run(graph, { ...without, restriction: "" });

    expect(f.calls).toHaveLength(1);
    expect(cache.gets[1]).toEqual(cache.gets[0]);
  });

  it("a run without digest shows a personal key as the SHA-256 of its entity and key id", async () => {
    const g = newGraph();
    const f = fake<{ readonly domain: string }>({ found: { "ada@example.com": { domain: "x" } } });
    const loader = g.loader({
      id: "domains",
      version: 1,
      keyedBy: "email",
      connectors: { allOf: ["db"] },
      batch: { by: "partition" },
      load: f.load,
    });
    const { digest: _, ...without } = options({
      refs: [{ row: "r1", entity: "email", key: "ada@example.com" }],
      providers: ["domains"],
    });
    const result = await run(
      g.graph(
        g.route(
          "email",
          g.provider("domains", {
            loader,
            temporal: "current",
            rows: "one",
            project: (v) => [{ domain: v.domain }],
            raw: { domain: m("Domain") },
          }),
          g.itself("email"),
        ),
      ),
      without as RunOptions<Ctx>,
    );

    const shown = keyDigest("email", "ada@example.com");
    expect(providerOf(result, "r1", "domains").rows.map((r) => r.ref)).toEqual([shown]);
    expect(stepsOf(result, "r1", "provider:domains").map((s) => s.ref)).toEqual([shown]);
    expect(dump(result)).not.toContain("ada@example.com");
  });

  it("a loader without version is version 1: it reads and writes the entries of one declared so", async () => {
    const cache = new MemoryCache();
    const without = build({ found: { c1: { name: "Mira Volk" } } });
    const declared = build({ found: { c1: { name: "Mira Volk" } } }, { version: 1 });
    const asked = { refs: refs("artist", "c1"), providers: ["names"], cache };
    await run(without.graph, options(asked));
    const again = await run(declared.graph, options(asked));

    expect(declared.f.calls).toEqual([]);
    expect(providerOf(again, "c1", "names").outcome).toBe("found");
    expect([...cache.written()]).toEqual([expect.stringMatching(/^hopgraph:1:answer:names:1:/)]);
  });
});

describe("run: a run given only its rows, its providers and its ctx", () => {
  const KEYS = Array.from({ length: 12 }, (_, i) => `a${i + 1}`);
  const NAMES = Object.fromEntries(KEYS.map((key) => [key, { name: key.toUpperCase() }]));
  const only = { refs: refs("artist", ...KEYS), providers: ["names"], ctx: CTX };

  it("reads every connector", async () => {
    const { graph } = build({ found: NAMES });
    const result = await run(graph, only);

    expect(KEYS.map((key) => providerOf(result, key, "names").outcome)).toEqual(
      KEYS.map(() => "found"),
    );
  });

  it("keeps nothing: the next run reads its sources again", async () => {
    const { graph, f } = build({ found: NAMES });
    await run(graph, only);
    await run(graph, only);

    expect(f.loaded()).toEqual([...KEYS, ...KEYS].sort());
  });

  it("bounds no connector: every call of a step runs at once", async () => {
    const { graph, f } = build({ found: NAMES, delayMs: 5 }, { batch: { by: "keys", max: 1 } });
    await run(graph, only);

    expect(f.inflight.max).toBe(KEYS.length);
  });
});

describe("run: ctx", () => {
  it("may be left out when the graph's Ctx admits undefined: a graph whose runs carry nothing", async () => {
    const g = hopgraph<Meta>().entities({ artist: entity({ key: z.string() }) });
    const f = fake<{ readonly name: string }>({ found: { c1: { name: "Mira Volk" } } });
    const loader = g.loader({
      id: "names",
      keyedBy: "artist",
      connectors: { allOf: ["db"] },
      batch: { by: "partition" },
      load: f.load,
    });
    const result = await run(
      g.graph(
        g.route(
          "artist",
          g.provider("names", {
            loader,
            temporal: "current",
            rows: "one",
            project: (v) => [{ name: v.name }],
            raw: { name: m("Name") },
          }),
          g.itself("artist"),
        ),
      ),
      { refs: refs("artist", "c1"), providers: ["names"] },
    );

    expect(providerOf(result, "c1", "names").outcome).toBe("found");
    // @ts-expect-error: the graph's runs carry nothing: a ctx of another type is refused
    await run(g.graph(), { refs: [], providers: [], ctx: { today: "2026-11-01" } });
  });

  it("is the graph's own: a graph whose loads read { a, b } is not a graph of { a }", () => {
    const g = hopgraph<Meta, string, { readonly a: string; readonly b: string }>().entities({
      artist: entity({ key: z.string() }),
    });
    // routes alike (none), so that only the ctx differs
    const ofA = (graph: Graph<Entities, { readonly a: string }, Meta, never>) => graph;
    // @ts-expect-error: a run of { a } would give its loads half of what they read
    ofA(g.graph());
    expectTypeOf(g.graph()).toExtend<
      Graph<Entities, { readonly a: string; readonly b: string }, Meta, never>
    >();
  });

  it("is required, and checked against the graph's Ctx, otherwise", async () => {
    const { graph } = build({});
    // @ts-expect-error: the graph's Ctx does not admit undefined: ctx is required
    const missing = run(graph, { refs: [], providers: [] });
    // @ts-expect-error: a ctx that is not the graph's Ctx
    const wrong = run(graph, { refs: [], providers: [], ctx: { today: 1 } });
    await Promise.allSettled([missing, wrong]);
    expectTypeOf<RunOptions<Ctx>["ctx"]>().toEqualTypeOf<Ctx>();
    expectTypeOf<RunOptions<undefined>["ctx"]>().toEqualTypeOf<undefined>();
  });
});
