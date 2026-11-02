// When a run stops (DESIGN.md §5.3): its caller aborts it, its deadline passes, or it fails. One
// signal says so to every load and dry run (their last argument), so a source that honours it stops
// working for nobody. Past that point nothing starts, and nothing the run waits for is waited for:
// a load that ignores its signal is left running, its late answer dropped.
//
// The three differ in what the run does next. Aborted by its caller, it rejects with the caller's
// reason, as `fetch` does. Past its deadline, it answers: what was read stands, the rest is
// `unknown: deadline`. Failed, it rejects with what failed it. The deadline is watched twice: a
// timer aborts what runs at the instant, and the run's clock is read before anything starts, so a
// clock the application gives (one that is not the time the timer counts) is obeyed too.

import { AbortedError } from "../core/index.ts";

/** What `within` gives back: the work's value, or that the run stopped first. */
export type Within<T> = { readonly done: true; readonly value: T } | { readonly done: false };

const LATE: Within<never> = { done: false };

/** setTimeout's largest delay: a later deadline is left to the clock. */
const LONGEST = 2 ** 31 - 1;

export class Stop {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout> | undefined;
  private readonly forget: () => void;
  /** set when the caller aborted or the run failed: what `race` rejects with */
  private refusal: { readonly reason: unknown } | undefined;
  private readonly refusals = new Set<(reason: unknown) => void>();

  constructor(
    private readonly at: number | undefined,
    private readonly clock: () => number,
    caller?: AbortSignal,
    timed = true,
    /** who hears that the work of this part failed the run (`fails`) */
    private readonly failing?: (error: unknown) => void,
  ) {
    const onAbort = () => this.end(caller?.reason, caller?.reason);
    caller?.addEventListener("abort", onAbort, { once: true });
    this.forget = () => caller?.removeEventListener("abort", onAbort);
    if (caller?.aborted) onAbort();
    const left = at === undefined ? undefined : at - clock();
    if (timed && left !== undefined && left <= LONGEST)
      this.timer = setTimeout(() => this.expire(), Math.max(0, left));
  }

  /**
   * A part of the run that stops with it, or alone (`halt`): one job's calls. A failure
   * stops the jobs of its wave and of later ones while the jobs before it finish (reads.ts). When
   * the run stops, the part's signal aborts with the run's reason, even once the part is over: the
   * signal a load was given aborts when the run stops, whenever that is. `failing` hears what the
   * part's work throws that fails the run; a part of a part hears through its parent's.
   */
  part(failing = this.failing): Stop {
    return new Stop(this.at, this.clock, this.controller.signal, false, failing);
  }

  /** The work of this part threw what fails the run: the run hears it at once, before anything
   *  the work held (a connector slot) is let go, and stops what must not start. */
  fails(error: unknown): void {
    this.failing?.(error);
  }

  /** The signal every load and dry run of the run gets. */
  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** Whether nothing may start any more: the run was aborted, failed, or is past its deadline. */
  stopped(): boolean {
    if (this.controller.signal.aborted) return true;
    if (this.at !== undefined && this.clock() > this.at) {
      this.expire();
      return true;
    }
    return false;
  }

  /** Whether the deadline has passed (the run answers all the same). */
  passed(): boolean {
    return this.at !== undefined && this.clock() > this.at;
  }

  /** Whether a wait of `ms` from now ends by the deadline: a retry that would start past it is not
   *  waited for. */
  fits(ms: number): boolean {
    return this.at === undefined || this.clock() + ms <= this.at;
  }

  /** Waits `ms`: true when it did, false as soon as the run stops. */
  sleep(ms: number): Promise<boolean> {
    return sleep(ms, this.controller.signal);
  }

  /** The run has failed: what runs is aborted, and nothing starts. */
  halt(error: unknown): void {
    this.end(new AbortedError("failed", { cause: error }), error);
  }

  /**
   * The work's value, or `{ done: false }` as soon as the run stops if that comes first. Whatever
   * the work does after that is dropped, a rejection included.
   */
  within<T>(work: Promise<T>): Promise<Within<T>> {
    const signal = this.controller.signal;
    if (signal.aborted) {
      work.catch(() => undefined);
      return Promise.resolve(LATE);
    }
    return new Promise((resolve, reject) => {
      const onAbort = () => resolve(LATE);
      signal.addEventListener("abort", onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve({ done: true, value });
        },
        (error: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        },
      );
    });
  }

  /**
   * The run's work, unless its caller aborts it or it fails first: then it rejects at once with
   * that reason, without waiting for what still runs. Past the deadline the work goes on: it
   * answers, every read that is left settling as soon as it stops waiting.
   */
  race<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      if (this.refusal) reject(this.refusal.reason);
      this.refusals.add(reject);
      work.then(
        (value) => {
          this.refusals.delete(reject);
          resolve(value);
        },
        (error: unknown) => {
          this.refusals.delete(reject);
          reject(error);
        },
      );
    });
  }

  /** The run is over: its timer and its hold on the caller's signal go. */
  close(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.forget();
  }

  private expire(): void {
    if (!this.controller.signal.aborted) this.controller.abort(new AbortedError("deadline"));
  }

  /** Aborts what runs with `reason` (what the loads see), unless the deadline did already; the run
   *  rejects with `refusal`, even past its deadline. The first refusal is the one. */
  private end(reason: unknown, refusal: unknown): void {
    if (this.refusal) return;
    this.refusal = { reason: refusal };
    if (!this.controller.signal.aborted) this.controller.abort(reason);
    for (const reject of this.refusals) reject(refusal);
  }
}

/** Waits `ms`: true when it did, false as soon as `signal` aborts (its timer then goes). */
export function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
