// Found by test/props/determinism.test.ts, "the same inputs and cache give the same result,
// whatever the timing". When a resume approved two gates and both prices grew past their
// approvals, the run rejected with the CostChangedError of whichever dry run finished first: the
// gate it named depended on timing, and a consumer that asked for that one approval again met the
// other gate on the next run, one round more than it needed.
//
// Fixed: the first refusal stops what would load in its wave and after it, every job of its wave is
// still priced, and the run fails with one error that names the first refused gate by id (`gate`)
// and lists every refused one (`gates`), so both can be approved again in one round.

import { CostChangedError, entity, envelope, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Two metered sources priced at 100 bytes, each needing approval; `slow` names the one whose dry
 *  run takes longer. */
function graph(slow: { name: string }) {
  const g = hopgraph<{ readonly label: string }, string, Record<string, never>>().entities({
    track: entity({ key: text }),
  });
  const metered = (id: string) =>
    g.loader({
      id,
      version: 1,
      keyedBy: "track",
      connectors: { allOf: ["warehouse"] },
      batch: { by: "partition" },
      keep: () => "day",
      partial: "keep",
      cost: { metered: { auto: 10, approve: 1000 } },
      price: async () => {
        await sleep(slow.name === id ? 20 : 1);
        return 100;
      },
      load: async (refs) => envelope(refs.map((r) => [r.key, { kind: "absent" }] as const)),
    });
  const m = { meta: { label: "x" } };
  const routes = ["a", "b"].map((id) => {
    const provider = g.provider(id, {
      loader: metered(id),
      temporal: "historical",
      rows: "one",
      project: () => [{ x: 1 }],
      raw: { x: m },
    });
    return g.route("track", provider, g.itself("track"));
  });
  return g.graph(...routes);
}

it("a resume that refuses two approvals names them both, the same first, whatever the timing", async () => {
  const slow = { name: "a" };
  const g = graph(slow);
  const options = {
    refs: [{ row: "r1", entity: "track", key: "t1" }],
    providers: ["a", "b"],
    ctx: {},
    restriction: "",
    readable: () => true as const,
    cache: { getMany: async () => new Map(), setMany: async () => undefined },
    limits: {},
    digest: (_entity: string, keyId: string) => keyId,
  };
  const first = await run(g, options);
  expect(first.gates.map((gate) => gate.bytes)).toEqual([100, 100]);
  // both approvals fall short of the price
  const approved = Object.fromEntries(first.gates.map((gate) => [gate.id, 99]));

  const refused = async (name: string) => {
    slow.name = name;
    const error = await run(g, { ...options, approved }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CostChangedError);
    const { gate, gates } = error as CostChangedError;
    return { gate, gates };
  };
  const slowA = await refused("a");
  expect(slowA).toEqual(await refused("b"));
  // the first by gate id, and both, with what each was approved and is priced at now
  const ids = first.gates.map((gate) => gate.id).sort();
  expect(slowA).toEqual({
    gate: ids[0],
    gates: ids.map((gate) => ({ gate, approved: 99, priced: 100 })),
  });
});
