import { describe, expect, it } from "vitest";
import type { Envelope, Kept, Retention } from "../../core/index.ts";
import { answersOf, fromCache, keepable } from "../envelope.ts";

const SEARCHED = { label: "180 days", days: 180 };
const CAP = { kind: "cap", limit: 50 } as const;
const DAYS = { kind: "days", days: 7 } as const;
const idOf = (key: unknown) => String(key);

function envelope(over: Partial<Envelope<string, number>>): Envelope<string, number> {
  return { values: [], absent: [], unknown: [], cut: [], billedBytes: 0, errors: [], ...over };
}

describe("answersOf", () => {
  it("found keys carry every cut and their coverage; absent keys their coverage", () => {
    const answers = answersOf(
      ["a", "b", "c"],
      idOf,
      envelope({
        values: [["a", 1]],
        absent: ["b"],
        unknown: [["c", { reason: "failed" }]],
        cut: [
          ["a", CAP],
          ["a", DAYS],
        ],
        coverage: [
          ["a", SEARCHED],
          ["b", SEARCHED],
        ],
      }),
      "keep",
    );
    expect(Object.fromEntries(answers)).toEqual({
      a: { kind: "found", value: 1, cuts: [CAP, DAYS], coverage: SEARCHED },
      b: { kind: "absent", coverage: SEARCHED },
      c: { kind: "unknown", reason: { reason: "failed" } },
    });
  });

  it("a key the envelope does not mention failed; a key nobody asked for is ignored", () => {
    const answers = answersOf(
      ["a", "b"],
      idOf,
      envelope({ values: [["z", 9]], absent: ["a"] }),
      "keep",
    );
    expect(Object.fromEntries(answers)).toEqual({
      a: { kind: "absent" },
      b: { kind: "unknown", reason: { reason: "failed" } },
    });
  });

  it("under drop, one failed statement fails every key of the call; a call that threw too", () => {
    const failedOne = envelope({
      values: [["a", 1]],
      unknown: [["b", { reason: "failed" }]],
      errors: [{ code: "E", keys: 1 }],
    });
    const failed = { kind: "unknown", reason: { reason: "failed" } };
    expect(Object.fromEntries(answersOf(["a", "b"], idOf, failedOne, "drop"))).toEqual({
      a: failed,
      b: failed,
    });
    expect(answersOf(["a", "b"], idOf, failedOne, "keep").get("a")?.kind).toBe("found");
    expect(Object.fromEntries(answersOf(["a"], idOf, undefined, "keep"))).toEqual({ a: failed });
  });
});

describe("keepable and fromCache", () => {
  const dayIfFound = (k: Kept): Retention => (k.found ? "day" : "brief");

  it("keeps found and absent with their retention, cuts and coverage, and reads them back", () => {
    const answer = { kind: "found", value: 1, cuts: [CAP, DAYS], coverage: SEARCHED } as const;
    const kept = keepable(answer, dayIfFound);
    expect(kept).toEqual({
      answer: { kind: "found", value: 1, cuts: [CAP, DAYS], coverage: SEARCHED },
      retention: "day",
    });
    expect(kept && fromCache(kept.answer)).toEqual(answer);
    expect(keepable({ kind: "absent" }, dayIfFound)).toEqual({
      answer: { kind: "absent" },
      retention: "brief",
    });
  });

  it("never keeps an unknown, nor what `keep` says to drop; `keep` sees the first cut", () => {
    const seen: Kept[] = [];
    const none = (k: Kept): Retention => {
      seen.push(k);
      return "none";
    };
    expect(keepable({ kind: "unknown", reason: { reason: "failed" } }, dayIfFound)).toBeUndefined();
    expect(keepable({ kind: "found", value: 1, cuts: [CAP, DAYS] }, none)).toBeUndefined();
    expect(seen).toEqual([{ found: true, absent: false, cut: CAP }]);
  });
});
