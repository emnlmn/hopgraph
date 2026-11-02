import { describe, expect, it } from "vitest";
import { withinRefs } from "../caps.ts";
import type { RefNode } from "../refs.ts";

const ref = (keyId: string, id: string): RefNode => ({
  entity: "track",
  keyId,
  key: keyId,
  given: {},
  id,
});

describe("withinRefs", () => {
  it("orders by key id, then by the values a ref carries, and cuts those past the cap", () => {
    const refs = [ref("b", "b"), ref("a", "a|2"), ref("a", "a|1"), ref("c", "c")];
    const { read, past } = withinRefs(refs, 2);
    expect(read.map((r) => r.id)).toEqual(["a|1", "a|2"]);
    expect(past.map((p) => p.ref.id)).toEqual(["b", "c"]);
    expect(past.every((p) => p.cut.kind === "capped")).toBe(true);
  });

  it("reads everything, in the order given, when the cap is not met", () => {
    const refs = [ref("b", "b"), ref("a", "a")];
    expect(withinRefs(refs, undefined)).toEqual({ read: refs, past: [] });
    expect(withinRefs(refs, 2)).toEqual({ read: refs, past: [] });
  });
});
