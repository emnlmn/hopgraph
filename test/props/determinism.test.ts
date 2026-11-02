// Determinism (DESIGN.md §5.2): the same request over the same sources and the same cache gives
// the same result, whatever order slow calls finish in. Each scenario is played twice from an
// empty cache, its calls and cache lookups paced by two different seeds; every run of the first
// play must answer what the same run of the second answered: rows, steps, gates and their ids,
// prices, the bill, the whole trace (time aside), or the same error, a refused approval naming the
// same gates.

import { describe, expect } from "vitest";
import { playAll } from "./harness.ts";
import { normalOutcome } from "./oracle.ts";
import { property } from "./property.ts";
import { scenarios } from "./scenario.ts";

const timed = scenarios({ metered: true, callFailures: true });

describe("determinism", () => {
  property(
    "the same inputs and cache give the same result, whatever the timing",
    timed,
    async (s) => {
      const [a, b] = await Promise.all([playAll(s, s.timing[0]), playAll(s, s.timing[1])]);
      expect(b.played.map((p) => p.label)).toEqual(a.played.map((p) => p.label));
      a.played.forEach((first, i) => {
        expect(normalOutcome(b.played[i]), first.label).toEqual(normalOutcome(first));
      });
    },
  );
});
