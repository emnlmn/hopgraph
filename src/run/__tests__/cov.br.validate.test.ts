// Validating links: a link projected without attributes, of a relation that declares their schema,
// is parsed as the empty attributes it stands for.

import { expect, it } from "vitest";
import { z } from "zod";
import { run } from "../index.ts";
import { fake, free, link, m, newGraph, options, providerOf, refs, rowsOf } from "./support.ts";

it("a link without attributes is parsed by the relation's link schema as `{}`: its defaults fill it", async () => {
  const g = newGraph();
  const recordings = g.loader({
    ...free,
    id: "recordings",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: fake<{ master: string }>({ found: { t1: { master: "m1" } } }).load,
  });
  const masterInfo = g.loader({
    ...free,
    id: "masterInfo",
    keyedBy: "master",
    connectors: { allOf: ["db"] },
    load: fake<{ minutes: number }>({ found: { m1: { minutes: 3 } } }).load,
  });
  const mastered = g.relation("track", "master", "mastered", {
    cardinality: "N:1",
    link: z.object({ rank: z.number().default(1) }),
    strategies: (s) => [
      // as plain JavaScript may: the attributes left out
      s(recordings, {
        project: (_ref, v) => [{ to: v.master } as { to: string; attrs: { rank: number } }],
      }),
    ],
  });
  const info = g.provider("masterInfo", {
    loader: masterInfo,
    temporal: "current",
    rows: "one",
    project: (v) => [{ minutes: v.minutes }],
    raw: { minutes: m("Minutes") },
  });
  const graph = g.graph(g.route("track", info, g.path(mastered)));

  const result = await run(
    graph,
    options({ refs: refs("track", "t1"), providers: ["masterInfo"] }),
  );

  const p = providerOf(result, "t1", "masterInfo");
  expect(p.outcome).toBe("found");
  expect(rowsOf(p).map((r) => r.lineage)).toEqual([
    [[link("track › master:mastered", "recordings", "t1", "m1", { rank: 1 })]],
  ]);
});
