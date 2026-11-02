// CostChangedError's message counts the gates past the first.

import { describe, expect, it } from "vitest";
import { CostChangedError } from "../index.ts";

describe("CostChangedError", () => {
  it("says one more gate for two refused gates, and more gates (plural) for three", () => {
    const gate = (g: string) => ({ gate: g, approved: 1, priced: 2 });
    const two = new CostChangedError("a", 1, 2, [gate("a"), gate("b")]);
    const three = new CostChangedError("a", 1, 2, [gate("a"), gate("b"), gate("c")]);
    expect(two.message).toBe("hopgraph: gate a: approved 1 bytes, priced 2, and 1 more gate");
    expect(three.message).toBe("hopgraph: gate a: approved 1 bytes, priced 2, and 2 more gates");
    expect(three.gates).toHaveLength(3);
  });
});
