// Loads in flight, shared by the runs of one process (DESIGN.md §5.7). Two runs that ask the same
// loader key at once (the same cache entry: loader, version, key, what the load reads, the run
// values that are data, the restriction) load it once: the second waits for the first's answer
// instead of calling the source again. Like the health of the connectors, this outlives a run, so
// it lives in an object the application creates once (`createInflight`) and hands to every run
// (`RunOptions.inflight`).
//
// A run puts the keys of a job in flight once the job is admitted, and lands each with its call's
// answer. Only what the cache would keep of it is shared (a found or an absent answer whose
// retention is not "none"): an unknown belongs to the run that met it (its deadline, its budget,
// its approval), so a run that waited for one reads the key itself. A run that stops waiting
// (aborted, past its deadline) leaves the load to the others.

import { DefinitionError } from "../core/index.ts";
import type { KeyAnswer } from "./envelope.ts";

/** The loads in flight, for every run that is given it (`RunOptions.inflight`). */
export interface Inflight {
  /** loader keys being loaded now by the runs that share it */
  readonly size: number;
}

/** Loads in flight, to share between the runs of one process. Create it once and give it to
 *  every run. */
export function createInflight(): Inflight {
  return new Flights();
}

/** The flights a run reads: the ones it was given, or none. */
export function flightsOf(inflight: Inflight | undefined): Flights | undefined {
  if (inflight === undefined || inflight instanceof Flights) return inflight;
  throw new DefinitionError("HG_SPEC", "RunOptions.inflight was not made by createInflight");
}

export class Flights implements Inflight {
  /** by cache entry: the answer to share, once the load lands */
  private readonly loading = new Map<string, Promise<KeyAnswer | undefined>>();

  get size(): number {
    return this.loading.size;
  }

  /** What another run is loading for this entry, if one is: its answer when there is one to share,
   *  undefined when it landed without. */
  waiting(entry: string): Promise<KeyAnswer | undefined> | undefined {
    return this.loading.get(entry);
  }

  /**
   * This run loads `entry`, unless another already does. Gives back how to land it: with the
   * answer to share (what the cache would keep of it), or undefined when there is none. Land it in
   * any case: the runs that wait for it wait until then.
   */
  start(entry: string): ((answer: KeyAnswer | undefined) => void) | undefined {
    if (this.loading.has(entry)) return undefined;
    let land!: (answer: KeyAnswer | undefined) => void;
    const flight = new Promise<KeyAnswer | undefined>((resolve) => {
      land = resolve;
    });
    this.loading.set(entry, flight);
    return (answer) => {
      if (this.loading.get(entry) === flight) this.loading.delete(entry);
      land(answer);
    };
  }
}
