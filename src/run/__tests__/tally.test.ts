import { describe, expect, it } from "vitest";
import {
  absentTally,
  fallback,
  fallsThrough,
  foundTally,
  noting,
  outcomeOf,
  type Tally,
  union,
  unknownTally,
} from "../tally.ts";

const SIX_MONTHS = { label: "6 months", days: 183 };
const SINCE_2020 = { label: "since 2020", from: "2020-01-01" };
const CAP = { kind: "cap", limit: 50 } as const;
const FAILED = { reason: "failed" } as const;
const WAITING = { reason: "awaiting_approval", bytes: 5e9 } as const;

describe("tally", () => {
  it("found wins; absent needs every branch uncut; anything else is unknown", () => {
    expect(outcomeOf(foundTally())).toBe("found");
    expect(outcomeOf(absentTally(SIX_MONTHS))).toBe("absent");
    expect(outcomeOf(unknownTally(FAILED))).toBe("unknown");
    // an empty answer under a cut: rows past the cap may exist
    expect(outcomeOf(absentTally(SIX_MONTHS, [CAP]))).toBe("unknown");
  });

  it("union: found if any, and what the other branches could not read stays listed", () => {
    const t = union([foundTally(), unknownTally(FAILED), absentTally(SIX_MONTHS)]);
    expect(t).toEqual({ found: true, unknown: [FAILED], cut: [], coverage: [SIX_MONTHS] });
    expect(outcomeOf(union([absentTally(SIX_MONTHS), absentTally(SINCE_2020)]))).toBe("absent");
    expect(outcomeOf(union([absentTally(SIX_MONTHS), unknownTally(FAILED)]))).toBe("unknown");
  });

  it("union lists each reason, cut and coverage once, whatever order their keys were built in", () => {
    const a: Tally = { ...unknownTally({ reason: "too_heavy", bytes: 1 }), coverage: [SIX_MONTHS] };
    const b: Tally = { ...unknownTally({ bytes: 1, reason: "too_heavy" }), coverage: [SIX_MONTHS] };
    expect(union([a, b])).toEqual(a);
  });

  it("fallback: the branch that found is the answer, beside the reasons of the branches before it that could not be read; when none found, every branch counts", () => {
    expect(fallback([unknownTally(FAILED), foundTally([CAP])])).toEqual({
      ...foundTally([CAP]),
      unknown: [FAILED],
    });
    // a branch before it that read and found nothing adds nothing to the answer
    expect(fallback([absentTally(SIX_MONTHS), foundTally()])).toEqual(foundTally());
    // one that read under a cut and found nothing was not read whole: its cut stays beside it
    expect(fallback([absentTally(SIX_MONTHS, [CAP]), foundTally()])).toEqual(foundTally([CAP]));
    expect(fallback([absentTally(SIX_MONTHS), absentTally(SINCE_2020)]).coverage).toEqual([
      SIX_MONTHS,
      SINCE_2020,
    ]);
    expect(outcomeOf(fallback([unknownTally(FAILED), absentTally(SINCE_2020)]))).toBe("unknown");
  });

  it("the next fallback branch runs after an absence or a failure, not after a find or a gate", () => {
    expect(fallsThrough(absentTally())).toBe(true);
    expect(fallsThrough(unknownTally(FAILED))).toBe(true);
    expect(fallsThrough(foundTally())).toBe(false);
    expect(fallsThrough(unknownTally(WAITING))).toBe(false);
  });

  it("noting adds a reason once", () => {
    const ambiguous = { reason: "ambiguous" } as const;
    expect(noting(noting(foundTally(), ambiguous), ambiguous).unknown).toEqual([ambiguous]);
  });
});
