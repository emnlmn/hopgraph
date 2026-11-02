// Outcomes (DESIGN.md §3.4, §5.5): every base row gets an answer and every requested provider
// exactly one outcome; a provider is absent only where every branch ran to the end, uncut; the
// cache keeps what may be kept and nothing else; and the whole answer (rows, chains, reasons, cuts,
// coverage, row steps) is the one the oracle's plain walk computes from what the run read. Scenarios here have every kind of failure: unreadable
// sources, failed calls and statements, gates, a passed deadline, a stale cache.

import { describe, expect } from "vitest";
import { playAll, shower } from "./harness.ts";
import { CacheModel, expected, normalRow, readsOf } from "./oracle.ts";
import { property } from "./property.ts";
import { type Scenario, scenarios } from "./scenario.ts";

const everything = scenarios({ metered: true, callFailures: true, deadline: true });

/** The runs of a scenario that answered, each with what it read. */
async function answered(s: Scenario) {
  const player = await playAll(s);
  const cache = new CacheModel();
  const out = [];
  for (const played of player.played) {
    if (played.outcome.kind === "result")
      out.push({ played, result: played.outcome.result, reads: readsOf(s, played, cache) });
    cache.apply(s, played);
  }
  return out;
}

describe("outcomes", () => {
  property(
    "every base row and requested provider has exactly one outcome",
    everything,
    async (s) => {
      // a row step names a strategy by its loader: two strategies of one relation over one loader
      // are two steps under one name, and each may say something else
      const shared = new Set(
        s.relations.flatMap((r) =>
          r.strategies
            .filter((st, i) => r.strategies.findIndex((x) => x.loader === st.loader) !== i)
            .map((st) => `${r.id} / ${st.loader}`),
        ),
      );
      for (const { played, result } of await answered(s)) {
        const rows = played.request.rows.map((r) => r.row);
        expect([...result.rows.keys()].sort(), `${played.label}: the base rows`).toEqual(
          [...rows].sort(),
        );
        for (const [row, answer] of result.rows) {
          expect(
            Object.keys(answer.providers).sort(),
            `${played.label}: ${row}'s providers`,
          ).toEqual([...played.request.providers].sort());
          for (const [id, p] of Object.entries(answer.providers)) {
            expect(["found", "absent", "unknown"], `${played.label}: ${row} › ${id}`).toContain(
              p.outcome,
            );
            // found exactly when it has rows
            expect(p.rows.length > 0, `${played.label}: ${row} › ${id} is ${p.outcome}`).toBe(
              p.outcome === "found",
            );
          }
          // a step says one thing of each ref; a verification judges each candidate on its own
          const said = new Map<string, string>();
          for (const step of answer.steps) {
            if (step.step.startsWith("verify:") || shared.has(`${step.step} / ${step.loader}`))
              continue;
            const id = `${step.step} / ${step.loader} / ${step.ref}`;
            expect(said.get(id) ?? step.outcome, `${played.label}: ${row}: ${id}`).toBe(
              step.outcome,
            );
            said.set(id, step.outcome);
          }
        }
      }
    },
  );

  property("absent only where every branch ran to the end, uncut", everything, async (s) => {
    const show = shower(s);
    for (const { played, result, reads } of await answered(s)) {
      const want = expected(s, played.request, reads, show);
      for (const [row, answer] of result.rows)
        for (const [id, p] of Object.entries(answer.providers)) {
          if (p.outcome !== "absent") continue;
          expect(p.unknown, `${played.label}: ${row} › ${id} is absent with reasons`).toEqual([]);
          expect(p.cut, `${played.label}: ${row} › ${id} is absent and cut`).toEqual([]);
          expect(want.get(row)?.providers[id]?.outcome, `${played.label}: ${row} › ${id}`).toBe(
            "absent",
          );
        }
    }
  });

  property(
    "the cache keeps found and absent answers with their retention, never an unknown",
    everything,
    async (s) => {
      const cache = new CacheModel();
      for (const played of (await playAll(s)).played) {
        const kept = [...cache.writes(s, played).values()].map((w) => w.retention).sort();
        const written = played.events.flatMap((e) => (e.kind === "set" ? e.retentions : [])).sort();
        if (played.outcome.kind === "result")
          expect(written, `${played.label}: retentions written`).toEqual(kept);
        else {
          // a run that failed drops the answers that came after it failed: it writes a part
          const left = [...kept];
          for (const r of written) {
            const at = left.indexOf(r);
            expect(at, `${played.label}: wrote ${r} it did not read`).toBeGreaterThanOrEqual(0);
            left.splice(at, 1);
          }
        }
        cache.apply(s, played);
      }
    },
  );

  property("the answer is the one the rules give for what was read", everything, async (s) => {
    const show = shower(s);
    for (const { played, result, reads } of await answered(s)) {
      const want = expected(s, played.request, reads, show);
      for (const [row, answer] of result.rows)
        expect(normalRow(answer), `${played.label}: ${row}`).toEqual(want.get(row));
    }
  });
});
