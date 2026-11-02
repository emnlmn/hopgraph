// Found while reading the executor for test/props/determinism.test.ts, and written by hand: random
// graphs reach this shape too rarely. The keys of a wave were cut into a loader's batches in the
// order the steps' reads reached the wave, and that order was the order the reads of the wave
// before finished in. When a call throws, every key it held fails; so which keys failed with it,
// and what a row was told, depended on timing. Here two providers read one artists loader in
// batches of two, one reached through statements, the other through masters; artist a3's read
// throws. When masters answered first, a2 shared a3's call and was unknown; when statements
// answered first, a2 shared a1's and was found.
//
// Fixed: a job's keys are cut into the loader's batches in key order (src/run/job.ts), whatever
// order the reads reached it in. Here a1 and a2 share a call, and a3 fails alone.

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

class Broken extends Error {
  override name = "Broken";
}

function graph(slow: { name: string }) {
  const g = hopgraph<Record<string, never>, { readonly label: string }>().entities({
    track: entity({ key: text }),
    artist: entity({ key: text }),
  });
  const common = {
    version: 1,
    connectors: { allOf: ["db"] },
    keep: (): Retention => "day",
    partial: "keep",
  } as const;
  type Artists = { readonly artists: readonly string[] };
  const links = (id: string, artists: readonly string[]) =>
    g.loader({
      ...common,
      id,
      keyedBy: "track",
      batch: { by: "partition" },
      load: async (refs): Promise<Envelope<string, Artists>> => {
        await sleep(slow.name === id ? 20 : 1);
        return envelope(refs.map((r) => [r.key, { kind: "found", value: { artists } }] as const));
      },
    });
  const artists = g.loader({
    ...common,
    id: "artists",
    keyedBy: "artist",
    batch: { by: "keys", max: 2 },
    load: async (refs) => {
      if (refs.some((r) => r.key === "a3")) throw new Broken();
      return envelope(refs.map((r) => [r.key, { kind: "found", value: { name: r.key } }] as const));
    },
  });
  const to = (_ref: unknown, v: Artists) => v.artists.map((a) => ({ to: a }));
  const featured = g.relation("track", "artist", "featured", {
    cardinality: "N:N",
    strategies: (s) => [s(links("statements", ["a1"]), { project: to })],
  });
  const remixed = g.relation("track", "artist", "remixed", {
    cardinality: "N:N",
    strategies: (s) => [s(links("masters", ["a2", "a3"]), { project: to })],
  });
  const name = { name: { meta: { label: "Name" } } };
  const guests = g.provider("guests", {
    loader: artists,
    temporal: "current",
    rows: "one",
    project: (c) => [c],
    raw: name,
  });
  const remixers = g.provider("remixers", {
    loader: artists,
    temporal: "current",
    rows: "one",
    project: (c) => [c],
    raw: name,
  });
  return g.graph(
    g.route("track", guests, g.path(featured)),
    g.route("track", remixers, g.path(remixed)),
  );
}

it("which keys a throwing call takes with it does not depend on timing", async () => {
  const slow = { name: "statements" };
  const g = graph(slow);
  const remixers = async (name: string) => {
    slow.name = name;
    const result = await run(g, {
      refs: [{ row: "r1", entity: "track", key: "t1" }],
      providers: ["guests", "remixers"],
      ctx: {},
      restriction: "",
      readable: () => true,
      cache: { getMany: async () => new Map(), setMany: async () => undefined },
      limits: {},
      digest: (_entity, keyId) => keyId,
    });
    return result.rows.get("r1")?.providers.remixers?.rows.map((r) => r.ref);
  };
  // a2 shares a1's call and is found; a3 fails alone
  expect(await remixers("statements")).toEqual(["a2"]);
  expect(await remixers("masters")).toEqual(["a2"]);
});
