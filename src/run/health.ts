// The health of the connectors, shared by the runs of one process (DESIGN.md §5.7): a circuit
// breaker and a rate limit per connector. Both must outlive a run, since a source that is down is
// down for every run and a rate is a rate across them all; and the library keeps no global state.
// So they live in an object the application creates once (`createHealth`) and hands to every run
// (`RunOptions.health`).
//
// A circuit counts the calls that threw on its connector. After `failures` of them within
// `windowMs` it opens for `coolDownMs`: the loaders that read the connector are not called, and
// their keys are `unknown: failed`, the connector open. Then it is half-open: one call goes through
// as a probe, the others are refused while it runs; the probe answering closes the circuit, its
// failing opens it for another cool-down. A call the run stopped waiting for says nothing about
// the source: it neither counts nor closes. A probe that has not ended within a cool-down is given
// up, so a call that hangs cannot keep the circuit shut: the next call probes instead.
//
// A rate is a token bucket: `burst` calls may start at once, then `perSecond`. A call that finds no
// token waits in line, and the calls in line get the tokens in the order they asked, as the bucket
// refills; one whose run stops leaves the line. Nothing is promised to a call before its token is
// there, so a call that leaves takes nobody's turn with it, and a token given back (a call that took
// one and did not start) goes to the next in line.

import { DefinitionError } from "../core/index.ts";

/** What a connector's circuit does now: `closed` lets calls through, `open` refuses them,
 *  `half-open` lets one probe through. */
export type CircuitState = "closed" | "open" | "half-open";

/** What `createHealth` takes per connector; either part may be left out. */
export interface ConnectorHealth {
  /** opens the connector's circuit after `failures` calls threw within `windowMs`, for
   *  `coolDownMs` */
  readonly breaker?: {
    readonly failures: number;
    readonly windowMs: number;
    readonly coolDownMs: number;
  };
  /** `burst` calls may start at once, then `perSecond` */
  readonly rate?: { readonly perSecond: number; readonly burst: number };
}

/** The connectors' circuits and rates, for every run that is given it (`RunOptions.health`). */
export interface Health {
  /** A connector's circuit now; a connector without a breaker is always closed. */
  state(connector: string): CircuitState;
}

/** A call let through the circuits of its connectors, or why not. A call let through says how it
 *  ended: answered, threw, or neither (the run stopped waiting for it); `probe`: it went through a
 *  half-open circuit. */
export type Entry =
  | { readonly kind: "open"; readonly connectors: readonly string[] }
  | {
      readonly kind: "pass";
      readonly probe: boolean;
      readonly end: (answered: boolean | undefined) => void;
    };

/** The tokens a call took; given back when it does not start after all. */
export interface Tokens {
  give(): void;
}

/**
 * The health of the connectors named in `connectors`; any other connector has no breaker and no
 * rate. Create it once per process and give it to every run.
 */
export function createHealth(connectors: Readonly<Record<string, ConnectorHealth>>): Health {
  return new HealthBook(connectors);
}

/** The `Health` a run reads: the one it was given, or none. */
export function healthOf(health: Health | undefined): HealthBook {
  if (health === undefined) return NONE;
  if (health instanceof HealthBook) return health;
  throw new DefinitionError("HG_SPEC", "RunOptions.health was not made by createHealth");
}

/** setTimeout's largest delay: a longer wait is made of several. */
const LONGEST = 2 ** 31 - 1;

export class HealthBook implements Health {
  private readonly circuits = new Map<string, Circuit>();
  private readonly buckets = new Map<string, Bucket>();

  constructor(connectors: Readonly<Record<string, ConnectorHealth>>) {
    for (const [name, spec] of Object.entries(connectors)) {
      if (spec.breaker) this.circuits.set(name, new Circuit(checkBreaker(name, spec.breaker)));
      if (spec.rate) this.buckets.set(name, new Bucket(checkRate(name, spec.rate), Date.now()));
    }
  }

  state(connector: string): CircuitState {
    return this.circuits.get(connector)?.state(Date.now()) ?? "closed";
  }

  /** Whether a call on `connectors` would be refused now: a retry is not tried into it. */
  refuses(connectors: readonly string[]): boolean {
    const now = Date.now();
    return connectors.some((name) => this.circuits.get(name)?.refuses(now) ?? false);
  }

  /** Lets a call on `connectors` through, unless one of their circuits refuses it. */
  enter(connectors: readonly string[]): Entry {
    const now = Date.now();
    const passed: [Circuit, Pass][] = [];
    const open: string[] = [];
    for (const name of new Set(connectors)) {
      const circuit = this.circuits.get(name);
      if (!circuit) continue;
      const pass = circuit.enter(now);
      if (pass === undefined) open.push(name);
      else passed.push([circuit, pass]);
    }
    if (open.length > 0) {
      for (const [circuit, pass] of passed) circuit.end(pass, undefined, now);
      return { kind: "open", connectors: open.sort() };
    }
    let ended = false;
    const end = (answered: boolean | undefined) => {
      if (ended) return;
      ended = true;
      const at = Date.now();
      for (const [circuit, pass] of passed) circuit.end(pass, answered, at);
    };
    return { kind: "pass", probe: passed.some(([, pass]) => pass !== "call"), end };
  }

  /** A token on each of `connectors` that has a rate, waiting in line where there is none yet; or
   *  undefined, every token taken given back, if `signal` aborts first. */
  async take(connectors: readonly string[], signal: AbortSignal): Promise<Tokens | undefined> {
    const taken: Bucket[] = [];
    const give = () => {
      for (const bucket of taken.splice(0)) bucket.give();
    };
    for (const name of [...new Set(connectors)].sort()) {
      const bucket = this.buckets.get(name);
      if (!bucket) continue;
      const got = bucket.take(signal);
      if (got !== true && !(await got)) {
        give();
        return undefined;
      }
      taken.push(bucket);
    }
    return { give };
  }
}

/** No breaker and no rate: what a run given no `health` reads. */
const NONE = new HealthBook({});

/** How a circuit let a call through: as one of many while closed, or as the probe of this number. */
type Pass = "call" | number;

class Circuit {
  /** when the calls that threw while it was closed did, within the window */
  private failures: number[] = [];
  private openUntil: number | undefined;
  /** the probe running, and since when */
  private probe: { readonly n: number; readonly at: number } | undefined;
  private probes = 0;

  constructor(private readonly spec: Required<ConnectorHealth>["breaker"]) {}

  state(now: number): CircuitState {
    if (this.openUntil === undefined) return "closed";
    return now < this.openUntil ? "open" : "half-open";
  }

  /** Whether `enter` would refuse a call now. */
  refuses(now: number): boolean {
    const state = this.state(now);
    return state === "open" || (state === "half-open" && this.probing(now));
  }

  enter(now: number): Pass | undefined {
    const state = this.state(now);
    if (state === "closed") return "call";
    if (state === "open" || this.probing(now)) return undefined;
    this.probes += 1;
    this.probe = { n: this.probes, at: now };
    return this.probes;
  }

  /** How a call it let through ended. Only the probe running closes or opens the circuit (one
   *  given up says nothing); a call let through while it was closed counts only when it threw
   *  and the circuit is still closed. */
  end(pass: Pass, answered: boolean | undefined, now: number): void {
    if (pass !== "call") {
      if (this.probe?.n !== pass) return;
      this.probe = undefined;
      if (answered === true) {
        this.openUntil = undefined;
        this.failures = [];
      }
      if (answered === false) this.trip(now);
      return;
    }
    if (answered !== false || this.openUntil !== undefined) return;
    this.failures = this.failures.filter((at) => now - at < this.spec.windowMs);
    this.failures.push(now);
    if (this.failures.length >= this.spec.failures) this.trip(now);
  }

  /** Whether a probe is running and not yet given up: one that has not ended within a cool-down
   *  is, so that a call that hangs does not keep the circuit shut for every run. */
  private probing(now: number): boolean {
    return this.probe !== undefined && now - this.probe.at < this.spec.coolDownMs;
  }

  private trip(now: number): void {
    this.openUntil = now + this.spec.coolDownMs;
    this.failures = [];
    this.probe = undefined;
  }
}

/** A token bucket with a line. Tokens are counted in fractions as they refill; a call starts with
 *  a whole one. */
class Bucket {
  private tokens: number;
  private readonly line: Array<() => void> = [];
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly spec: Required<ConnectorHealth>["rate"],
    private at: number,
  ) {
    this.tokens = spec.burst;
  }

  /** A token: true at once when there is one and nobody is in line; else a promise that is true
   *  when it is this call's turn, false (out of the line) if `signal` aborts first. */
  take(signal: AbortSignal): true | Promise<boolean> {
    this.refill();
    if (this.line.length === 0 && this.tokens >= WHOLE) {
      this.tokens -= 1;
      return true;
    }
    return new Promise((resolve) => {
      if (signal.aborted) return resolve(false);
      const turn = () => {
        signal.removeEventListener("abort", leave);
        resolve(true);
      };
      const leave = () => {
        const at = this.line.indexOf(turn);
        if (at >= 0) this.line.splice(at, 1);
        resolve(false);
        this.serve();
      };
      this.line.push(turn);
      signal.addEventListener("abort", leave, { once: true });
      this.serve();
    });
  }

  /** Gives back the token of a call that took one and did not start: the next in line has it. */
  give(): void {
    this.refill();
    this.tokens = Math.min(this.spec.burst, this.tokens + 1);
    this.serve();
  }

  /** Hands the tokens there are to the line, in order, and sets one timer for the next. */
  private serve(): void {
    this.refill();
    while (this.line.length > 0 && this.tokens >= WHOLE) {
      this.tokens -= 1;
      this.line.shift()?.();
    }
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.line.length === 0) return;
    const ms = Math.ceil(((1 - this.tokens) * 1000) / this.spec.perSecond);
    this.timer = setTimeout(() => this.serve(), Math.min(Math.max(1, ms), LONGEST));
  }

  private refill(): void {
    const now = Date.now();
    this.tokens = Math.min(
      this.spec.burst,
      this.tokens + ((now - this.at) * this.spec.perSecond) / 1000,
    );
    this.at = now;
  }
}

/** A token, give or take the rounding of its fractions. */
const WHOLE = 1 - 1e-9;

function checkBreaker(
  connector: string,
  breaker: Required<ConnectorHealth>["breaker"],
): Required<ConnectorHealth>["breaker"] {
  if (!Number.isInteger(breaker.failures) || breaker.failures < 1)
    throw wrong(connector, "breaker failures must be a whole number from 1");
  if (!(Number.isFinite(breaker.windowMs) && breaker.windowMs > 0))
    throw wrong(connector, "breaker windowMs must be a finite number above 0");
  if (!(Number.isFinite(breaker.coolDownMs) && breaker.coolDownMs >= 0))
    throw wrong(connector, "breaker coolDownMs must be a finite number from 0");
  return breaker;
}

function checkRate(
  connector: string,
  rate: Required<ConnectorHealth>["rate"],
): Required<ConnectorHealth>["rate"] {
  if (!(Number.isFinite(rate.perSecond) && rate.perSecond > 0))
    throw wrong(connector, "rate perSecond must be a finite number above 0");
  if (!(Number.isFinite(rate.burst) && rate.burst >= 1))
    throw wrong(connector, "rate burst must be a finite number from 1");
  return rate;
}

const wrong = (connector: string, what: string) =>
  new DefinitionError("HG_SPEC", `connector "${connector}": ${what}`);
