// The walk's guard on the ledger (ledger.ts `evaluated`): every step a route can walk is evaluated
// by the plan, so the guard only ever passes an answer through; a missing one is an internal error.

import { describe, expect, it } from "vitest";
import { HopgraphError } from "../../core/index.ts";
import { evaluated } from "../ledger.ts";

describe("evaluated", () => {
  it("passes an evaluated answer through unchanged", () => {
    const answer = { steps: [] };
    expect(evaluated(answer)).toBe(answer);
  });

  it("refuses a step the run did not evaluate with HG_INTERNAL", () => {
    expect(() => evaluated(undefined)).toThrow(HopgraphError);
    try {
      evaluated(undefined);
    } catch (error) {
      expect((error as HopgraphError).code).toBe("HG_INTERNAL");
    }
  });
});
