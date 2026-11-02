// Cost (DESIGN.md §5.3, §5.4): a metered loader is priced before it loads, and loads only under
// its auto cap or with an approval no smaller than the price; its calls in one wave are each told
// what the ones before them left of the wave's budget, so together they bill within it; a gate the
// run stops at is a wave that was priced and not loaded; and a run that fails (a refused approval,
// an error declared fatal) calls no source afterwards. Free loaders get no budget; a source the
// viewer may not read is never touched.

import { CostChangedError } from "hopgraph";
import { describe, expect } from "vitest";
import { billed, charged, Fatal, partsOf, playAll } from "./harness.ts";
import { gateLoader, loaderOf, loads, refusingDryRun, unreadOf } from "./oracle.ts";
import { property } from "./property.ts";
import { scenarios } from "./scenario.ts";

const metered = scenarios({ metered: true, callFailures: true, fatal: true, overhead: true });

describe("billing", () => {
  property(
    "no metered loader bills past its approval, and none runs at a gate",
    metered,
    async (s) => {
      for (const played of (await playAll(s)).played) {
        const approvals = Object.values(played.approved);
        const at = played.label;
        for (const part of partsOf(played)) {
          const spec = loaderOf(s, part.loader);
          expect(
            unreadOf(s, spec),
            `${at}: ${spec.id} is not readable and was read`,
          ).toBeUndefined();
          const caps = spec.metered;
          if (!caps) {
            expect(part.prices, `${at}: free ${spec.id} was priced`).toEqual([]);
            for (const call of part.loads)
              expect(call.budget.maxBytes, `${at}: free ${spec.id} got a budget`).toBeUndefined();
            continue;
          }
          if (part.loads.length === 0) continue;
          // priced once, before any call, on the keys it then loaded
          expect(
            part.prices.length,
            `${at}: ${spec.id} loaded after ${part.prices.length} dry runs`,
          ).toBe(1);
          const dry = part.prices[0];
          const price = dry?.bytes;
          if (typeof price !== "number")
            throw new Error(`${at}: ${spec.id} loaded after a failed dry run`);
          expect(played.events.indexOf(dry as never)).toBeLessThan(
            played.events.indexOf(part.loads[0] as never),
          );
          // one admission per wave: its first call is told the whole budget, under the auto cap or
          // approved
          const budget = part.loads[0]?.budget.maxBytes;
          if (budget === undefined) throw new Error(`${at}: metered ${spec.id} got no budget`);
          // under the auto cap, its price; approved, the approval; a part of an approval of more
          // keys runs on its own price (DESIGN.md §5.4)
          const allowed = [
            ...(price <= caps.auto ? [price] : []),
            ...approvals
              .filter((a) => a >= price)
              .flatMap((a) => [Math.min(a, caps.approve), price]),
          ];
          expect(price, `${at}: ${spec.id} ran priced above its approve cap`).toBeLessThanOrEqual(
            caps.approve,
          );
          expect(allowed, `${at}: ${spec.id} ran priced ${price} with budget ${budget}`).toContain(
            budget,
          );
          // each call after it is told what the calls before it left, and none starts once they
          // spent it all
          let spent = 0;
          for (const [i, call] of part.loads.entries()) {
            expect(spent > 0 && spent >= budget, `${at}: ${spec.id} called on a spent budget`).toBe(
              false,
            );
            expect(call.budget.maxBytes, `${at}: ${spec.id}'s call ${i + 1} was told`).toBe(
              Math.max(0, budget - spent),
            );
            spent += charged(call);
          }
          const total = part.loads.reduce((sum, c) => sum + billed(c), 0);
          expect(
            total,
            `${at}: ${spec.id}'s calls billed ${total} in one wave, on a budget of ${budget}`,
          ).toBeLessThanOrEqual(budget);
          // every key priced is loaded, unless the run failed meanwhile or the calls before spent
          // the budget
          const loaded = part.loads.flatMap((c) => c.keys).sort();
          const priced = [...(dry?.keys ?? [])].sort();
          for (const key of loaded)
            expect(priced, `${at}: ${spec.id} loaded ${key} unpriced`).toContain(key);
          if (played.outcome.kind === "result" && !(spent > 0 && spent >= budget))
            expect(loaded, `${at}: ${spec.id} loaded other keys than it priced`).toEqual(priced);
        }
      }
    },
  );

  property("a gate is a wave priced up to its approve cap and not loaded", metered, async (s) => {
    for (const played of (await playAll(s)).played) {
      if (played.outcome.kind !== "result") continue;
      const result = played.outcome.result;
      const stopped = partsOf(played).flatMap((part) => {
        const caps = loaderOf(s, part.loader).metered;
        const price = part.prices[0]?.bytes;
        if (!caps || part.loads.length > 0 || typeof price !== "number" || !Number.isFinite(price))
          return [];
        if (price <= caps.auto || price > caps.approve) return [];
        return [{ loader: part.loader, bytes: price, keys: part.prices[0]?.keys.length ?? 0 }];
      });
      const gates = result.gates.map((g) => ({ loader: g.loader, bytes: g.bytes, keys: g.keys }));
      const order = (xs: typeof gates) =>
        [...xs].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
      expect(order(gates), played.label).toEqual(order(stopped));
      expect(result.status, played.label).toBe(gates.length > 0 ? "gated" : "complete");
      const calls = loads(played).reduce((sum, c) => sum + billed(c), 0);
      expect(result.billedBytes, `${played.label}: the result's bill`).toBe(calls);
      expect(
        result.trace.reduce((sum, t) => sum + t.billedBytes, 0),
        `${played.label}: the trace's bill`,
      ).toBe(calls);
    }
  });

  property("a run that fails starts nothing afterwards", metered, async (s) => {
    for (const played of (await playAll(s)).played) {
      if (played.outcome.kind !== "error") continue;
      const { error, settled } = played.outcome;
      // no call and no dry run (test/regressions/price-after-failure.test.ts)
      const late = played.events
        .slice(settled)
        .filter((e) => e.kind === "load" || e.kind === "price");
      expect(late, `${played.label}: called after the run failed`).toEqual([]);
      if (error instanceof Fatal) {
        expect(loads(played).some((c) => c.end?.kind === "fatal")).toBe(true);
        continue;
      }
      // the only other way to fail: a resume whose price grew past its approval, which bills
      // nothing of that gate
      expect(error, `${played.label}: failed with ${String(error)}`).toBeInstanceOf(
        CostChangedError,
      );
      // every refused gate: approved short of its price, and no call of its loader from its dry
      // run on (its job, and that loader's later ones, of later waves)
      const refused = error as CostChangedError;
      expect(refused.gates[0]).toEqual({
        gate: refused.gate,
        approved: refused.approved,
        priced: refused.priced,
      });
      for (const gate of refused.gates) {
        expect(played.approved[gate.gate]).toBe(gate.approved);
        expect(gate.priced).toBeGreaterThan(gate.approved);
        const loader = gateLoader(gate.gate);
        const dry = refusingDryRun(played.events, gate);
        expect(
          dry,
          `${played.label}: no dry run of ${loader} priced ${gate.priced}`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          played.events.slice(dry).filter((e) => e.kind === "load" && e.loader === loader),
          `${played.label}: ${loader} called after its gate was refused`,
        ).toEqual([]);
      }
    }
  });
});
