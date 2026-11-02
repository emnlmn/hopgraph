// One job per loader per wave (DESIGN.md §2 goal 4, §5.2): in a wave, every read of one loader,
// whatever step asked, is one cache lookup, at most one dry run, and the loader's batches over the
// keys the cache did not have, each key in one call; a key loaded in a run is never loaded again
// in it; and a loader's jobs do not overlap, each in a later wave than the one before.

import { describe, expect } from "vitest";
import { partsOf, playAll } from "./harness.ts";
import { loaderOf, loads } from "./oracle.ts";
import { property } from "./property.ts";
import { scenarios } from "./scenario.ts";

const jobs = scenarios({ metered: true, callFailures: true });

describe("jobs", () => {
  property("one job per loader per wave", jobs, async (s) => {
    for (const played of (await playAll(s)).played) {
      const at = played.label;
      const batches = played.events.flatMap((e) => (e.kind === "batch" ? [e.batch] : []));
      if (played.outcome.kind === "result") {
        // one cache lookup per loader per wave, none for a job that started after the deadline
        const lookups = played.events.filter((e) => e.kind === "get").length;
        expect(lookups, `${at}: cache lookups of the jobs`).toBe(
          batches.reduce((sum, b) => sum + b.lookups, 0),
        );
        for (const b of batches)
          expect(b.lookups, `${at}: lookups of ${b.loader} in wave ${b.wave}`).toBeLessThanOrEqual(
            1,
          );
      }
      // a loader's jobs follow one another, in wave order
      for (const loader of new Set(batches.map((b) => b.loader))) {
        const waves = batches.filter((b) => b.loader === loader).map((b) => b.wave);
        for (const [i, wave] of waves.entries())
          if (i > 0)
            expect(wave, `${at}: ${loader}'s waves ${waves}`).toBeGreaterThan(waves[i - 1] ?? 0);
      }

      for (const part of partsOf(played)) {
        if (!part.batch) continue;
        const spec = loaderOf(s, part.loader);
        const wave = `${at}: wave ${part.batch.wave} of ${spec.id}`;
        expect(part.prices.length, `${wave}: dry runs`).toBeLessThanOrEqual(1);
        const keys = part.loads.flatMap((c) => c.keys);
        expect(new Set(keys).size, `${wave}: a key in two calls`).toBe(keys.length);
        if (keys.length === 0) continue;
        const missed = part.batch.keys - part.batch.hits;
        expect(keys.length, `${wave}: loaded besides what the cache missed`).toBeLessThanOrEqual(
          missed,
        );
        const b = spec.batch;
        // a run that failed starts none of the calls left; one that answered made them all
        if (played.outcome.kind === "result") {
          const calls =
            b.by === "partition"
              ? 1
              : b.by === "one"
                ? keys.length
                : Math.ceil(keys.length / b.max);
          expect(keys.length, `${wave}: loaded fewer than the cache missed`).toBe(missed);
          expect(part.loads.length, `${wave}: calls for ${keys.length} keys by ${b.by}`).toBe(
            calls,
          );
        }
        for (const call of part.loads)
          expect(call.keys.length, `${wave}: a call's size`).toBeLessThanOrEqual(
            b.by === "keys" ? b.max : b.by === "one" ? 1 : keys.length,
          );
      }

      // a key loaded once per run, whatever step asked for it and when
      const seen = new Set<string>();
      for (const call of loads(played))
        for (const key of call.keys) {
          const id = `${call.loader} ${key}`;
          expect(seen.has(id), `${at}: ${id} loaded twice`).toBe(false);
          seen.add(id);
        }
    }
  });
});
