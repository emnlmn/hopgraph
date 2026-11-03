// Found by review. The types refuse connectors other than `{ allOf }` and `{ oneOf }` and routes
// other than a path or a union, but a graph declared from plain JavaScript, or behind a cast, kept
// them as given: the run then failed with a TypeError, not a HopgraphError, and a step fed by two
// others threw while offering its refs ahead, inside a promise nobody waited for: two unhandled
// rejections, which end a Node process.
//
// Fixed: the builder refuses those shapes with HG_SPEC (src/core/graph.ts, tested in
// src/core/__tests__/graph.test.ts), and an offer that throws is dropped: the step reads its refs
// itself (src/run/execute.ts). This test corrupts a declared graph to show the second.

import { entity, envelope, found, hopgraph, run, type Schema } from "hopgraph";
import { afterEach, expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const unhandled: unknown[] = [];
const listen = (reason: unknown) => unhandled.push(reason);
afterEach(() => {
  process.off("unhandledRejection", listen);
  unhandled.length = 0;
});

it("a step fed by two others leaves no unhandled rejection when its loader cannot be offered to", async () => {
  process.on("unhandledRejection", listen);
  const g = hopgraph<{ readonly label: string }, string, Record<string, never>>().entities({
    track: entity({ key: text }),
    artist: entity({ key: text }),
  });
  const common = { version: 1, connectors: { allOf: ["db"] }, batch: { by: "partition" } } as const;
  const way = (id: string, to: string, ms: number) =>
    g.loader({
      ...common,
      id,
      keyedBy: "track",
      load: async (refs) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return envelope(refs.map((r) => [r.key, found({ to })]));
      },
    });
  const profiles = g.loader({
    ...common,
    id: "profiles",
    keyedBy: "artist",
    load: async (refs) => envelope(refs.map((r) => [r.key, found({ name: r.key })])),
  });
  const to = (_ref: unknown, v: { to: string }) => [{ to: v.to }];
  const a = g.relation("track", "artist", "a", {
    cardinality: "N:1",
    strategies: (s) => [s(way("a1", "a1", 1), { project: to })],
  });
  const b = g.relation("track", "artist", "b", {
    cardinality: "N:1",
    strategies: (s) => [s(way("b1", "a2", 20), { project: to })],
  });
  const graph = g.graph(
    g.route(
      "track",
      g.provider("both", {
        loader: profiles,
        temporal: "current",
        rows: "one",
        project: (v) => [v],
        raw: { name: { meta: { label: "Name" } } },
      }),
      g.union(g.path(a), g.path(b)),
    ),
  );
  // what a graph from plain JavaScript could hold
  Object.assign(graph.loaders.get("profiles") ?? {}, { connectors: { any: ["db"] } });

  const error = await run(graph, {
    refs: [{ row: "r1", entity: "track", key: "t1" }],
    providers: ["both"],
    ctx: {},
    readable: () => true,
    cache: { getMany: async () => new Map(), setMany: async () => undefined },
    limits: {},
  }).then(
    () => undefined,
    (e: unknown) => e,
  );
  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(error).toBeInstanceOf(TypeError);
  expect(unhandled).toEqual([]);
});
