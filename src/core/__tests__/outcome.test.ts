import { describe, expect, expectTypeOf, it } from "vitest";
import { absent, type Envelope, envelope, found, type LoadReason, unknown } from "../outcome.ts";

describe("envelope", () => {
  it("puts each key once, its cuts and coverage beside it, and never a coverage on an unknown", () => {
    const days = { label: "7 days", days: 7 };
    const env = envelope(
      [
        [
          "a",
          {
            kind: "found",
            value: 1,
            cuts: [
              { kind: "cap", limit: 5 },
              { kind: "days", days: 3 },
            ],
            coverage: days,
          },
        ],
        ["b", { kind: "absent", coverage: days }],
        ["c", { kind: "unknown", reason: { reason: "failed" } }],
        ["d", { kind: "absent" }],
      ],
      42,
      [{ code: "E", keys: 1 }],
    );
    expect(env).toEqual({
      values: [["a", 1]],
      absent: ["b", "d"],
      unknown: [["c", { reason: "failed" }]],
      cut: [
        ["a", { kind: "cap", limit: 5 }],
        ["a", { kind: "days", days: 3 }],
      ],
      coverage: [
        ["a", days],
        ["b", days],
      ],
      billedBytes: 42,
      errors: [{ code: "E", keys: 1 }],
    });
    expect(envelope([["x", { kind: "absent" }]])).not.toHaveProperty("coverage");
  });
});

describe("found, absent, unknown", () => {
  it("build the same answers as the literals, leaving out what is empty", () => {
    const week = { label: "7 days", days: 7 };
    expect(found(1)).toEqual({ kind: "found", value: 1 });
    expect(found(1, { cuts: [] })).toEqual({ kind: "found", value: 1 });
    expect(found(1, { cuts: [{ kind: "cap", limit: 5 }], coverage: week })).toEqual({
      kind: "found",
      value: 1,
      cuts: [{ kind: "cap", limit: 5 }],
      coverage: week,
    });
    expect(absent()).toEqual({ kind: "absent" });
    expect(absent(week)).toEqual({ kind: "absent", coverage: week });
    expect(unknown({ reason: "failed" })).toEqual({
      kind: "unknown",
      reason: { reason: "failed" },
    });
    expect(
      envelope([
        ["a", found("x", { coverage: week })],
        ["b", absent(week)],
        ["c", unknown({ reason: "unread", why: "disabled", connectors: ["db"] })],
      ]),
    ).toEqual({
      values: [["a", "x"]],
      absent: ["b"],
      unknown: [["c", { reason: "unread", why: "disabled", connectors: ["db"] }]],
      cut: [],
      coverage: [
        ["a", week],
        ["b", week],
      ],
      billedBytes: 0,
      errors: [],
    });
  });

  it("let envelope infer the value type, where literals widen it to undefined", () => {
    interface Row {
      readonly name: string;
    }
    const rows = new Map<string, Row>([["a", { name: "Mira Volk" }]]);
    const keys = ["a", "b"];

    const typed = envelope(
      keys.map((key) => {
        const row = rows.get(key);
        return [key, row ? found(row) : absent()];
      }),
    );
    expectTypeOf(typed).toEqualTypeOf<Envelope<string, Row>>();
    expect(typed.values).toEqual([["a", { name: "Mira Volk" }]]);

    const widened = envelope(
      keys.map((key) => {
        const row = rows.get(key);
        return [key, row ? { kind: "found", value: row } : { kind: "absent" }];
      }),
    );
    expectTypeOf(widened).toEqualTypeOf<Envelope<string, Row | undefined>>();
  });

  it("let a load give only the reasons a load knows: failed, or unread", () => {
    expectTypeOf(unknown).parameter(0).toEqualTypeOf<LoadReason>();
    // @ts-expect-error: awaiting an approval is the run's to say, never a load's
    expect(unknown({ reason: "awaiting_approval", bytes: 5 })).toBeDefined();
    const told: Envelope<string, number> = {
      values: [],
      absent: [],
      // @ts-expect-error: a deadline is the run's to say
      unknown: [["a", { reason: "deadline" }]],
      cut: [],
      billedBytes: 0,
      errors: [],
    };
    expect(told).toBeDefined();
  });
});
