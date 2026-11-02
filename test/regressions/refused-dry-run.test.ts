// Found by test/props/billing.test.ts, "a run that fails starts nothing afterwards", on
// HOPGRAPH_SEED=541467674. A resume approved two gates of one wave, L0 and L1, both priced 73: L1
// at 73, L0 at 72. L1's dry run answered first and its job loaded within its approval; then L0's
// answered, refused, and the run aborted L1's load and rejected naming L0. The design allows that
// (DESIGN.md §5.4: the loads already running are aborted). The property found the refusing dry
// run as the last one of any loader that priced 73, which was L1's, and so called L1's load late.
//
// Fixed in the property: the refusing dry run is the gate's own loader's (test/props/oracle.ts).

import { expect, it } from "vitest";
import type { Event } from "../props/harness.ts";
import { gateLoader, refusingDryRun } from "../props/oracle.ts";

it("the dry run that refused a gate is its own loader's, not another's at the same price", () => {
  const events: Event[] = [
    { kind: "get", entries: 2, hits: 0 },
    { kind: "price", loader: "L0", keys: ["e0-k0", "e0-k1"], attempt: 1, bytes: 73 },
    { kind: "price", loader: "L1", keys: ["e0-k0", "e0-k1"], attempt: 1, bytes: 73 },
    { kind: "load", loader: "L1", keys: ["e0-k0"], attempt: 1, budget: { maxBytes: 73 } },
  ];
  const refused = { gate: "L0:12a714e6", approved: 72, priced: 73 };
  expect(gateLoader(refused.gate)).toBe("L0");
  expect(refusingDryRun(events, refused)).toBe(1);
  expect(refusingDryRun(events, { gate: "L2:00", priced: 73 })).toBe(-1);
});
