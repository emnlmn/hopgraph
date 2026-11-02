// The unit of I/O (DESIGN.md §3.1, §5): a step asks a loader for refs and gets one answer per ref.
// Behind that one call: whether this viewer may read the loader's connectors, whether the run has
// stopped (stop.ts), the answers the run already has, and the job that fetches the rest (job.ts:
// the cache, other runs' flights, the price and gate, the batches, the write-back).
//
// Reads run in waves (schedule.ts). A step's read is in the wave after the one its lane has
// reached, and every read of one loader in one wave, whatever step asked (a strategy, a
// verification, a hydration, a provider), is one job. A job starts once nothing behind it can
// still add keys to it, so a step behind a fast read does not wait for an unrelated slow one. A
// loader's jobs run one after the other, in wave order, and a key that two waves ask is fetched by
// the earlier one: the later finds it answered. A read whose keys are all answered already still
// takes its wave, so the waves of the reads after it do not depend on when it was asked.
//
// A step still waiting for some of its inputs offers the refs it already has (`anticipate`): a job
// of a later wave that reads the same loader anyway takes their keys too, up to the wave the step
// starts in, so the step finds them answered when it runs. An offer never starts a job.
//
// What a job did goes to the steps that asked by an order the inputs decide, step ids: a key it
// loaded is loaded for the step with the smallest id that asked for it, and cached (answered by
// another step) for the others; its bill, failures and retries go to the step with the smallest id
// of all.
//
// A run fails when a resumed approval falls short of its price (`CostChangedError`), or when a job
// throws what fails the run (an error the application declares fatal). Under the barrier the
// earliest wave's failure was always the one: nothing of a later wave had started. So that it still
// is, whatever the timing, a failure does not stop the run at once: the jobs of later waves stop,
// and the loads of its own; the jobs before it finish; every job of its wave is priced; then the
// run fails with the earliest wave's failure. A refusal names every approval its wave refused, and
// comes before an error thrown in the same wave: every dry run of the wave ends, while a load that
// would throw may have been stopped by the refusal first. Of the errors a wave's jobs throw, the
// run fails with the one of the smallest step id. A call that throws what fails the run says so at
// once, through its job's stop, before it lets go of its connector slots (calls.ts).

import {
  type Attrs,
  CostChangedError,
  type EntityDef,
  type LoadError,
  type LoaderDef,
  type UnknownReason,
  type Unread,
} from "../core/index.ts";
import { Calls, ctxFor, described } from "./calls.ts";
import { DEADLINE, FAILED, type KeyAnswer } from "./envelope.ts";
import type { Flights } from "./flights.ts";
import type { Approvals, Gates } from "./gates.ts";
import type { HealthBook } from "./health.ts";
import { answerKey, isData, stableJson } from "./ids.ts";
import { type Done, Jobs, type LoaderKey, type Stops } from "./job.ts";
import type { Limits } from "./limits.ts";
import type { RefNode, RefStore, Show } from "./refs.ts";
import { type Behind, type Lane, type Reach, Schedule } from "./schedule.ts";
import type { Stop } from "./stop.ts";
import type { CachePort, Span, Tracer } from "./types.ts";

export interface ReadEnv {
  readonly entities: Readonly<Record<string, EntityDef>>;
  readonly refs: RefStore;
  readonly ctx: unknown;
  readonly restriction: string;
  readonly readable: (connector: string) => true | Unread;
  readonly cache: CachePort;
  readonly limits: Limits;
  /** the connectors' circuits and rates, shared with other runs (health.ts) */
  readonly health: HealthBook;
  /** the loads in flight, shared with other runs (flights.ts); none: this run shares nothing */
  readonly flights?: Flights;
  readonly approvals: Approvals;
  readonly stop: Stop;
  readonly gates: Gates;
  readonly show: Show;
  /** errors of a load or a price that reject the run instead of failing keys (types.ts) */
  readonly fatal: (error: unknown) => boolean;
  /** errors of a load or a price worth trying again (types.ts) */
  readonly retryable: (error: unknown) => boolean;
  /** whether every envelope is audited, its contradictions failed (validate.ts `strict`) */
  readonly strict: boolean;
  /** prices known by gate id (a previous run's), and those this run measures */
  readonly prices: Map<string, number>;
  readonly now: () => number;
  readonly tracer: Tracer;
  /** the run's span: every job's is its child */
  readonly span: Span;
  /** which loaders the work of each plan node may still read (schedule.ts) */
  readonly reach: Reach;
}

export interface ReadResult {
  /** one answer per ref asked, by ref id */
  readonly answers: ReadonlyMap<string, KeyAnswer>;
  /** loader keys answered without being loaded for this read's step: by the cache, by another
   *  run's load, or by another step */
  readonly cached: number;
  /** the refs whose loader key was loaded for this read's step: the ones not cached for it */
  readonly loaded: ReadonlySet<string>;
  readonly billedBytes: number;
  readonly errors: readonly LoadError[];
  /** calls tried again for this read */
  readonly retries: number;
}

/** What a read is told, its loaded keys by loader key id. */
type Served = Omit<ReadResult, "answers">;

/** A step's read, waiting for the jobs that answer its keys. */
interface Request {
  readonly step: string;
  readonly loader: string;
  readonly wave: number;
  /** its loader keys, each once */
  readonly keys: readonly LoaderKey[];
  /** when it was asked */
  readonly at: number;
  /** how many of its keys no job has answered yet */
  outstanding: number;
  /** what holds back the jobs of later waves while it waits (schedule.ts) */
  readonly behind: Behind;
  /** the keys its own job loaded for its step: the ones not cached for it */
  loaded: ReadonlySet<string>;
  /** what its job did, when this read pays for it */
  paid: Omit<Done, "hits">;
  readonly resolve: (served: Served) => void;
  readonly reject: (error: unknown) => void;
}

/** The reads of one loader in one wave, and the keys it fetches. */
interface Job {
  readonly loader: LoaderDef;
  readonly wave: number;
  /** by loader key id: the keys it fetches, none of them answered yet */
  readonly keys: Map<string, LoaderKey>;
  /** the reads of its wave that ask some of its keys */
  readonly requests: Request[];
  /** once it started: what stops it alone */
  stops?: Stops;
}

/** A key a step waiting for its other inputs offers to the jobs of its loader. */
interface Offer {
  /** the plan node that offers it */
  readonly node: string;
  readonly step: string;
  readonly key: LoaderKey;
  /** the wave the input that brought it ended in: jobs of later waves take it */
  readonly after: number;
  /** the wave the node started in, once it did: its own reads come after */
  until: number | undefined;
}

/** What a job's span counts, before it counted anything. */
const ZERO = {
  "hopgraph.cache.hits": 0,
  "hopgraph.inflight.hits": 0,
  "hopgraph.loaded": 0,
  "hopgraph.calls": 0,
  "hopgraph.attempts": 0,
  "hopgraph.retries": 0,
  "hopgraph.billed_bytes": 0,
  "hopgraph.cache_ms": 0,
  "hopgraph.price_ms": 0,
  "hopgraph.load_ms": 0,
} as const;

const NO_KEYS: ReadonlySet<string> = new Set();
const NOTHING: Served = { cached: 0, loaded: NO_KEYS, billedBytes: 0, errors: [], retries: 0 };
const UNPAID: Omit<Done, "hits"> = { billed: 0, errors: [], retries: 0 };

export class Reads {
  /** per loader: the run's answers by loader key */
  private readonly settled = new Map<string, Map<string, KeyAnswer>>();
  /** per loader: its jobs not done, in wave order; only the first runs */
  private readonly queues = new Map<string, Job[]>();
  /** per loader, by loader key id: the job that fetches it */
  private readonly claims = new Map<string, Map<string, Job>>();
  /** per loader, by loader key id: the reads waiting for it */
  private readonly waiters = new Map<string, Map<string, Request[]>>();
  /** per loader: what waiting steps offer */
  private readonly offers = new Map<string, Offer[]>();
  private readonly schedule: Schedule;
  private readonly jobs: Jobs;
  private scheduled = false;
  /** the earliest wave that failed: the approvals it refused, and of the errors its jobs threw,
   *  the one of the job with the smallest step id */
  private failed:
    | {
        readonly wave: number;
        readonly refusals: CostChangedError[];
        thrown?: { readonly error: unknown; readonly by: string };
      }
    | undefined;
  private refusal: CostChangedError | undefined;
  /** the jobs started, and the latest wave one started in */
  private started = 0;
  private latest = 0;
  private readonly readability = new Map<string, true | Unread>();
  /** per loader: the json of its declared ctx values that are data, part of its cache keys */
  private readonly data = new Map<string, string>();

  constructor(private readonly env: ReadEnv) {
    this.schedule = new Schedule(env.reach);
    this.jobs = new Jobs({
      ...env,
      calls: new Calls(env),
      keyReading: (loader, ref, read) => this.keyReading(loader, ref, read),
      held: (loader) => this.held(loader),
      refuse: (wave, refusal) => this.fail(wave, { refusal }),
      loads: (wave) => this.failed === undefined || wave < this.failed.wave,
    });
  }

  /**
   * The answers of `refs` from `loader`, read in the wave after the one `lane` has reached; the
   * lane is then in that wave. `stepNeeds`: the needs of the whole step, when they are more than
   * the loader's own.
   */
  async read(
    lane: Lane,
    step: string,
    loader: LoaderDef,
    refs: readonly RefNode[],
    stepNeeds: readonly string[] = loader.needs,
  ): Promise<ReadResult> {
    if (refs.length === 0) return { answers: new Map(), ...NOTHING };
    // an unreadable source is not touched, cache included: a disabled connector never shows data
    const unread = this.unread(loader);
    if (unread) return everyRef(refs, { kind: "unknown", reason: unread });
    if (this.env.stop.stopped()) return everyRef(refs, DEADLINE);

    const wave = lane.wave + 1;
    const keyOf = new Map<string, LoaderKey>();
    for (const ref of refs) keyOf.set(ref.id, this.loaderKey(loader, ref, stepNeeds));
    const keys = [...new Map([...keyOf.values()].map((k) => [k.id, k])).values()];
    const settled = this.settledOf(loader.id);
    const open = keys.filter((k) => !settled.has(k.id));
    const served =
      open.length === 0
        ? this.servedOf(keys, settled, NO_KEYS, UNPAID)
        : await new Promise<Served>((resolve, reject) => {
            this.ask(
              {
                step,
                loader: loader.id,
                wave,
                keys,
                at: this.env.now(),
                outstanding: open.length,
                behind: this.schedule.enter(lane.node, wave),
                loaded: NO_KEYS,
                paid: UNPAID,
                resolve,
                reject,
              },
              loader,
              open,
            );
          });
    lane.wave = wave;
    const answers = new Map<string, KeyAnswer>();
    const loaded = new Set<string>();
    for (const [refId, k] of keyOf) {
      answers.set(refId, settled.get(k.id) ?? FAILED);
      if (served.loaded.has(k.id)) loaded.add(refId);
    }
    return { answers, ...served, loaded };
  }

  /**
   * Work of `lane` that is not a read (an asynchronous validator): until it ends, it holds back
   * the jobs it could still add keys to.
   */
  async busy<T>(lane: Lane, work: Promise<T>): Promise<T> {
    const behind = this.schedule.enter(lane.node, lane.wave);
    try {
      return await work;
    } finally {
      this.schedule.leave(behind);
      this.kick();
    }
  }

  /**
   * Offers the refs a plan node already has, while it waits for its other inputs, to the jobs of
   * `loader` in waves after `wave` (the wave the input that brought them ended in). Refs that need
   * a hydration first are not offered: their node reads them itself, after it.
   */
  anticipate(
    node: string,
    step: string,
    loader: LoaderDef,
    refs: readonly RefNode[],
    stepNeeds: readonly string[],
    wave: number,
  ): void {
    if (this.unread(loader)) return;
    const offers = this.offers.get(loader.id) ?? [];
    for (const ref of refs) {
      const { refs: store } = this.env;
      if (store.lacks(ref, stepNeeds) || store.missing(ref, stepNeeds).length > 0) continue;
      const key = this.loaderKey(loader, ref, stepNeeds);
      offers.push({ node, step, key, after: wave, until: undefined });
    }
    this.offers.set(loader.id, offers);
  }

  /** The node starts in `wave`: the jobs of later waves no longer take what it offered, since it
   *  reads that itself. */
  withdraw(node: string, wave: number): void {
    for (const offers of this.offers.values())
      for (const offer of offers)
        if (offer.node === node && offer.until === undefined) offer.until = wave;
  }

  /** The prices measured or reused so far, by gate id. */
  prices(): ReadonlyMap<string, number> {
    return new Map(this.env.prices);
  }

  /** The jobs the run started, and the latest wave one started in. */
  stats(): { readonly jobs: number; readonly waves: number } {
    return { jobs: this.started, waves: this.latest };
  }

  /**
   * What the run fails with, if it failed: the earliest wave's failure. Its refused approvals as
   * one `CostChangedError` (the first refused gate by id, and every one in `gates`), or else the
   * error one of its jobs threw.
   */
  failure(): { readonly error: unknown } | undefined {
    const failed = this.failed;
    if (!failed) return undefined;
    const refusals = [...failed.refusals].sort((a, b) => (a.gate < b.gate ? -1 : 1));
    const first = refusals[0];
    if (!first) return failed.thrown;
    this.refusal ??= new CostChangedError(
      first.gate,
      first.approved,
      first.priced,
      refusals.map((e) => ({ gate: e.gate, approved: e.approved, priced: e.priced })),
    );
    return { error: this.refusal };
  }

  /** Puts a read's keys in the jobs that fetch them: an earlier job's, or its own wave's. */
  private ask(request: Request, loader: LoaderDef, open: readonly LoaderKey[]): void {
    const claims = this.claimsOf(loader.id);
    const waiters = this.waitersOf(loader.id);
    let job: Job | undefined;
    for (const k of open) {
      const claimed = claims.get(k.id);
      if (claimed?.wave === request.wave && !claimed.stops) job = claimed;
      else if (!claimed || (claimed.wave > request.wave && !claimed.stops)) {
        // a later wave's key is fetched by this one's: that wave finds it answered
        claimed?.keys.delete(k.id);
        job ??= this.jobOf(loader, request.wave);
        job.keys.set(k.id, k);
        claims.set(k.id, job);
      }
      // otherwise an earlier job, or one already running, fetches it
      const waiting = waiters.get(k.id);
      if (waiting) waiting.push(request);
      else waiters.set(k.id, [request]);
    }
    if (job && !job.requests.includes(request)) job.requests.push(request);
    this.kick();
  }

  /** The job of `loader` in `wave`, placed in wave order after the one running. */
  private jobOf(loader: LoaderDef, wave: number): Job {
    const queue = this.queues.get(loader.id) ?? [];
    this.queues.set(loader.id, queue);
    const found = queue.find((j) => j.wave === wave && !j.stops);
    if (found) return found;
    const job: Job = { loader, wave, keys: new Map(), requests: [] };
    const after = queue.findIndex((j) => !j.stops && j.wave > wave);
    queue.splice(after < 0 ? queue.length : after, 0, job);
    return job;
  }

  /** Starts the jobs nothing holds back, once every pending microtask has run: by then each step
   *  a job's answers unblocked has asked for its next read. With no job waiting and no refusal to
   *  settle, there is nothing to start: a new read kicks again, and a run that is over holds no
   *  timer. */
  private kick(): void {
    if (this.scheduled) return;
    if (!this.failed && ![...this.queues.values()].some((queue) => queue.length > 0)) return;
    this.scheduled = true;
    afterMicrotasks(() => {
      this.scheduled = false;
      this.start();
    });
  }

  private start(): void {
    // once the run stopped, every job answers at once: nothing is worth waiting for
    const stopped = this.env.stop.stopped();
    for (const [loader, queue] of this.queues) {
      // a job whose keys an earlier wave took has nothing left to fetch
      while (queue[0] && !queue[0].stops && queue[0].keys.size === 0) queue.shift();
      const job = queue[0];
      if (!job || job.stops) continue;
      if (!stopped && this.failed && job.wave > this.failed.wave) continue;
      if (!stopped && !this.schedule.clear(loader, job.wave)) continue;
      // a job that throws past its own catch is a bug of the run's: it fails the run, not the
      // process
      this.run(job).catch(this.env.stop.halt.bind(this.env.stop));
    }
    const failed = this.failed;
    if (failed && !stopped && this.quiet(failed.wave)) {
      const failure = this.failure();
      if (failure) this.env.stop.halt(failure.error);
    }
  }

  /** Whether nothing more of `wave` or before can happen: no job of those waves left, no work
   *  behind it. */
  private quiet(wave: number): boolean {
    for (const queue of this.queues.values())
      for (const job of queue)
        if (job.wave <= wave && (job.stops || job.keys.size > 0)) return false;
    return !this.schedule.before(wave);
  }

  /** One job: its keys, those the steps waiting for their inputs offer, fetched together. */
  private async run(job: Job): Promise<void> {
    const { loader, wave } = job;
    // once the run stopped, nothing starts: the keys are unknown, deadline, and no job ran
    if (this.env.stop.stopped()) {
      const settled = this.settledOf(loader.id);
      for (const id of job.keys.keys()) settled.set(id, DEADLINE);
      this.done(job);
      return;
    }
    // what a call of the job throws that fails the run stops the wave's loads at once (calls.ts)
    const stops: Stops = { job: this.env.stop.part((error) => this.fail(wave, { error })) };
    job.stops = stops;
    const settled = this.settledOf(loader.id);
    const asking = job.requests.filter((r) => r.keys.some((k) => job.keys.has(k.id)));
    const steps = new Set(asking.map((r) => r.step));
    const claims = this.claimsOf(loader.id);
    for (const offer of this.offered(loader.id, wave)) {
      const { id } = offer.key;
      const claimed = claims.get(id);
      if (settled.has(id) || (claimed && (claimed.wave <= wave || claimed.stops))) continue;
      claimed?.keys.delete(id);
      job.keys.set(id, offer.key);
      claims.set(id, job);
      steps.add(offer.step);
    }
    this.started += 1;
    this.latest = Math.max(this.latest, wave);
    const step = [...steps].sort();
    let thrown: { readonly error: unknown } | undefined;
    // every attribute a job's span ends with is there from the start, at 0 when nothing came to it
    const span = this.env.tracer.startSpan(
      "hopgraph.batch",
      {
        "hopgraph.loader": loader.id,
        "hopgraph.wave": wave,
        "hopgraph.steps": step,
        "hopgraph.keys": job.keys.size,
        "hopgraph.waited_ms": this.env.now() - Math.min(...asking.map((r) => r.at)),
        ...ZERO,
      },
      this.env.span,
    );
    try {
      const keys = [...job.keys.values()];
      const done = await this.jobs.run(loader, wave, keys, step.join(" + "), settled, stops, span);
      // whatever stopped the job, each of its keys has an answer
      for (const k of keys) if (!settled.has(k.id)) settled.set(k.id, FAILED);
      // a key loaded is loaded for the step with the smallest id that asked for it
      const owner = new Map<string, string>();
      for (const r of asking)
        for (const k of r.keys) {
          const first = owner.get(k.id);
          if (job.keys.has(k.id) && (first === undefined || r.step < first))
            owner.set(k.id, r.step);
        }
      for (const r of asking)
        r.loaded = new Set(
          r.keys.filter((k) => owner.get(k.id) === r.step && !done.hits.has(k.id)).map((k) => k.id),
        );
      const payer = [...asking].sort(byStep)[0];
      if (payer) payer.paid = done;
      outcomes(span, keys, settled);
      span.setAttribute("hopgraph.billed_bytes", done.billed);
      span.setAttribute("hopgraph.retries", done.retries);
    } catch (error) {
      // the run fails, once the waves before this one are done (the header); meanwhile the steps
      // waiting for these keys go on with them failed
      this.fail(wave, { error, by: `${step[0] ?? ""}␟${loader.id}` });
      thrown = { error };
    } finally {
      // the reads waiting for these keys go on before anything is told to the span, whatever
      // telling it does
      this.done(job);
      if (thrown) span.recordError(described(thrown.error));
      span.end();
    }
  }

  /** The job is over: the reads waiting only for its keys get their answers, in an order the
   *  inputs decide. */
  private done(job: Job): void {
    const loader = job.loader.id;
    const queue = this.queues.get(loader) ?? [];
    const at = queue.indexOf(job);
    if (at >= 0) queue.splice(at, 1);
    const settled = this.settledOf(loader);
    const claims = this.claimsOf(loader);
    const waiters = this.waitersOf(loader);
    const finished = new Set<Request>();
    for (const id of job.keys.keys()) {
      if (claims.get(id) === job) claims.delete(id);
      if (!settled.has(id)) settled.set(id, FAILED);
      for (const r of waiters.get(id) ?? []) {
        r.outstanding -= 1;
        if (r.outstanding === 0) finished.add(r);
      }
      waiters.delete(id);
    }
    for (const r of [...finished].sort(byStep)) {
      this.schedule.leave(r.behind);
      r.resolve(this.servedOf(r.keys, settled, r.loaded, r.paid));
    }
    this.kick();
  }

  /** What a read is told: its keys answered without being loaded for it, and its job's bill when
   *  it pays for it. */
  private servedOf(
    keys: readonly LoaderKey[],
    settled: ReadonlyMap<string, KeyAnswer>,
    loaded: ReadonlySet<string>,
    paid: Omit<Done, "hits">,
  ): Served {
    return {
      cached: keys.filter((k) => settled.get(k.id)?.kind !== "unknown" && !loaded.has(k.id)).length,
      loaded,
      billedBytes: paid.billed,
      errors: paid.errors,
      retries: paid.retries,
    };
  }

  /**
   * The run fails in `wave`: an approval refused there, or an error a job of it threw. The first
   * failure stops the jobs of later waves and the loads of its own; the jobs before it go on, and
   * the dry runs of its wave end, so that every job of its wave is priced (the header). A failure
   * in an earlier wave than the first replaces what failed after it. A thrown error is heard twice:
   * where it is thrown, to stop what must not start, then by its job (`by`: its smallest step and
   * its loader), which records it; of the errors of one wave, the run fails with the smallest `by`.
   */
  private fail(
    wave: number,
    failure:
      | { readonly refusal: CostChangedError }
      | { readonly error: unknown; readonly by?: string },
  ): void {
    if (this.failed && wave > this.failed.wave) return;
    if (!this.failed || wave < this.failed.wave) {
      const reason = "refusal" in failure ? failure.refusal : failure.error;
      this.failed = { wave, refusals: [] };
      for (const queue of this.queues.values())
        for (const job of queue) {
          if (job.wave > wave) job.stops?.job.halt(reason);
          if (job.wave === wave) job.stops?.loads?.halt(reason);
        }
    }
    if ("refusal" in failure) this.failed.refusals.push(failure.refusal);
    else if (failure.by === undefined) return;
    else if (this.failed.thrown === undefined || failure.by < this.failed.thrown.by)
      this.failed.thrown = { error: failure.error, by: failure.by };
  }

  /** What steps offer to a job of `loader` in `wave`. A loader's jobs run in wave order, so an
   *  offer whose step started before this wave is spent. */
  private offered(loader: string, wave: number): Offer[] {
    const live = (this.offers.get(loader) ?? []).filter(
      (o) => o.until === undefined || o.until >= wave,
    );
    this.offers.set(loader, live);
    return live.filter((o) => o.after < wave);
  }

  /** The loader key of a ref, and its cache entry. */
  private loaderKey(loader: LoaderDef, ref: RefNode, stepNeeds: readonly string[]): LoaderKey {
    return this.keyReading(
      loader,
      ref,
      this.env.refs.values(ref, loader.needs, loader.hints, stepNeeds),
    );
  }

  /** The loader key of a ref that reads `read` besides its key. */
  private keyReading(loader: LoaderDef, ref: RefNode, read: Attrs): LoaderKey {
    const values = stableJson(read);
    return {
      id: `${ref.keyId}␟${values}`,
      ref,
      view: { ...read, key: ref.key },
      read: values,
      entry: answerKey(loader, ref.keyId, values, this.dataOf(loader), this.env.restriction),
    };
  }

  /** The json of the loader's declared ctx values that are data: the run's ctx does not change. */
  private dataOf(loader: LoaderDef): string {
    let data = this.data.get(loader.id);
    if (data === undefined) {
      const ctx = ctxFor(this.env.ctx, loader.ctxKeys);
      data = stableJson(Object.fromEntries(Object.entries(ctx).filter(([, v]) => isData(v))));
      this.data.set(loader.id, data);
    }
    return data;
  }

  /** Why this viewer may not read the loader, if not: `allOf` needs every connector, `oneOf`
   *  one. */
  private unread(loader: LoaderDef): UnknownReason | undefined {
    const { connectors } = loader;
    const names = "allOf" in connectors ? connectors.allOf : connectors.oneOf;
    const refused = names.flatMap((name) => {
      const readable = this.readableOf(name);
      return readable === true ? [] : [{ name, why: readable }];
    });
    const blocked = "allOf" in connectors ? refused.length > 0 : refused.length === names.length;
    const first = refused[0];
    if (!blocked || !first) return undefined;
    return { reason: "unread", why: first.why, connectors: refused.map((r) => r.name) };
  }

  /** The connectors a load holds a slot on: every one for `allOf`, the readable ones for
   *  `oneOf`. */
  private held(loader: LoaderDef): readonly string[] {
    const { connectors } = loader;
    return "allOf" in connectors
      ? connectors.allOf
      : connectors.oneOf.filter((name) => this.readableOf(name) === true);
  }

  private readableOf(connector: string): true | Unread {
    let readable = this.readability.get(connector);
    if (readable === undefined) {
      readable = this.env.readable(connector);
      this.readability.set(connector, readable);
    }
    return readable;
  }

  private settledOf(loader: string): Map<string, KeyAnswer> {
    return inner(this.settled, loader);
  }

  private claimsOf(loader: string): Map<string, Job> {
    return inner(this.claims, loader);
  }

  private waitersOf(loader: string): Map<string, Request[]> {
    return inner(this.waiters, loader);
  }
}

/** The inner map under `key`, created on first use. */
function inner<V>(outer: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let m = outer.get(key);
  if (!m) {
    m = new Map();
    outer.set(key, m);
  }
  return m;
}

/** Reads in an order the inputs decide: by wave, then by step. */
function byStep(a: Request, b: Request): number {
  if (a.wave !== b.wave) return a.wave - b.wave;
  return a.step < b.step ? -1 : a.step > b.step ? 1 : 0;
}

/** What a job's keys came to, on its span. */
function outcomes(span: Span, keys: readonly LoaderKey[], settled: ReadonlyMap<string, KeyAnswer>) {
  const count = { found: 0, absent: 0, unknown: 0 };
  for (const k of keys) count[settled.get(k.id)?.kind ?? "unknown"] += 1;
  span.setAttribute("hopgraph.found", count.found);
  span.setAttribute("hopgraph.absent", count.absent);
  span.setAttribute("hopgraph.unknown", count.unknown);
}

/**
 * Runs `next` once every pending microtask has run: by then each step a job's answers unblocked
 * has asked for its next read (everything between two reads is microtasks, or work a lane declares
 * `busy`).
 */
function afterMicrotasks(next: () => void): void {
  if (typeof setImmediate === "function") setImmediate(next);
  else setTimeout(next, 0);
}

function everyRef(refs: readonly RefNode[], answer: KeyAnswer): ReadResult {
  return { answers: new Map(refs.map((ref) => [ref.id, answer])), ...NOTHING };
}
