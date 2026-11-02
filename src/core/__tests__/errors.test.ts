// The errors' contract (core/errors.ts): one base class with a stable code, a subclass per kind,
// every message prefixed "hopgraph: ", and no value in a message. The builder refuses with a
// DefinitionError whose code says what it refused.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  AbortedError,
  CostChangedError,
  DefinitionError,
  entity,
  envelope,
  HopgraphError,
  hopgraph,
  type Retention,
  ValidationError,
} from "../index.ts";

describe("errors", () => {
  it("every error is a HopgraphError with its class name, a stable code and the same prefix", () => {
    const errors = [
      [new DefinitionError("HG_DUPLICATE", "x"), "DefinitionError", "HG_DUPLICATE"],
      [
        new ValidationError([{ row: "r1", entity: "track", field: "key" }]),
        "ValidationError",
        "HG_INVALID",
      ],
      [new CostChangedError("g", 1, 2), "CostChangedError", "HG_COST_CHANGED"],
      [new AbortedError("deadline"), "AbortedError", "HG_ABORTED"],
      [new HopgraphError("HG_INTERNAL", "x"), "HopgraphError", "HG_INTERNAL"],
    ] as const;
    for (const [error, name, code] of errors) {
      expect(error).toBeInstanceOf(HopgraphError);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(error.code).toBe(code);
      expect(error.message).toMatch(/^hopgraph: /);
    }
  });

  it("a validation error names rows and fields, at most five in its message, never a value", () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({
      row: `r${i}`,
      entity: "track",
      field: i === 0 ? "key" : "carries.releasedAt",
    }));
    const error = new ValidationError(rows);
    expect(error.rows).toEqual(rows);
    expect(error.message).toBe(
      'hopgraph: 7 base rows do not match their entity\'s schemas: "r0" (track key), ' +
        '"r1" (track carries.releasedAt), "r2" (track carries.releasedAt), ' +
        '"r3" (track carries.releasedAt), "r4" (track carries.releasedAt), and 2 more',
    );
  });

  it("an abort the run makes on its own says why, and keeps what failed the run as its cause", () => {
    const cause = new CostChangedError("g", 1, 2);
    expect(new AbortedError("deadline")).toMatchObject({
      why: "deadline",
      message: "hopgraph: the run passed its deadline",
    });
    expect(new AbortedError("failed", { cause })).toMatchObject({ why: "failed", cause });
  });
});

describe("the builder's refusals", () => {
  const track = entity({ key: z.string() });
  const base = {
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    batch: { by: "keys", max: 10 },
    keep: (): Retention => "day",
    partial: "keep",
    load: async () => envelope<string, never>([]),
  } as const;

  const refusal = (declare: () => unknown) => {
    try {
      declare();
    } catch (error) {
      return error;
    }
    throw new Error("expected a refusal");
  };

  it("throws a DefinitionError whose code names the problem", () => {
    const g = hopgraph<object, unknown>().entities({ track });
    const tracks = g.loader({ ...base, id: "tracks" });
    const other = hopgraph<object, unknown>()
      .entities({ track })
      .loader({ ...base, id: "x" });

    const metered = { ...base, id: "paid", cost: { metered: { auto: 1, approve: 2 } } };

    const cases = [
      [() => g.loader({ ...base, id: "tracks" }), "HG_DUPLICATE"],
      // @ts-expect-error: a metered loader needs a price (also refused at run time)
      [() => g.loader(metered), "HG_SPEC"],
      // @ts-expect-error: "statement" is not an entity
      [() => g.hydrator("statement", tracks, () => ({})), "HG_UNKNOWN_ENTITY"],
      [() => g.hydrator("track", other, () => ({})), "HG_FOREIGN"],
      // @ts-expect-error: a union of no path
      [() => g.union(), "HG_SPEC"],
    ] as const;
    for (const [declare, code] of cases) {
      const error = refusal(declare);
      expect(error).toBeInstanceOf(DefinitionError);
      expect(error).toMatchObject({ code, message: expect.stringMatching(/^hopgraph: /) });
    }
  });
});
