// How every property runs: fast-check over a scenario arbitrary, from the suite's seed (setup.ts),
// with a number of scenarios HOPGRAPH_SCALE multiplies. Each property derives its own seed from
// the suite's and its name, so two properties do not try the same scenarios; a failure prints the
// property's seed, the path to the shrunk case and the case itself, described for a person.

import fc from "fast-check";
import { inject, it } from "vitest";

const SCALE = Number(process.env.HOPGRAPH_SCALE ?? 1);

function seedOf(suite: number, name: string): number {
  let h = suite >>> 0;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 0x01000193) >>> 0;
  return h | 0;
}

/** A property over generated values: `check` throws to refute it. */
export function property<T>(
  name: string,
  values: fc.Arbitrary<T>,
  check: (value: T) => Promise<void>,
  runs = 300,
): void {
  it(name, async () => {
    const suite = inject("seed");
    const numRuns = Math.max(1, Math.round(runs * SCALE));
    await fc.assert(fc.asyncProperty(values, check), {
      seed: seedOf(suite, name),
      numRuns,
      // fast-check's report, the suite's seed above it and the refuting assertion as its cause
      reporter: (details) => {
        if (!details.failed) return;
        const report = `HOPGRAPH_SEED=${suite}\n${fc.defaultReportMessage(details)}`;
        throw new Error(report, { cause: details.errorInstance });
      },
    });
  }, 120_000);
}
