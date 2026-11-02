// Failure injection (DESIGN.md §3.4, §5.3, §5.7): the scenarios are played against sources that
// fail now and then, each call throwing a transient error on its first attempts, with every loader
// retrying as a random policy allows. The per-key promises hold all the same: every key ends in one
// outcome, the one the rules give for what was read; an absence is never invented; nothing is billed
// past an approval, retries included; every retry is in the trace; retries enough for every
// transient failure give the answer of sources that never failed; and a breaker that opens leaves
// keys unknown, never wrong. Failures may make a key known that was not: a cost gate decides per
// wave, so a key too heavy beside another is read once a failure kept the other out of its wave.

import fc from "fast-check";
import { createHealth, type RunResult } from "hopgraph";
import { describe, expect } from "vitest";
import { charged, type Played, partsOf, playAll, type Resilience, shower } from "./harness.ts";
import { CacheModel, expected, loaderOf, normalRow, readsOf } from "./oracle.ts";
import { property } from "./property.ts";
import { CONNECTORS, type Scenario, scenarios } from "./scenario.ts";

const graphs = scenarios({ metered: true, callFailures: true, overhead: true });

/** A scenario, how many attempts of each loader's calls fail (by loader index), and the policy. */
const flaky = fc.record({
  s: graphs,
  failures: fc.array(fc.nat(2), { minLength: 6, maxLength: 6 }),
  attempts: fc.integer({ min: 1, max: 3 }),
});

function resilience(failures: readonly number[], attempts: number): Resilience {
  return {
    flaky: (loader) => failures[Number(loader.slice(1)) % failures.length] ?? 0,
    retry: { attempts, initialMs: 0, jitter: "none" },
  };
}

/** Every metered wave tells each attempt what the ones before it left, and bills within it. */
function billsWithin(s: Scenario, played: Played): void {
  for (const part of partsOf(played)) {
    if (!loaderOf(s, part.loader).metered || part.loads.length === 0) continue;
    const budget = part.loads[0]?.budget.maxBytes ?? Number.NaN;
    let spent = 0;
    for (const call of part.loads) {
      expect(call.budget.maxBytes, `${played.label}: ${part.loader} was told`).toBe(
        Math.max(0, budget - spent),
      );
      spent += charged(call);
    }
    const bills = part.loads.reduce(
      (sum, c) => sum + (c.end?.kind === "done" ? c.end.envelope.billedBytes : 0),
      0,
    );
    expect(bills, `${played.label}: ${part.loader} billed past ${budget}`).toBeLessThanOrEqual(
      budget,
    );
  }
}

/** What a run answered, comparable with the same run over other sources. */
function answerOf(p: Played) {
  if (p.outcome.kind !== "result") return (p.outcome.error as Error).name;
  const r: RunResult = p.outcome.result;
  return {
    status: r.status,
    gates: r.gates.map((g) => `${g.id} ${g.keys} ${g.bytes}`).sort(),
    rows: [...r.rows].sort(([a], [b]) => (a < b ? -1 : 1)).map(([row, x]) => [row, normalRow(x)]),
    billedBytes: r.billedBytes,
    prices: [...r.prices].sort(([a], [b]) => (a < b ? -1 : 1)),
  };
}

describe("failures", () => {
  property(
    "against flaky sources, every key's answer is the rules' for what was read, and nothing is billed past an approval",
    flaky,
    async ({ s, failures, attempts }) => {
      const show = shower(s);
      const cache = new CacheModel();
      for (const played of (await playAll(s, s.timing[0], resilience(failures, attempts))).played) {
        const calls = played.events.filter((e) => e.kind === "load" || e.kind === "price");
        for (const call of calls)
          expect(
            call.attempt,
            `${played.label}: ${call.loader} tried too often`,
          ).toBeLessThanOrEqual(attempts);
        billsWithin(s, played);
        if (played.outcome.kind === "result") {
          const result = played.outcome.result;
          const want = expected(s, played.request, readsOf(s, played, cache), show);
          for (const [row, answer] of result.rows)
            expect(normalRow(answer), `${played.label}: ${row}`).toEqual(want.get(row));
          const retried = calls.filter((c) => c.attempt > 1).length;
          const traced = result.trace.reduce((sum, t) => sum + t.retries, 0);
          expect(traced, `${played.label}: the retries in the trace`).toBe(retried);
        }
        cache.apply(s, played);
      }
    },
  );

  property(
    "with retries enough for every transient failure, the answer is the one of sources that never failed",
    fc.record({ s: graphs, failures: fc.array(fc.nat(2), { minLength: 6, maxLength: 6 }) }),
    async ({ s, failures }) => {
      const [healthy, retried] = await Promise.all([
        playAll(s, s.timing[0]),
        playAll(s, s.timing[0], resilience(failures, 3)),
      ]);
      expect(retried.played.map((p) => p.label)).toEqual(healthy.played.map((p) => p.label));
      healthy.played.forEach((p, i) => {
        expect(answerOf(retried.played[i] as Played), p.label).toEqual(answerOf(p));
      });
    },
  );

  property(
    "a breaker that opens leaves keys unknown, never absent where they were found, and bills nothing past an approval",
    flaky,
    async ({ s, failures, attempts }) => {
      const breaker = { failures: 2, windowMs: 60_000, coolDownMs: 60_000 };
      const health = createHealth(
        Object.fromEntries(
          CONNECTORS.map((c) => [c, { breaker, rate: { perSecond: 5_000, burst: 3 } }]),
        ),
      );
      const [healthy, sick] = await Promise.all([
        playAll(s, s.timing[0]),
        playAll(s, s.timing[0], { ...resilience(failures, attempts), health }),
      ]);
      for (const played of sick.played) {
        billsWithin(s, played);
        const twin = healthy.played.find((p) => p.label === played.label);
        if (played.outcome.kind !== "result" || twin?.outcome.kind !== "result") continue;
        const well = twin.outcome.result;
        for (const [row, answer] of played.outcome.result.rows)
          for (const [id, p] of Object.entries(answer.providers)) {
            const at = `${played.label}: ${row} › ${id}`;
            const was = well.rows.get(row)?.providers[id];
            expect(p.rows.length > 0, `${at} is ${p.outcome}`).toBe(p.outcome === "found");
            if (p.outcome === "absent") {
              expect(was?.outcome, `${at} is absent, and was found`).not.toBe("found");
              expect([...p.unknown, ...p.cut], `${at} is absent with reasons`).toEqual([]);
            }
            // found where it was absent: only with a reason beside it that says a branch was not
            // read as it was then: `ambiguous`, a link a failed verification left undecided, or
            // `failed`, a branch that failed here and not in the healthy run: a fallback strategy
            // the next one went past (DESIGN.md §3.3; test/regressions/fallback-open-circuit.test.ts),
            // or a branch of a union whose failure changed what a verification kept
            if (p.outcome === "found" && was?.outcome === "absent")
              expect(
                p.unknown.some((r) => r.reason === "ambiguous" || r.reason === "failed"),
                `${at} is found, and was absent, with ${JSON.stringify(p.unknown)}`,
              ).toBe(true);
            for (const reason of p.unknown)
              if (reason.reason === "failed" && reason.why === "open")
                for (const c of reason.connectors ?? [])
                  expect(CONNECTORS as readonly string[], `${at}: open ${c}`).toContain(c);
          }
      }
    },
  );
});
