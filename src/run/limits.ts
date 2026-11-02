// When a load may start (DESIGN.md §3.1, §5.3). Concurrency is the connector's: every load holds a
// slot on each connector it reads, and a `one` loader also one of its own slots. Slots are taken in
// one order (the loader's own first, then connectors by name), so two loads never wait on each
// other. A load waiting for a slot gives up when the run stops (stop.ts): past the deadline no load
// starts, so none waits to.

import { DefinitionError } from "../core/index.ts";

export class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly size: number) {}

  /**
   * Resolves with the release once a slot is free, or with `undefined` if `signal` aborts first
   * (the waiter then leaves the queue). Releasing twice is harmless.
   */
  acquire(signal?: AbortSignal): Promise<(() => void) | undefined> {
    return new Promise((resolve) => {
      if (signal?.aborted) return resolve(undefined);
      const grant = () => {
        signal?.removeEventListener("abort", giveUp);
        this.active += 1;
        let released = false;
        resolve(() => {
          if (released) return;
          released = true;
          this.active -= 1;
          this.waiting.shift()?.();
        });
      };
      const giveUp = () => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) this.waiting.splice(at, 1);
        resolve(undefined);
      };
      if (this.active < this.size) return grant();
      this.waiting.push(grant);
      signal?.addEventListener("abort", giveUp, { once: true });
    });
  }
}

/**
 * The run's limits, refused when one is not a whole number from 1 or `Infinity`: a limit that is
 * not a number (an unset variable read with `Number`) would hold every load on its connector until
 * the deadline, and one under 1 would hold them for ever.
 */
export function runLimits(
  limits: Readonly<Record<string, number>> = {},
): Readonly<Record<string, number>> {
  for (const [connector, limit] of Object.entries(limits))
    if (!(limit === Number.POSITIVE_INFINITY || (Number.isInteger(limit) && limit >= 1)))
      throw new DefinitionError(
        "HG_SPEC",
        `limits.${connector} must be a whole number from 1, or Infinity`,
      );
  return limits;
}

export class Limits {
  private readonly slots = new Map<string, Semaphore>();

  constructor(private readonly limits: Readonly<Record<string, number>>) {}

  /**
   * Waits for a slot on `own` and on each connector, and returns the release of them all; or
   * `undefined`, holding nothing, if `signal` aborts first.
   */
  async hold(
    connectors: readonly string[],
    own?: Semaphore,
    signal?: AbortSignal,
  ): Promise<(() => void) | undefined> {
    const ordered = [...new Set(connectors)].sort().map((name) => this.slot(name));
    const releases: Array<() => void> = [];
    const releaseAll = () => {
      for (const release of releases) release();
    };
    for (const slot of own ? [own, ...ordered] : ordered) {
      const release = await slot.acquire(signal);
      if (!release) {
        releaseAll();
        return undefined;
      }
      releases.push(release);
    }
    return releaseAll;
  }

  private slot(connector: string): Semaphore {
    let slot = this.slots.get(connector);
    if (!slot) {
      // a connector given no limit is not bounded here: its loaders' batching still bounds them
      const limit = Object.hasOwn(this.limits, connector) ? this.limits[connector] : undefined;
      slot = new Semaphore(limit ?? Number.POSITIVE_INFINITY);
      this.slots.set(connector, slot);
    }
    return slot;
  }
}
