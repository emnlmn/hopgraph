// Found by test/props/determinism.test.ts, "the same inputs and cache give the same result,
// whatever the timing", from a random seed. A step fed by several others offers the refs of each
// feed that is done while it waits for the rest, so that a job of a later wave that reads its
// loader anyway takes them along. The feed done last did not offer: under the barrier, the last
// feed done was always one of the latest wave, and its refs could join no job before the step's
// own. With jobs that start as soon as nothing holds them back, a feed of an earlier wave can be
// done last; its refs then missed a job they belonged in, and for a metered loader that changed
// what was priced together. Here the profiles of a track's artists are read by a step fed by a
// one-read way (`a`, wave 1) and a two-read way (`b`, wave 2), while another step reads profiles in
// wave 2: whether a1 joined that job depended on which way was done first.
//
// Fixed: every feed offers its refs, for the jobs after its own wave and up to the step's
// (src/run/execute.ts). a1 joins the wave-2 job whichever way is done first.

import { entity, envelope, hopgraph, type Retention, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function profiled(slow: "a" | "b") {
  const calls: string[][] = [];
  const g = hopgraph<{ readonly label: string }, string, Record<string, never>>().entities({
    track: entity({ key: text }),
    artist: entity({ key: text }),
  });
  const common = {
    version: 1,
    connectors: { allOf: ["db"] },
    batch: { by: "partition" },
    keep: (): Retention => "day",
    partial: "keep",
  } as const;
  const links = (id: string, to: string | undefined, ms: number) =>
    g.loader({
      ...common,
      id,
      keyedBy: "track",
      load: async (refs) => {
        await sleep(ms);
        return envelope(
          refs.map((r) =>
            to === undefined
              ? ([r.key, { kind: "absent" }] as const)
              : ([r.key, { kind: "found", value: { to } }] as const),
          ),
        );
      },
    });
  const profiles = g.loader({
    ...common,
    id: "profiles",
    keyedBy: "artist",
    load: async (refs) => {
      calls.push(refs.map((r) => r.key).sort());
      return envelope(refs.map((r) => [r.key, { kind: "found", value: { name: r.key } }] as const));
    },
  });
  const to = (_ref: unknown, v: { to: string }) => [{ to: v.to }];
  const a = g.relation("track", "artist", "a", {
    cardinality: "N:1",
    strategies: (s) => [s(links("a1", "a1", slow === "a" ? 30 : 1), { project: to })],
  });
  const b = g.relation("track", "artist", "b", {
    cardinality: "N:1",
    combine: "fallback",
    strategies: (s) => [
      s(links("b1", undefined, slow === "b" ? 30 : 1), { project: to }),
      s(links("b2", "a2", 1), { project: to }),
    ],
  });
  const c = g.relation("track", "artist", "c", {
    cardinality: "N:1",
    strategies: (s) => [s(links("c1", "a3", 1), { project: to })],
  });
  const spec = {
    loader: profiles,
    temporal: "current",
    rows: "one",
    project: (v: { name: string }) => [v],
    raw: { name: { meta: { label: "Name" } } },
  } as const;
  await run(
    g.graph(
      g.route("track", g.provider("both", spec), g.union(g.path(a), g.path(b))),
      g.route("track", g.provider("third", spec), g.path(c)),
    ),
    {
      refs: [{ row: "r1", entity: "track", key: "t1" }],
      providers: ["both", "third"],
      ctx: {},
      restriction: "",
      readable: () => true,
      cache: { getMany: async () => new Map(), setMany: async () => undefined },
      limits: {},
      digest: (_entity, keyId) => keyId,
    },
  );
  return calls;
}

it("the refs of every feed join the jobs of the waves before the step's own, whichever feed is done last", async () => {
  // wave 2: a3 for the third provider, and a1, offered by `a`; then a2, read by `both` itself
  expect(await profiled("a")).toEqual([["a1", "a3"], ["a2"]]);
  expect(await profiled("b")).toEqual([["a1", "a3"], ["a2"]]);
});
