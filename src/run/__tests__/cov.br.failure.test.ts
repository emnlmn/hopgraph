// What a quiet failed wave fails the run with (reads.ts `failureError`): the failure recorded for
// it; none recorded is an internal error, since every job records what it threw before it leaves.

import { describe, expect, it } from "vitest";
import { HopgraphError } from "../../core/index.ts";
import { failureError } from "../reads.ts";

describe("failureError", () => {
  it("is the error the failed wave recorded", () => {
    const error = new Error("quota");
    expect(failureError({ error })).toBe(error);
  });

  it("refuses a failed wave with nothing recorded with HG_INTERNAL", () => {
    expect(() => failureError(undefined)).toThrow(
      expect.objectContaining({ code: "HG_INTERNAL", name: expect.any(String) }),
    );
    expect(() => failureError(undefined)).toThrow(HopgraphError);
  });
});
