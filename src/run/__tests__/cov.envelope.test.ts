import { describe, expect, it } from "vitest";
import type { LoadReason } from "../../core/index.ts";
import { answersOf, audit } from "../envelope.ts";

const idOf = (key: unknown) => String(key);
const base = { values: [], absent: [], unknown: [], cut: [], billedBytes: 0, errors: [] };

describe("audit", () => {
  it("a key reported both found and unknown is conflicted; one nobody asked for and one unmentioned are counted", () => {
    const { conflicted, errors } = audit(["a", "b", "c"], idOf, {
      ...base,
      values: [["a", 1]],
      unknown: [
        ["a", { reason: "failed" }],
        ["z", { reason: "failed" }],
      ],
      absent: ["b"],
    });
    expect([...conflicted]).toEqual(["a"]);
    expect(errors).toEqual([
      { code: "HG_ENVELOPE_UNASKED", keys: 1 },
      { code: "HG_ENVELOPE_CONFLICT", keys: 1 },
      { code: "HG_ENVELOPE_MISSING", keys: 1 },
    ]);
  });

  it("a key named only by a cut or by coverage counts as unasked when nobody asked for it", () => {
    const { errors } = audit(["a"], idOf, {
      ...base,
      values: [["a", 1]],
      cut: [["y", { kind: "cap", limit: 1 }]],
      coverage: [["x", { label: "7 days", days: 7 }]],
    });
    expect(errors).toEqual([{ code: "HG_ENVELOPE_UNASKED", keys: 2 }]);
  });

  it("a clean envelope has no findings", () => {
    const { conflicted, errors } = audit(["a"], idOf, {
      ...base,
      unknown: [["a", { reason: "failed" }]],
    });
    expect(conflicted.size).toBe(0);
    expect(errors).toEqual([]);
  });
});

describe("answersOf: reasons a load gave", () => {
  const asked = ["a"];
  const reasonFor = (given: unknown) =>
    answersOf(asked, idOf, { ...base, unknown: [["a", given as LoadReason]] }, "keep").get("a");
  const failed = { kind: "unknown", reason: { reason: "failed" } };

  it("an unread reason with a known why and named connectors is kept as it came", () => {
    for (const why of ["disabled", "forbidden", "not_configured"])
      expect(reasonFor({ reason: "unread", why, connectors: ["db"] })).toEqual({
        kind: "unknown",
        reason: { reason: "unread", why, connectors: ["db"] },
      });
  });

  it("a reason from plain JavaScript that the types do not allow is failed, never trusted", () => {
    expect(reasonFor(null)).toEqual(failed);
    expect(reasonFor({ reason: "unread", why: "awaiting_approval", connectors: ["db"] })).toEqual(
      failed,
    );
    expect(reasonFor({ reason: "unread", why: "disabled", connectors: "db" })).toEqual(failed);
    expect(reasonFor({ reason: "unread", why: "disabled", connectors: [1] })).toEqual(failed);
    expect(reasonFor({ reason: "deadline", why: "disabled", connectors: [] })).toEqual(failed);
  });
});
