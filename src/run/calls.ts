// One call of a loader to its source (DESIGN.md §3.1, §5.3, §5.7): what happens between deciding to
// load a batch, or to price one, and having its answer.
//
// A load waits for a slot on each connector it reads (limits.ts), then for a token of their rates,
// then goes through their circuits (health.ts); a dry run goes through the circuits only. A metered
// load is told what is left of its job's budget and charged what it billed (`Purse`).
//
// A call that throws an error the run calls retryable is tried again, as many times as its
// loader's `retry` allows, after an exponential backoff with full jitter: a random wait up to
// `initialMs × factor^n`, capped at `maxMs`, so that the callers a failure synchronised do not
// come back together. A retry never waits past the deadline (it is not tried at all when its wait
// would end after it), never for an error the run calls fatal, never into an open circuit, and a
// metered one only while its job's budget has something left; one that gets no answer leaves the
// failure it followed. Every wait here gives up when the call's job stops (stop.ts): nothing it
// started is waited for. Each retry is an event on the call's span, with the failure it follows.

import {
  type Attrs,
  type Budget,
  CostChangedError,
  type Envelope,
  type LoadError,
  type LoaderDef,
  type Ref,
  type Retry,
} from "../core/index.ts";
import type { Entry, HealthBook } from "./health.ts";
import { type Limits, Semaphore } from "./limits.ts";
import type { Stop } from "./stop.ts";
import type { Span } from "./types.ts";

export interface CallEnv {
  readonly ctx: unknown;
  readonly limits: Limits;
  readonly health: HealthBook;
  /** errors of a load or a price that reject the run instead of failing keys (types.ts) */
  readonly fatal: (error: unknown) => boolean;
  /** errors of a load or a price worth trying again (types.ts) */
  readonly retryable: (error: unknown) => boolean;
}

/** A metered loader's dry run. */
export type Price = NonNullable<LoaderDef["price"]>;

/** A call as it is made: `refs` of `loader`, through `connectors`, under `stop` (its job's), on
 *  `span`. */
export interface Calling {
  readonly loader: LoaderDef;
  readonly refs: readonly Ref<unknown, Attrs>[];
  readonly connectors: readonly string[];
  readonly stop: Stop;
  readonly span: Span;
}

/** How a call ended, after every attempt it was given. */
export type Call<T> =
  /** the run stopped before it answered: its answer, if it comes, is dropped */
  | { readonly kind: "late" }
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "threw"; readonly error: LoadError }
  /** the circuit of these connectors was open: the source was not called */
  | { readonly kind: "open"; readonly connectors: readonly string[] }
  /** a metered job whose calls billed its whole budget: this one was not made */
  | { readonly kind: "spent" };

/** How a call that was made ended: a dry run, or a load its budget left room for. */
export type Made<T> = Exclude<Call<T>, { readonly kind: "spent" }>;

export interface Tried<T, C extends Call<T> = Call<T>> {
  readonly call: C;
  /** attempts that answered or threw */
  readonly attempts: number;
  /** attempts after the first that answered or threw */
  readonly retries: number;
  /** what the attempts that threw said their source billed */
  readonly billed: number;
}

/** One attempt. A thrown error stays as it was thrown, for `retryable` to judge. */
type Attempt<T> =
  | { readonly kind: "late" }
  | { readonly kind: "done"; readonly value: T }
  | { readonly kind: "threw"; readonly error: unknown }
  | { readonly kind: "open"; readonly connectors: readonly string[] };

const LATE = { kind: "late" } as const;

/** What a retry policy leaves out. */
const BACKOFF = { initialMs: 100, maxMs: 10_000, factor: 2, jitter: "full" } as const;

/**
 * What a metered job may still bill (DESIGN.md §5.3): the budget it was priced and approved at,
 * less what its calls billed. Every attempt of every call is told what is left, so together they
 * never bill past the budget. An attempt that threw without saying what it billed is charged all it
 * was told: the source may have billed the job before the answer was lost.
 */
export class Purse {
  private spent = 0;
  constructor(readonly budget: number) {}

  /** what the next attempt may bill */
  left(): number {
    return Math.max(0, this.budget - this.spent);
  }

  charge(bytes: number): void {
    this.spent += bytes;
  }

  /** Whether the calls so far billed the whole budget. A budget of nothing is never spent: a job
   *  priced at nothing runs every call, each told it may bill nothing. */
  empty(): boolean {
    return this.spent > 0 && this.spent >= this.budget;
  }
}

export class Calls {
  /** per `one` loader: its own concurrency bound */
  private readonly ownSlots = new Map<string, Semaphore>();

  constructor(private readonly env: CallEnv) {}

  /**
   * Loads the call's refs, holding a slot on each of its connectors; a metered load draws on
   * `purse`. An answer that comes after the call's stop stopped is dropped: the call is late.
   */
  load(call: Calling, purse: Purse | undefined): Promise<Tried<Envelope<unknown, unknown>>> {
    if (purse?.empty())
      return Promise.resolve({ call: { kind: "spent" }, attempts: 0, retries: 0, billed: 0 });
    const attempt = async (): Promise<Attempt<Envelope<unknown, unknown>>> => {
      const budget: Budget = { maxBytes: purse?.left() };
      const attempted = await this.loadOnce(call, budget);
      // what the attempt says it billed, or else all it was told: a bill that is not a number of
      // bytes is no bill
      const told = budget.maxBytes ?? 0;
      if (purse && attempted.kind === "done")
        purse.charge(billOf(attempted.value.billedBytes) ?? told);
      if (purse && attempted.kind === "threw") purse.charge(billedBy(attempted.error) ?? told);
      return attempted;
    };
    return this.tried(call, attempt, () => !purse?.empty());
  }

  /** A dry run of the call's refs by the loader's `price`: the bytes loading them would bill. It
   *  holds no slot and takes no token, but goes through the circuits of its connectors: an open
   *  source is not called at all. */
  price(call: Calling, price: Price): Promise<Tried<number, Made<number>>> {
    const { refs, stop } = call;
    const ctx = ctxFor(this.env.ctx, call.loader.ctxKeys);
    const attempt = async (): Promise<Attempt<number>> => {
      if (stop.stopped()) return LATE;
      const entry = met(this.env.health.enter(call.connectors), call.span);
      if (entry.kind === "open") return { kind: "open", connectors: entry.connectors };
      return this.judged(entry, () => this.answered(() => price(refs, ctx, stop.signal), stop));
    };
    return this.tried(call, attempt);
  }

  /**
   * Makes attempts until one answers, its error is not to be tried again, the loader's policy has
   * none left, or the run stops; between two, waits the backoff, unless that would end past the
   * deadline. `more`: whether another attempt may still be made (a metered job's budget is left).
   * A retry is not tried into a circuit that would refuse it; and once an attempt threw, a retry
   * that does not answer (the run stopped first, a circuit refused it) leaves that failure as it
   * was: a retry never turns a failure into a deadline.
   */
  private async tried<T>(
    call: Calling,
    attempt: () => Promise<Attempt<T>>,
    more: () => boolean = () => true,
  ): Promise<Tried<T, Made<T>>> {
    const { health } = this.env;
    const { connectors, stop, span } = call;
    const keys = call.refs.length;
    const policy = call.loader.retry;
    let billed = 0;
    let attempts = 0;
    let retries = 0;
    let failed: { readonly error: unknown } | undefined;
    const threw = (error: unknown): Tried<T, Made<T>> => ({
      call: { kind: "threw", error: failure(error, keys) },
      attempts,
      retries,
      billed,
    });
    for (;;) {
      const result = await attempt();
      // a retry that got no verdict is not counted, and leaves the last failure
      if (failed && (result.kind === "late" || result.kind === "open")) {
        retries -= 1;
        return threw(failed.error);
      }
      if (result.kind === "done" || result.kind === "threw") attempts += 1;
      if (result.kind !== "threw") return { call: result, attempts, retries, billed };
      failed = { error: result.error };
      billed += billedBy(result.error) ?? 0;
      const again =
        policy !== undefined &&
        retries + 1 < policy.attempts &&
        more() &&
        !health.refuses(connectors) &&
        this.env.retryable(result.error);
      const wait = again ? backoff(policy, retries + 1) : 0;
      if (!again || !stop.fits(wait) || !(await stop.sleep(wait))) return threw(result.error);
      // tried again after this failure
      span.addEvent("hopgraph.retry", {
        "hopgraph.attempt": attempts + 1,
        ...errorAttributes(failure(result.error, keys)),
      });
      retries += 1;
    }
  }

  /**
   * One attempt of a load. It holds its slots until it ends, waited for or not; then takes a token
   * of each rate, so the rate counts calls as they start; then asks the circuits, so a call that
   * waited is refused if a circuit opened meanwhile, and gives its tokens back.
   */
  private async loadOnce(
    call: Calling,
    budget: Budget,
  ): Promise<Attempt<Envelope<unknown, unknown>>> {
    const { health } = this.env;
    const { loader, refs, connectors, stop, span } = call;
    const ctx = ctxFor(this.env.ctx, loader.ctxKeys);
    const release = await this.env.limits.hold(connectors, this.ownSlot(loader), stop.signal);
    if (!release) return LATE;
    let handed = false;
    try {
      if (stop.stopped()) return LATE;
      const tokens = await health.take(connectors, stop.signal);
      if (!tokens) return LATE;
      const entry = stop.stopped() ? undefined : met(health.enter(connectors), span);
      if (entry?.kind !== "pass") {
        tokens.give();
        return entry ? { kind: "open", connectors: entry.connectors } : LATE;
      }
      handed = true;
      return await this.judged(entry, () =>
        this.answered(() => loader.load(refs, ctx, budget, stop.signal), stop, release),
      );
    } finally {
      if (!handed) release();
    }
  }

  /**
   * An attempt the circuits let through, and how it ended told to them. One the run stopped
   * waiting for says nothing about the source; a fatal error (a spent quota) is the source
   * refusing; a refused approval is the run's, not the source's.
   */
  private async judged<T>(
    entry: Extract<Entry, { kind: "pass" }>,
    attempt: () => Promise<Attempt<T>>,
  ): Promise<Attempt<T>> {
    let answered: boolean | undefined;
    try {
      const result = await attempt();
      answered = result.kind === "done" ? true : result.kind === "threw" ? false : undefined;
      return result;
    } catch (error) {
      answered = error instanceof CostChangedError ? undefined : false;
      throw error;
    } finally {
      entry.end(answered);
    }
  }

  /**
   * The attempt's answer, unless the run stops first. A throw fails the attempt, never the run;
   * except a refused approval (`CostChangedError`) and what the application declares fatal (a
   * spent quota): those reject it. `release` runs when the work ends, waited for or not: the
   * source is busy until then.
   */
  private async answered<T>(
    io: () => Promise<T>,
    stop: Stop,
    release?: () => void,
  ): Promise<Attempt<T>> {
    let failing: { readonly error: unknown } | undefined;
    const working = (async (): Promise<Attempt<T>> => {
      try {
        return { kind: "done", value: await io() };
      } catch (error) {
        if (!(error instanceof CostChangedError || this.env.fatal(error)))
          return { kind: "threw", error };
        // the run hears of it here, before the source's slot is free: a load waiting for the
        // slot must not start once the run has failed
        failing = { error };
        stop.fails(error);
        throw error;
      }
    })();
    if (release) working.then(release, release);
    const settled = await stop.within(working);
    // the failure stopped this call's own part too: it fails the run all the same
    if (failing) throw failing.error;
    if (!settled.done || stop.stopped()) return LATE;
    return settled.value;
  }

  private ownSlot(loader: LoaderDef): Semaphore | undefined {
    if (loader.batch.by !== "one") return undefined;
    let slot = this.ownSlots.get(loader.id);
    if (!slot) {
      slot = new Semaphore(Math.max(1, loader.batch.concurrency));
      this.ownSlots.set(loader.id, slot);
    }
    return slot;
  }
}

/** The entry a call met at the circuits, kept on its span: the state of the circuit it met. */
function met(entry: Entry, span: Span): Entry {
  span.setAttribute(
    "hopgraph.circuit",
    entry.kind === "open" ? "open" : entry.probe ? "half-open" : "closed",
  );
  return entry;
}

/** A failure as a span event's attributes: its code and its class, never its message. */
function errorAttributes(error: LoadError): Record<string, string> {
  return {
    "hopgraph.error.code": error.code,
    ...(error.class === undefined ? {} : { "hopgraph.error.class": error.class }),
  };
}

/** The wait before retry `n` (from 1): up to `initialMs × factor^(n-1)`, at most `maxMs`; with full
 *  jitter, a random time up to that bound. */
export function backoff(policy: Retry, n: number): number {
  const initialMs = policy.initialMs ?? BACKOFF.initialMs;
  const factor = policy.factor ?? BACKOFF.factor;
  const bound = Math.min(policy.maxMs ?? BACKOFF.maxMs, initialMs * factor ** (n - 1));
  return (policy.jitter ?? BACKOFF.jitter) === "full" ? Math.random() * bound : bound;
}

/** The run values a loader declared, and only those. */
export function ctxFor(ctx: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (typeof ctx !== "object" || ctx === null) return {};
  return Object.fromEntries(keys.map((key) => [key, Reflect.get(ctx, key)]));
}

/**
 * A failure as the trace keeps it: the error's own code and its class, never its message (it may
 * contain values). Only a short identifier is kept, so a code or a name that holds anything else
 * (a sentence, a value) is not.
 */
export function failure(error: unknown, keys: number): LoadError {
  return { ...described(error), keys };
}

/** An error by its own code and its class, never its message. */
export function described(error: unknown): { readonly code: string; readonly class?: string } {
  try {
    const named = error instanceof Error && SAFE.test(error.name) ? error.name : undefined;
    const kind = named ?? (error instanceof Error ? "Error" : "thrown");
    const own =
      error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined;
    const code =
      (typeof own === "string" && SAFE.test(own)) ||
      (Number.isInteger(own) && typeof own === "number")
        ? String(own)
        : undefined;
    return code === undefined || code === kind ? { code: kind } : { code, class: kind };
  } catch {
    // an error whose name or code throws when read is described by nothing it holds
    return { code: "thrown" };
  }
}

/** A class name or an error code: a short identifier, nothing a value could hide in. */
const SAFE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** What a thrown error says its source billed before it failed (`billedBytes`), if it says. */
function billedBy(error: unknown): number | undefined {
  return error !== null && typeof error === "object"
    ? billOf(Reflect.get(error, "billedBytes"))
    : undefined;
}

/** A bill as a source reports it: a finite number of bytes from 0, else no bill at all. */
export function billOf(bytes: unknown): number | undefined {
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0 ? bytes : undefined;
}
