// The run's trace (DESIGN.md §6): per step and loader, the keys that came in, how many the cache or
// another step answered, what was found, absent, unknown and why, what was cut, the bytes billed,
// the time spent and the loads' failures. Counts and codes only: per-ref detail lives in the row
// results, and no key appears here.

import type { LoadError, UnknownReason } from "../core/index.ts";
import type { Said } from "./ledger.ts";
import type { TraceStep } from "./types.ts";

export interface StepStats {
  readonly keysIn: number;
  readonly cached: number;
  readonly billedBytes: number;
  readonly ms: number;
  readonly retries: number;
  readonly errors: readonly LoadError[];
}

interface Entry {
  readonly step: string;
  readonly loader: string;
  keysIn: number;
  cached: number;
  found: number;
  absent: number;
  readonly unknown: Partial<Record<UnknownReason["reason"], number>>;
  cut: number;
  billedBytes: number;
  ms: number;
  retries: number;
  /** per failure (class and code), the failure and how many keys it took */
  readonly errors: Map<string, LoadError>;
}

export class TraceBook {
  private readonly entries = new Map<string, Entry>();

  /** Adds one evaluation of a step: its stats, and what it said for each ref it took in. */
  record(step: string, loader: string, stats: StepStats, said: Iterable<Said>): void {
    const entry = this.entryOf(step, loader);
    entry.keysIn += stats.keysIn;
    entry.cached += stats.cached;
    entry.billedBytes += stats.billedBytes;
    entry.ms += stats.ms;
    entry.retries += stats.retries;
    for (const error of stats.errors) {
      const id = `${error.class ?? ""}␟${error.code}`;
      const known = entry.errors.get(id);
      entry.errors.set(id, { ...error, keys: (known?.keys ?? 0) + error.keys });
    }
    for (const s of said) {
      if (s.outcome === "unknown" && s.reason) {
        entry.unknown[s.reason.reason] = (entry.unknown[s.reason.reason] ?? 0) + 1;
        continue;
      }
      if (s.outcome !== "unknown") entry[s.outcome] += 1;
      if (s.cuts && s.cuts.length > 0) entry.cut += 1;
    }
  }

  steps(): TraceStep[] {
    return [...this.entries.values()].map((entry) => ({
      ...entry,
      unknown: { ...entry.unknown },
      errors: [...entry.errors.values()],
    }));
  }

  billedBytes(): number {
    let total = 0;
    for (const entry of this.entries.values()) total += entry.billedBytes;
    return total;
  }

  private entryOf(step: string, loader: string): Entry {
    const id = `${step}␟${loader}`;
    let entry = this.entries.get(id);
    if (!entry) {
      entry = {
        step,
        loader,
        keysIn: 0,
        cached: 0,
        found: 0,
        absent: 0,
        unknown: {},
        cut: 0,
        billedBytes: 0,
        ms: 0,
        retries: 0,
        errors: new Map(),
      };
      this.entries.set(id, entry);
    }
    return entry;
  }
}
