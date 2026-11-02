// Deadline (DESIGN.md §5.3, §3.4): a deadline that passes in the middle of a run stops what has
// not started, and what it stopped is unknown, never absent. Each scenario is played twice from an
// empty cache, without a deadline and with one that passes after a few calls (the run's clock
// counts calls): no call starts once the clock is past it; a provider absent with the deadline is
// absent without it; and an outcome the deadline changed is unknown, and says why. Sources here fail
// key by key only, so what a call holds does not change answers.

import { describe, expect } from "vitest";
import { player } from "./harness.ts";
import { property } from "./property.ts";
import { scenarios } from "./scenario.ts";

describe("deadline", () => {
  property(
    "a deadline never makes anything absent, and nothing starts after it",
    scenarios(),
    async (s) => {
      const after = s.timing[1] % 6;
      const free = await player(s, s.timing[0]).play("no deadline", s.request);
      const late = await player(s, s.timing[0]).play(`deadline after ${after} calls`, s.request, {
        deadlineAfter: after,
      });
      const calls = late.events.filter((e) => e.kind === "load").length;
      // a call starts while the clock, which counts the calls started, is not past the deadline
      expect(calls, `${late.label}: calls`).toBeLessThanOrEqual(after + 1);
      if (free.outcome.kind !== "result" || late.outcome.kind !== "result")
        throw new Error("a run without fatal errors or approvals failed");
      for (const [row, answer] of late.outcome.result.rows)
        for (const [id, p] of Object.entries(answer.providers)) {
          const unbounded = free.outcome.result.rows.get(row)?.providers[id];
          const at = `${late.label}: ${row} › ${id}`;
          if (p.outcome === "absent") expect(unbounded?.outcome, at).toBe("absent");
          // an outcome the deadline changed says so (a candidate it left unverified is ambiguous)
          if (p.outcome !== unbounded?.outcome) {
            expect(p.outcome, at).toBe("unknown");
            expect(
              p.unknown.map((u) => u.reason),
              at,
            ).toSatisfy((reasons: string[]) =>
              reasons.some((r) => r === "deadline" || r === "ambiguous"),
            );
          }
        }
    },
  );
});
