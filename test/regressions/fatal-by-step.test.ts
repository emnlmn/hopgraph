// Found by review of the run code. Of two errors thrown in one wave that fail the run, the run
// rejected with the first in time, so which one a caller saw depended on which source answered
// first. Refused approvals were already named by gate id.
//
// Fixed: of the errors the jobs of one wave throw, the run rejects with the one of the job whose
// smallest step id comes first, then by loader id (src/run/reads.ts `fail`). Dry runs of the wave
// all end, so two that fail are both seen; a load that fails stops the other loads of its wave at
// once, and an error one of them would have thrown after is not seen (DESIGN.md §5.4).

import { entity, envelope, found, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

class Quota extends Error {
  override name = "Quota";
  constructor(readonly source: string) {
    super(`quota of ${source} spent`);
  }
}

it("two dry runs of one wave that fail the run: the run rejects with the smaller step's, whichever ends first", async () => {
  for (const [aMs, bMs] of [
    [20, 1],
    [1, 20],
  ]) {
    const g = hopgraph<{ readonly label: string }, string, Record<string, never>>().entities({
      track: entity({ key: text }),
    });
    const metered = (id: string, ms: number) =>
      g.loader({
        id,
        version: 1,
        keyedBy: "track",
        connectors: { allOf: ["wh"] },
        batch: { by: "partition" },
        cost: { metered: { auto: 100, approve: 1000 } },
        price: async () => {
          await sleep(ms);
          throw new Quota(id);
        },
        load: async (refs) => envelope(refs.map((r) => [r.key, found({ n: 1 })])),
      });
    const spec = {
      temporal: "current",
      rows: "one",
      project: (v: { n: number }) => [v],
      raw: { n: { meta: { label: "N" } } },
    } as const;

    const error = await run(
      g.graph(
        g.route(
          "track",
          g.provider("a", { ...spec, loader: metered("la", aMs ?? 0) }),
          g.itself("track"),
        ),
        g.route(
          "track",
          g.provider("b", { ...spec, loader: metered("lb", bMs ?? 0) }),
          g.itself("track"),
        ),
      ),
      {
        refs: [{ row: "r1", entity: "track", key: "t1" }],
        providers: ["a", "b"],
        ctx: {},
        readable: () => true,
        cache: { getMany: async () => new Map(), setMany: async () => undefined },
        limits: {},
        fatal: (e) => e instanceof Quota,
      },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Quota);
    expect((error as Quota).source).toBe("la");
  }
});
