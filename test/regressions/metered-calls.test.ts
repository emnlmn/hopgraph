// Found by test/props/billing.test.ts, "no metered loader bills past its approval". A metered
// loader is priced once per wave (one dry run per call layer), and every call of the wave gets
// the whole wave's price as its budget (`budget.maxBytes`). A loader that makes more than one call
// in a wave (`batch: { by: "keys" }` or `{ by: "one" }`) can then bill the price once per call:
// each call stays within its budget, the calls together do not. A job's fixed scan (a dimension
// table every statement joins) is enough: two keys priced together at 22 bytes, under an auto cap
// of 30, are loaded in two calls of 21 bytes each, 42 in all, with no approval.
//
// Fixed: the calls of a metered wave take turns, and each is told what the calls before it left of
// the wave's budget (src/run/job.ts, and `Purse` in src/run/calls.ts). Here the second call is told
// 1 byte.

import { entity, envelope, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

it("a metered loader's calls in one wave bill no more than its auto cap together", async () => {
  const SCAN = 20; // every statement scans this much, whatever its keys
  const bytes = (keys: number) => SCAN + keys; // and one byte per key
  const g = hopgraph<Record<string, never>, { readonly label: string }>().entities({
    track: entity({ key: text }),
  });
  const tracks = g.loader({
    id: "tracks",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["warehouse"] },
    batch: { by: "keys", max: 1 },
    keep: () => "day",
    partial: "keep",
    cost: { metered: { auto: 30, approve: 100 } },
    price: async (refs) => bytes(refs.length),
    load: async (refs, _ctx, budget) =>
      envelope(
        refs.map((r) => [r.key, { kind: "found", value: { plays: 1 } }] as const),
        // a job bills what it scans, never more than its budget
        Math.min(bytes(refs.length), budget.maxBytes ?? Number.POSITIVE_INFINITY),
      ),
  });
  const plays = g.provider("plays", {
    loader: tracks,
    temporal: "historical",
    rows: "one",
    project: (t) => [t],
    raw: { plays: { meta: { label: "Plays" } } },
  });

  const result = await run(g.graph(g.route("track", plays, g.itself("track"))), {
    refs: [
      { row: "r1", entity: "track", key: "t1" },
      { row: "r2", entity: "track", key: "t2" },
    ],
    providers: ["plays"],
    ctx: {},
    restriction: "",
    readable: () => true,
    cache: { getMany: async () => new Map(), setMany: async () => undefined },
    limits: {},
    digest: (_entity, keyId) => keyId,
  });

  expect(result.status).toBe("complete");
  expect(result.prices.size).toBe(1);
  expect([...result.prices.values()]).toEqual([22]);
  // priced at 22, run without approval under the auto cap of 30: it billed 42
  expect(result.billedBytes).toBeLessThanOrEqual(30);
});
