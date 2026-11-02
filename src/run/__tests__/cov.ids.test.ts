import { describe, expect, it } from "vitest";
import { stableJson } from "../ids.ts";

describe("stableJson", () => {
  it("spells the same object the same whatever order its keys came in", () => {
    expect(stableJson({ b: 1, a: { d: 1n, c: 2 } })).toBe('{"a":{"c":2,"d":"1n"},"b":1}');
    expect(stableJson({ a: { c: 2, d: 1n }, b: 1 })).toBe(stableJson({ b: 1, a: { d: 1n, c: 2 } }));
  });
});
