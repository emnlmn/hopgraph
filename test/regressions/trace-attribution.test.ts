// Found by test/props/determinism.test.ts, "the same inputs and cache give the same result,
// whatever the timing". Reads of one loader from several steps in one wave are one job, and the
// job's bill and failures went to the step whose read reached the wave first: which one that was
// depended on which read of the wave before finished first. Two relations that both fall back to
// one loader got its failure in the trace under one or the other, by timing; the same held for
// `cached` and `billedBytes`. Outcomes and row steps did not depend on it.
//
// Fixed: a job's bill, failures and retries go to the asking step with the smallest id, and a key
// it loads is loaded for that step and cached for the others (src/run/reads.ts).

import {
  type Envelope,
  entity,
  envelope,
  hopgraph,
  type Retention,
  run,
  type Schema,
} from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Timeout extends Error {
  override name = "Timeout";
}

/** Two ways from a track to its artist, each a fallback ending on the same artist API loader that
 *  times out; `slow` names the first strategy that answers last. */
function graph(slow: { name: string }) {
  const g = hopgraph<Record<string, never>, { readonly label: string }>().entities({
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
  const nothing = (id: string) =>
    g.loader({
      ...common,
      id,
      keyedBy: "track",
      load: async (refs) => {
        await sleep(slow.name === id ? 20 : 1);
        return envelope<string, { artist: string }>(refs.map((r) => [r.key, { kind: "absent" }]));
      },
    });
  const artistApi = g.loader({
    ...common,
    id: "artistApi",
    keyedBy: "track",
    load: async (): Promise<Envelope<string, { artist: string }>> => {
      throw new Timeout();
    },
  });
  const toArtist = (_ref: unknown, v: { artist: string }) => [{ to: v.artist }];
  const byFeaturing = g.relation("track", "artist", "featuring", {
    cardinality: "N:1",
    combine: "fallback",
    strategies: (s) => [
      s(nothing("statements"), { project: toArtist }),
      s(artistApi, { project: toArtist }),
    ],
  });
  const byRemixing = g.relation("track", "artist", "remixing", {
    cardinality: "N:1",
    combine: "fallback",
    strategies: (s) => [
      s(nothing("masters"), { project: toArtist }),
      s(artistApi, { project: toArtist }),
    ],
  });
  const names = g.loader({
    ...common,
    id: "names",
    keyedBy: "artist",
    load: async (refs) =>
      envelope(refs.map((r) => [r.key, { kind: "found", value: { name: "Mira Volk" } }] as const)),
  });
  const profile = g.provider("profile", {
    loader: names,
    temporal: "current",
    rows: "one",
    project: (c) => [c],
    raw: { name: { meta: { label: "Name" } } },
  });
  return g.graph(g.route("track", profile, g.union(g.path(byFeaturing), g.path(byRemixing))));
}

it("a wave's failures go to the same steps whatever the timing", async () => {
  const slow = { name: "statements" };
  const g = graph(slow);
  const failures = async (name: string) => {
    slow.name = name;
    const result = await run(g, {
      refs: [{ row: "r1", entity: "track", key: "t1" }],
      providers: ["profile"],
      ctx: {},
      restriction: "",
      readable: () => true,
      cache: { getMany: async () => new Map(), setMany: async () => undefined },
      limits: {},
      digest: (_entity, keyId) => keyId,
    });
    return result.trace
      .filter((t) => t.loader === "artistApi")
      .map((t) => ({ step: t.step, errors: t.errors }))
      .sort((a, b) => (a.step < b.step ? -1 : 1));
  };
  expect(await failures("statements")).toEqual(await failures("masters"));
});
