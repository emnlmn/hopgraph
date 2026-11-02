// Found by test/props/billing.test.ts, "a run that fails starts nothing afterwards". DESIGN.md §5.3
// says that once a run has failed nothing new starts. A load does not (it checks before its call),
// but a dry run still can: a metered loader in the same wave as the failure, whose cache lookup
// was still running when the run failed, prices its keys afterwards. A dry run bills nothing, so
// no approval is broken; it is still a call to a source on behalf of a run that has already
// failed.
//
// Fixed: a failed run aborts what is running and starts nothing more, dry runs included (the run's
// stop, src/run/stop.ts).

import { entity, envelope, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

class QuotaSpent extends Error {
  override name = "QuotaSpent";
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

it("no dry run starts after the run has failed", async () => {
  const events: string[] = [];
  const g = hopgraph<Record<string, never>, { readonly label: string }>().entities({
    track: entity({ key: text }),
  });
  const api = g.loader({
    id: "api",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["api"] },
    batch: { by: "one", concurrency: 1 },
    keep: () => "day",
    partial: "keep",
    load: async () => {
      events.push("api fails");
      throw new QuotaSpent();
    },
  });
  const warehouse = g.loader({
    id: "warehouse",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["warehouse"] },
    batch: { by: "partition" },
    keep: () => "day",
    partial: "keep",
    cost: { metered: { auto: 100, approve: 1000 } },
    price: async () => {
      events.push("warehouse priced");
      return 10;
    },
    load: async (refs) => envelope(refs.map((r) => [r.key, { kind: "absent" }] as const)),
  });
  const m = { meta: { label: "x" } };
  const status = g.provider("status", {
    loader: api,
    temporal: "current",
    rows: "one",
    project: () => [{ ok: true }],
    raw: { ok: m },
  });
  const plays = g.provider("plays", {
    loader: warehouse,
    temporal: "historical",
    rows: "one",
    project: () => [{ plays: 1 }],
    raw: { plays: m },
  });

  const failed = run(
    g.graph(
      g.route("track", status, g.itself("track")),
      g.route("track", plays, g.itself("track")),
    ),
    {
      refs: [{ row: "r1", entity: "track", key: "t1" }],
      providers: ["status", "plays"],
      ctx: {},
      restriction: "",
      readable: () => true,
      cache: {
        // the warehouse's lookup is slow: the api's call fails meanwhile
        getMany: async (keys) => {
          if (keys.some((k) => k.includes("warehouse"))) {
            events.push("warehouse lookup");
            await sleep(20);
          }
          return new Map();
        },
        setMany: async () => undefined,
      },
      limits: {},
      digest: (_entity, keyId) => keyId,
      fatal: (e) => e instanceof QuotaSpent,
    },
  );
  await expect(failed).rejects.toBeInstanceOf(QuotaSpent);
  events.push("run failed");
  await sleep(50);

  expect(events.slice(0, 2).sort()).toEqual(["api fails", "warehouse lookup"]);
  expect(events.at(-1)).toBe("run failed");
});
