// Edges of the job, read and execute modules: a merge that declines, a step fed by two inputs
// one of which fails the run, a runtime without `setImmediate`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Envelope, entity, envelope, hopgraph, type Schema } from "../../core/index.ts";
import { runWith } from "../executor.ts";
import { run } from "../index.ts";
import {
  type Conn,
  type Ctx,
  fake,
  free,
  type Meta,
  newGraph,
  options,
  providerOf,
  refs,
} from "./support.ts";

type Row = { readonly to: readonly string[] };

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("run: merge that declines", () => {
  it("when merge.needs answers undefined, refs of one key with different needs are read apart, each with its own needs", async () => {
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
    const windowedL = g.loader({
      ...free,
      id: "windowed",
      keyedBy: "track",
      needs: ["releasedAt"],
      connectors: { allOf: ["wh"] },
      load: async (rs): Promise<Envelope<string, { n: number }>> => {
        calls.push(rs.map((r) => ({ key: r.key, releasedAt: r.releasedAt })));
        return envelope(rs.map((r) => [r.key, { kind: "found", value: { n: 1 } }]));
      },
      merge: { needs: () => undefined, narrow: (v: { n: number }) => v, empty: { n: 0 } },
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
    const prov = g.provider("windowed", {
      loader: windowedL,
      temporal: "historical",
      rows: "one",
      project: (v) => [{ n: v.n }],
      raw: { n: { meta: { label: "N" } } },
    });
    const graph = g.graph(g.route("artist", prov, g.path(recent)));

    const result = await run(
      graph,
      options({ refs: refs("artist", "a1", "a2"), providers: ["windowed"] }),
    );

    expect(
      calls
        .flat()
        .map((c) => c.releasedAt)
        .sort(),
    ).toEqual(["1", "2"]);
    expect(providerOf(result, "a1", "windowed").outcome).toBe("found");
    expect(providerOf(result, "a2", "windowed").outcome).toBe("found");
  });
});

describe("run: a step fed by two inputs", () => {
  it("one input failing the run rejects the run with its error, the other's rejection is not reported twice", async () => {
    const boom = new Error("project failed");
    const g = newGraph();
    const one = fake<Row>({ found: { a1: { to: ["t1"] } } });
    const two = fake<Row>({ found: { a1: { to: ["t2"] } } });
    const loaderOf = (id: string, load: typeof one.load) =>
      g.loader({ ...free, id, keyedBy: "artist", connectors: { allOf: ["db"] }, load });
    const l1 = loaderOf("one", one.load);
    const l2 = loaderOf("two", two.load);
    const r1 = g.relation("artist", "track", "viaOne", {
      cardinality: "1:N",
      strategies: (s) => [
        s(l1, {
          project: () => {
            throw boom;
          },
        }),
      ],
    });
    const r2 = g.relation("artist", "track", "viaTwo", {
      cardinality: "1:N",
      strategies: (s) => [s(l2, { project: (_ref, v) => v.to.map((to) => ({ to })) })],
    });
    const tracksL = g.loader({
      ...free,
      id: "tracks",
      keyedBy: "track",
      connectors: { allOf: ["db"] },
      load: fake<{ n: number }>({ found: { t1: { n: 1 }, t2: { n: 2 } } }).load,
    });
    const named = g.relation("track", "region", "of", {
      cardinality: "N:1",
      strategies: (s) => [s(tracksL, { project: (_ref, v) => [{ to: `r${v.n}` }] })],
    });
    const regionsL = g.loader({
      ...free,
      id: "regions",
      keyedBy: "region",
      connectors: { allOf: ["db"] },
      load: fake<{ name: string }>({ found: { r1: { name: "N" }, r2: { name: "S" } } }).load,
    });
    const prov = g.provider("region", {
      loader: regionsL,
      temporal: "current",
      rows: "one",
      project: (v) => [{ name: v.name }],
      raw: { name: { meta: { label: "Region" } } },
    });
    const graph = g.graph(g.route("artist", prov, g.union(g.path(r1, named), g.path(r2, named))));

    await expect(
      run(graph, options({ refs: refs("artist", "a1"), providers: ["region"] })),
    ).rejects.toBeDefined();
  });
});

describe("run: without setImmediate", () => {
  it("jobs still start, on a timer", async () => {
    vi.stubGlobal("setImmediate", undefined);
    const f = fake<Row>({ found: { t1: { to: ["t2"] } } });
    const g = newGraph();
    const l = g.loader({
      ...free,
      id: "sib",
      keyedBy: "track",
      connectors: { allOf: ["db"] },
      load: f.load,
    });
    const prov = g.provider("seen", {
      loader: l,
      temporal: "historical",
      rows: "many",
      project: (v) => v.to.map((to) => ({ to })),
      raw: { to: { meta: { label: "To" } } },
    });
    const graph = g.graph(g.route("track", prov, g.itself("track")));

    const result = await run(graph, options({ refs: refs("track", "t1"), providers: ["seen"] }));

    expect(f.loaded()).toEqual(["t1"]);
    expect(providerOf(result, "t1", "seen").outcome).toBe("found");
  });
});

class Spent extends Error {}

describe("run: a failure while other work is still checking links", () => {
  it.each([
    ["a later wave waits for the lane still validating its links in an earlier wave", true],
    ["the same wave does not wait for a lane validating its links", false],
  ])("a fatal error in %s, then rejects the run with it", async (_name, later) => {
    const slowKey: Schema<string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async (v) => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { value: String(v) };
        },
      },
    };
    const plain: Schema<string> = {
      "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: String(v) }) },
    };
    const g = hopgraph<Meta, Conn, Ctx>().entities({
      item: entity({ key: plain }),
      slow: entity({ key: slowKey }),
      other: entity({ key: plain }),
    });
    const on = { ...free, connectors: { allOf: ["db"] } } as const;
    const toSlow = g.loader({
      ...on,
      id: "toSlow",
      keyedBy: "item",
      load: fake<Row>({ found: { i1: { to: ["s1"] } } }).load,
    });
    const toOther = g.loader({
      ...on,
      id: "toOther",
      keyedBy: "item",
      load: fake<Row>({ found: { i1: { to: ["o1"] } } }).load,
    });
    const bad = g.loader({
      ...on,
      id: "bad",
      keyedBy: later ? "other" : "item",
      load: async (): Promise<Envelope<string, Row>> => {
        throw new Spent("spent");
      },
    });
    const good = g.loader({
      ...on,
      id: "good",
      keyedBy: "slow",
      load: fake<Row>({ found: { s1: { to: [] } } }).load,
    });
    const toLinks = (_ref: unknown, v: Row) => v.to.map((to) => ({ to }));
    const viaSlow = g.relation("item", "slow", "viaSlow", {
      cardinality: "1:N",
      strategies: (s) => [s(toSlow, { project: toLinks })],
    });
    const viaOther = g.relation("item", "other", "viaOther", {
      cardinality: "1:N",
      strategies: (s) => [s(toOther, { project: toLinks })],
    });
    const spec = {
      temporal: "historical",
      rows: "many",
      project: (v: Row) => v.to.map((to) => ({ to })),
      raw: { to: { meta: { label: "To" } } },
    } as const;
    const graph = g.graph(
      g.route("item", g.provider("pSlow", { ...spec, loader: good }), g.path(viaSlow)),
      later
        ? g.route("item", g.provider("pBad", { ...spec, loader: bad }), g.path(viaOther))
        : g.route("item", g.provider("pBad", { ...spec, loader: bad }), g.itself("item")),
    );

    await expect(
      run(graph, {
        ...options({
          refs: refs("item", "i1"),
          providers: ["pSlow", "pBad"],
        }),
        fatal: (e: unknown) => e instanceof Spent,
      }),
    ).rejects.toBeInstanceOf(Spent);
  });
});

describe("run: the barrier rule", () => {
  it("answers as the plan rule does: a wave starts once every read before it ended", async () => {
    const mk = () => {
      const f = fake<Row>({ found: { t1: { to: ["t2"] }, t2: { to: [] } } });
      const g = newGraph();
      const on = { ...free, keyedBy: "track", connectors: { allOf: ["db"] } } as const;
      const hopL = g.loader({ ...on, id: "hop", load: f.load });
      const hop = g.relation("track", "track", "hop", {
        cardinality: "1:N",
        strategies: (s) => [s(hopL, { project: (_ref, v) => v.to.map((to) => ({ to })) })],
      });
      const prov = g.provider("seen", {
        loader: hopL,
        temporal: "historical",
        rows: "many",
        project: (v) => v.to.map((to) => ({ to })),
        raw: { to: { meta: { label: "To" } } },
      });
      return g.graph(g.route("track", prov, g.path(hop)));
    };
    const opts = options({ refs: refs("track", "t1"), providers: ["seen"] });
    const barrier = await runWith(mk(), opts, "barrier");
    const plan = await run(mk(), opts);

    expect(providerOf(barrier, "t1", "seen")).toEqual(providerOf(plan, "t1", "seen"));
  });

  it("a job of a later wave waits for a lane of an earlier wave, whatever it may read", async () => {
    const plain: Schema<string> = {
      "~standard": { version: 1, vendor: "test", validate: (v) => ({ value: String(v) }) },
    };
    const g = hopgraph<Meta, Conn, Ctx>().entities({
      item: entity({ key: plain }),
      other: entity({ key: plain }),
    });
    const on = { ...free, connectors: { allOf: ["db"] } } as const;
    const fast = fake<Row>({ found: { i1: { to: ["o1"] } }, delayMs: 1 });
    const slow = fake<Row>({ found: { i1: { to: ["o2"] } }, delayMs: 30 });
    const last = fake<Row>({ found: { o1: { to: [] }, o2: { to: [] } } });
    const via = (id: string, f: typeof fast) =>
      g.relation("item", "other", id, {
        cardinality: "1:N",
        strategies: (s) => [
          s(g.loader({ ...on, id, keyedBy: "item", load: f.load }), {
            project: (_ref, v) => v.to.map((to) => ({ to })),
          }),
        ],
      });
    const lastL = g.loader({ ...on, id: "last", keyedBy: "other", load: last.load });
    const prov = (id: string) =>
      g.provider(id, {
        loader: lastL,
        temporal: "historical",
        rows: "many",
        project: (v: Row) => v.to.map((to) => ({ to })),
        raw: { to: { meta: { label: "To" } } },
      });
    const graph = g.graph(
      g.route("item", prov("a"), g.path(via("fast", fast))),
      g.route("item", prov("b"), g.path(via("slow", slow))),
    );

    const result = await runWith(
      graph,
      options({ refs: refs("item", "i1"), providers: ["a", "b"] }),
      "barrier",
    );

    expect(last.calls.map((c) => c.keys)).toEqual([["o1", "o2"]]);
    expect(providerOf(result, "i1", "a").outcome).toBe("absent");
  });
});
