// Scheduling (DESIGN.md §5.2): a loader's job starts as soon as nothing behind it in the plan can
// still add keys to it, where it used to wait at a barrier for every read of the wave before. Each
// scenario is played under both rules, with sources that answer at random paces: every run answers
// the same under both (rows, steps, gates, prices, the bill, the trace, or the same error), and in
// a run that answers no loader makes more jobs than under the barrier. A run that fails fails with
// the same error under both: the earliest wave's failure. It may have started jobs on other
// branches that the barrier, held at the failing wave, had not reached: those count for nothing.

import fc from "fast-check";
import { describe, expect } from "vitest";
import { type Played, playAll, type Resilience } from "./harness.ts";
import { normalOutcome } from "./oracle.ts";
import { property } from "./property.ts";
import { scenarios } from "./scenario.ts";

const graphs = scenarios({ metered: true, callFailures: true, fatal: true, overhead: true });

/** Per loader, how many jobs a run made. */
function jobs(p: Played): Map<string, number> {
  const out = new Map<string, number>();
  for (const e of p.events)
    if (e.kind === "batch") out.set(e.batch.loader, (out.get(e.batch.loader) ?? 0) + 1);
  return out;
}

/** Sources that throw a transient error on the first attempts of some loaders' calls, which every
 *  loader retries: a retry takes its time, so the jobs end in other orders still. */
function flaky(failures: readonly number[]): Resilience {
  return {
    flaky: (loader) => failures[Number(loader.slice(1)) % failures.length] ?? 0,
    retry: { attempts: 3, initialMs: 0, jitter: "none" },
  };
}

describe("scheduling", () => {
  property(
    "a job starts once nothing behind it can add keys, and the run reads what the barrier read, in no more jobs",
    fc.record({
      s: graphs,
      failures: fc.array(fc.nat(2), { minLength: 6, maxLength: 6 }),
      retried: fc.boolean(),
    }),
    async ({ s, failures, retried }) => {
      const resilience = retried ? flaky(failures) : undefined;
      const [planned, barrier] = await Promise.all([
        playAll(s, s.timing[0], resilience, "plan"),
        playAll(s, s.timing[1], resilience, "barrier"),
      ]);
      expect(planned.played.map((p) => p.label)).toEqual(barrier.played.map((p) => p.label));
      for (const [i, wall] of barrier.played.entries()) {
        const p = planned.played[i] as Played;
        expect(normalOutcome(p), wall.label).toEqual(normalOutcome(wall));
        // a run that failed keeps what its failing wave answered before it stopped, which timing
        // decides under either rule: the runs after it read another cache
        if (wall.outcome.kind !== "result") break;
        const walled = jobs(wall);
        for (const [loader, n] of jobs(p))
          expect(n, `${wall.label}: jobs of ${loader}`).toBeLessThanOrEqual(
            walled.get(loader) ?? 0,
          );
      }
    },
  );
});
