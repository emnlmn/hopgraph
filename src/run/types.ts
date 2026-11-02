// The executor's contract (DESIGN.md §5, §6). `run(graph, options)` reads the requested providers
// for a set of base rows along the declared routes: one job per loader per wave, a per-key cache
// shared by every consumer, paid reads priced and gated, a deadline, and an answer per base row
// that says what was found, what was searched and found absent, and what is unknown and why. Its
// options are what holds for the process (`RunEnv`) and what holds for one call (`RunCall`): a
// runner (`createRunner`) takes the first once and each call the second.

import type {
  Answer,
  AnyRoute,
  Attrs,
  Coverage,
  Cut,
  DerivedField,
  Entities,
  Entity,
  LoadError,
  Provider,
  ProviderBase,
  Retention,
  Route,
  UnknownReason,
  Unread,
} from "../core/index.ts";
import type { Inflight } from "./flights.ts";
import type { Health } from "./health.ts";
import type { Validation } from "./validate.ts";

/** One base row: an opaque id of the consumer's (several rows may share a key), its entity (one
 *  run takes rows of several bases, so a step shared by their routes is one job), its key, and the
 *  carried attributes it already knows (a row's date). */
export interface BaseRef {
  /** the caller's id of the row: the key of its answer in `RunResult.rows` */
  readonly row: string;
  /** the entity the row is of: a base of the routes asked for */
  readonly entity: string;
  /** the row's key, checked against the entity's key schema */
  readonly key: unknown;
  /** carried attributes the row already knows, checked against the entity's schemas */
  readonly carries?: Attrs;
}

/** A per-key answer as the cache keeps it: a found or absent `Answer`. An unknown is never
 *  kept. */
export type CachedAnswer = Exclude<Answer<unknown>, { readonly kind: "unknown" }>;

/**
 * The store the executor reads and writes, per key. An answer's key is
 * `hopgraph:1:answer:<loader id>:<loader version>:<sha256>`, the digest of the key id, the values
 * of the loader's needs and hints, its declared ctx data and the restriction: a load's answer is a
 * function of its key and its needs, and a need may come from the link that reached the ref (a
 * window around the referring track's date), not from the entity. The run also keeps there the
 * scope of a gate it stopped at (`hopgraph:1:gate:<gate id>`, retention `hour`), so an approval
 * covers a part of its keys on resume. The application maps a retention to a duration and owns the
 * store (memory, a key-value server, a framework's data cache).
 */
export interface CachePort {
  /** the answers the store has for these keys; a key it does not have is left out */
  getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedAnswer>>;
  /** keeps each answer under its key for the duration the application maps its retention to */
  setMany(
    entries: ReadonlyArray<{
      readonly key: string;
      readonly answer: CachedAnswer;
      readonly retention: Exclude<Retention, "none">;
    }>,
  ): Promise<void>;
}

/**
 * Bounds on what a run follows, each a whole number from 1 (README, "Caps"). A ref past one is cut
 * (`{ kind: "capped" }`), never absent. Each counts per step, so the steps of separate branches do
 * not race for one count.
 */
export interface Caps {
  /** the most refs one step reads; the others, in key order, are not read */
  readonly refs?: number;
  /** the most links one ref follows through a relation; it keeps the first. A relation's own
   *  `caps.links` applies too: the smaller wins */
  readonly links?: number;
  /** the most rows one ref gets from a provider; it keeps the first. A provider's own `caps.rows`
   *  applies too: the smaller wins */
  readonly rows?: number;
}

/** A provider a run is asked for: its id, or the provider itself, whose rows the result then
 *  types by its fields. */
export type ProviderRef = string | ProviderBase;

/** The fields of a provider's rows, raw and derived, as its declaration types them; a provider
 *  named by its id has fields of any name. */
export type FieldsOf<P> =
  P extends Provider<infer _Id, infer _N, infer R, infer D, infer _Meta>
    ? unknown extends R // rows typed any (core/graph.ts RawFields says why not `0 extends 1 & R`)
      ? Attrs
      : Flat<Readonly<R> & { readonly [F in keyof D]: DerivedValue<D[F]> }>
    : Attrs;

type DerivedValue<F> = F extends DerivedField<infer _R, infer T, infer _M> ? T : never;

/** An intersection as one object type, as an editor shows it. */
type Flat<T> = { [K in keyof T]: T[K] };

/**
 * Per requested provider, by its id, its result. A provider asked as itself has its own key and
 * typed rows: a key that is always there when the providers are a list written out (a tuple) and
 * that element is one provider, and a key that may be missing when the element may be one of
 * several (`cond ? lines : names`) or the list is an array. A provider asked by id is read by any
 * string, as a field picker reads it, and may be missing.
 */
export type ProviderResults<Ps extends readonly ProviderRef[] = readonly string[]> = {
  readonly [Q in Asked<Ps> | Extract<Ps[number], string> as Q extends ProviderBase
    ? Q["id"]
    : string]: ProviderResult<FieldsOf<Q>>;
} & {
  readonly [Q in Exclude<Extract<Ps[number], ProviderBase>, Asked<Ps>> as Q["id"]]?: ProviderResult<
    FieldsOf<Q>
  >;
};

/** The providers certainly asked: the elements of a tuple that are each one provider. */
type Asked<Ps extends readonly ProviderRef[]> = number extends Ps["length"]
  ? never
  : {
      [I in keyof Ps]: IsUnion<Ps[I]> extends false ? Extract<Ps[I], ProviderBase> : never;
    }[number];

/** Whether `T` is a union of several types. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/**
 * What holds for the process: the stores and objects every call shares, how the deployment reads
 * its sources, and how the application classifies errors and keeps time. `createRunner` takes it
 * once; `run` takes it with each call's options (`RunOptions`). Every option has a default, so an
 * empty env reads every connector, caches nothing and bounds nothing. README, "The runner", says
 * why each option is here and not in `RunCall`.
 */
export interface RunEnv {
  /** the per-key store every run shares. Default: none: every run reads its sources. A runner then
   *  keeps the scopes of the gates its runs stop at, for an hour, so that an approval covers a part
   *  of its keys on resume; `run` keeps nothing, and an approval covers its own gate id only */
  readonly cache?: CachePort;
  /** whether this deployment may read a connector; a loader whose connectors are not readable
   *  (`allOf`: every one; `oneOf`: one) is not run and its keys are unknown: unread. A call may
   *  narrow it with its own `readable`, never widen it. Default: every connector is readable */
  readonly readable?: (connector: string) => true | Unread;
  /** concurrent loads per connector, each a whole number from 1 or `Infinity`; every loader on a
   *  connector runs under its limit, and a connector without one is not bounded. Each run counts
   *  its own loads. Default: no limit */
  readonly limits?: Readonly<Record<string, number>>;
  /** bounds on what one run follows; a ref past one is cut, never absent. A call may give smaller
   *  ones: the smaller wins. Default: no bound */
  readonly caps?: Caps;
  /** the connectors' circuit breakers and rate limits, from `createHealth`: one object per
   *  process, given to every run, since a source that is down is down for every run. Default:
   *  no breaker, no rate limit */
  readonly health?: Health;
  /** the loads in flight, from `createInflight`: one object per process, given to every run. Two
   *  runs that ask the same loader key at once (the same cache entry) load it once, the second
   *  waiting for the first's answer; a run that stops waits no more, and the load goes on for the
   *  others. Default: each run loads what its cache misses */
  readonly inflight?: Inflight;
  /** where the run reports its spans: the run, each job, its dry runs, calls and cache reads and
   *  writes, with ids, counts, bytes, durations and outcomes as attributes, never a key. Default:
   *  no span */
  readonly tracer?: Tracer;
  /** the opaque text a personal key shows as in results, row steps and gate ids. Default: the
   *  SHA-256 of the entity and the key id, which hides the key from a reader but not from someone
   *  who can guess it; give a keyed HMAC, the same on every instance, for keys that can be guessed
   *  (an email address) */
  readonly digest?: (entity: string, keyId: string) => string;
  /** errors a load or a price may throw that must reject the whole run instead of failing its
   *  keys (the application's quota refusals: a spent quota is never "not read"). A
   *  `CostChangedError` always rejects the run. Default: none */
  readonly fatal?: (error: unknown) => boolean;
  /** errors a load or a dry run may throw that are worth trying again (a reset connection, a
   *  timeout, a 503): such a call is retried as its loader's `retry` says. Never asked of an error
   *  `fatal` accepts. Default: none */
  readonly retryable?: (error: unknown) => boolean;
  /** the time in epoch ms, read against the deadline. Default: `Date.now` */
  readonly clock?: () => number;
}

/**
 * What holds for one call: the base rows, the providers, the run's values, who reads, how long the
 * caller waits, and the approvals. `ctx` may be left out when the graph's `Ctx` admits `undefined`
 * (a graph built with `hopgraph<undefined, …>()`); otherwise it is required and checked against
 * the graph's `Ctx`. `Rs` is the type of the base rows: when their entities are literals, `run`
 * checks every provider against the graph's routes from each of them. README, "The runner", says
 * why each option is here and not in `RunEnv`.
 */
export type RunCall<
  Ctx,
  Ps extends readonly ProviderRef[] = readonly string[],
  Rs extends readonly BaseRef[] = readonly BaseRef[],
> = {
  /** the base rows, of one or more entities; several may share a key */
  readonly refs: Rs;
  /** the providers to read, by id or as declared (then the result types their rows); each needs a
   *  route from every base entity among `refs` */
  readonly providers: Ps;
  /** what makes one viewer's read unfit for another (their forbidden sources): part of every cache
   *  key and gate id, opaque to the library. It names what this call's `readable` forbids.
   *  Default: `""`, every viewer reads alike */
  readonly restriction?: string;
  /** whether this viewer may read a connector. Under a runner, a connector is readable when both
   *  the env and the call say so, and the env's reason comes first. Default: every connector is
   *  readable */
  readonly readable?: (connector: string) => true | Unread;
  /** bounds on what this run follows. Under a runner, where the env gives one too, the smaller
   *  wins. Default: no bound */
  readonly caps?: Caps;
  /** approved bytes per gate id, from a previous run's `gates`. An approval covers its gate's
   *  keys, and in one run any part of them at no higher price than what is left of it */
  readonly approved?: Readonly<Record<string, number>>;
  /** the prices a previous run measured (its `prices`), by gate id: a request with the same id is
   *  not priced again. Only from a run moments before over the same refs, ctx and restriction (the
   *  same run, now approved): a price that grew since is not seen, the approval caps the load. */
  readonly prices?: ReadonlyMap<string, number>;
  /** epoch ms: no load starts after it, and the loads and dry runs still running are aborted and
   *  not waited for; their keys, and those of every step not started, are unknown: deadline. The
   *  run still answers. Default: none */
  readonly deadline?: number;
  /** aborts the run: the loads and dry runs running are aborted (their signal), nothing starts,
   *  and the run rejects at once with the signal's reason, as `fetch` does */
  readonly signal?: AbortSignal;
  /**
   * Which values the run checks against their schemas, replacing each by what its schema parsed.
   * `boundaries` (the default): the base rows' keys and carried attributes before anything is read
   * (one that fails rejects the run with a `ValidationError` naming its row), and what sources say
   * through projections: links' target keys, attributes and carried attributes, and what a
   * hydrator projects (a key whose projection fails is unknown: failed, code `HG_INVALID`).
   * `strict`: also every envelope a load returns; a key it puts in two buckets is failed, and keys
   * not asked, in two buckets or missing are reported as failure codes. `off`: no schema runs.
   */
  readonly validate?: Validation;
} & (undefined extends Ctx
  ? {
      /** the run's values (`today`) and services (a client); each loader sees only the keys it
       *  declares, and only those that are data enter its cache keys. The graph's `Ctx` admits
       *  `undefined`, so it may be left out */
      readonly ctx?: Ctx;
    }
  : {
      /** the run's values (`today`) and services (a client), as the graph's `Ctx` types them;
       *  each loader sees only the keys it declares, and only those that are data enter its
       *  cache keys */
      readonly ctx: Ctx;
    });

/** What `run` is asked: what holds for the process and what holds for this call, in one object
 *  (README, "Running", gives each option with its default). */
export type RunOptions<
  Ctx,
  Ps extends readonly ProviderRef[] = readonly string[],
  Rs extends readonly BaseRef[] = readonly BaseRef[],
> = RunEnv & RunCall<Ctx, Ps, Rs>;

/**
 * The providers `Ps` as the routes `R` let them be asked for base rows of the entities `Bases`:
 * each as it is given, or, for one no route reaches from one of them, why not (`provider "credits"
 * has no route from "artist"`), which the compiler shows where it refuses the call. Bases not
 * known (`string`, rows built at run time) ask only that some route reaches the provider; an id
 * not known (`string`, a field picker's) asks nothing. The run refuses what slips through
 * (`HG_NO_ROUTE`) before it reads anything.
 */
export type RoutedProviders<Ps extends readonly ProviderRef[], R, Bases extends string> = {
  readonly [I in keyof Ps]: Routed<Ps[I], R, Bases>;
};

/** One provider asked, as it is, or why it cannot be: a message the compiler shows. An id is
 *  refused as an object whose one property is the message, since a string id and a string
 *  message would meet as `never`. */
type Routed<Q, R, Bases extends string> = [Unrouted<Q, R, Bases>] extends [never]
  ? Q
  : Q extends string
    ? { readonly [M in Why<Q, R, Bases>]: true }
    : Why<Q, R, Bases>;

type Why<Q, R, Bases extends string> = [Unrouted<Q, R, Bases>] extends ["*"]
  ? `provider "${IdOf<Q>}" has no route`
  : `provider "${IdOf<Q>}" has no route from "${Unrouted<Q, R, Bases>}"`;

/** The bases among `Bases` no route of `R` reaches provider `Q` from; `"*"`, bases not known, when
 *  no route reaches it at all. */
type Unrouted<Q, R, Bases extends string> =
  string extends IdOf<Q>
    ? never
    : string extends Bases
      ? IdOf<Q> extends Reached<R>["id"]
        ? never
        : "*"
      : Bases extends unknown
        ? IdOf<Q> extends RoutedFrom<R, Bases>["id"]
          ? never
          : Bases
        : never;

/** The providers the routes `R` reach from base `B`. A route of any base (`AnyRoute`) reaches
 *  every provider from every base. */
type RoutedFrom<R, B extends string> =
  R extends Route<infer RB, infer P> ? (B extends RB ? P : never) : never;

/** The providers some route of `R` reaches. */
type Reached<R> = R extends Route<string, infer P> ? P : never;

/** A provider's id, whether it is asked by id or as itself. */
type IdOf<Q> = Q extends ProviderBase ? Q["id"] : Q extends string ? Q : never;

/**
 * A graph and what holds for the process, made once at startup by `createRunner(graph, env)`; at
 * each call site, `read` or `run` with what holds for that call. A call narrows the env where both
 * give an option (`readable`, `caps`) and never replaces the rest: the cache, the health and the
 * loads in flight are the process's.
 */
export interface Runner<E extends Entities, Ctx, R extends AnyRoute = AnyRoute> {
  /**
   * `run(graph, options)`, its options the env's and the call's. The result types the providers
   * asked as `run` does: providers as declared give typed fields, ids a result read by any string.
   * The providers are checked against the graph's routes as `run` checks them.
   */
  readonly run: <
    const Ps extends readonly ProviderRef[] = readonly string[],
    const Rs extends readonly BaseRef[] = readonly BaseRef[],
  >(
    call: RunCall<Ctx, Ps, Rs> &
      NoInfer<{ readonly providers: RoutedProviders<Ps, R, Rs[number]["entity"]> }>,
  ) => Promise<RunResult<Ps>>;
  /**
   * Reads `providers` for keys of `entity`: one base row per key, whose id in `rows` is the key's
   * id (`String(key)` for a string or a number key, the entity's `id(key)` otherwise). The keys are
   * typed by the entity's key schema, and an entity with `context` attributes takes
   * `{ key, carries }`, since only a base row brings them. Each provider needs a route from
   * `entity`: one without does not compile, the message naming the provider and the entity, and
   * an id the compiler cannot know (`string`) is refused by the run (`HG_NO_ROUTE`), keys or none,
   * before anything is read. A key that fails its schema rejects the read with a
   * `ValidationError` naming it by its place (`keys[2]`), never by its value; one key given twice
   * with different carried attributes, with `HG_DUPLICATE`. The result is `run`'s, unknowns and
   * cuts included.
   */
  readonly read: <N extends keyof E & string, const Ps extends readonly ProviderRef[]>(
    entity: N,
    keys: ReadKeys<E, N>,
    providers: Ps & NoInfer<RoutedProviders<Ps, R, N>>,
    ...call: undefined extends Ctx ? [call?: ReadCall<Ctx>] : [call: ReadCall<Ctx>]
  ) => Promise<RunResult<Ps>>;
  /** never set: carries the routes in the type, as a function's parameter and result, so that a
   *  runner of some routes is not one of more (the methods' own types are generic, which the
   *  compiler compares loosely) */
  readonly _routes?: (routes: R) => R;
}

/**
 * One key of entity `N` as `read` takes it: the key, typed by the entity's key schema; or, for an
 * entity that declares `context` attributes (only a base row or a link brings them, never a
 * hydrator), `{ key, carries }` with every one of them, and any other carried attribute the row
 * already knows.
 */
export type ReadKey<E extends Entities, N extends keyof E> =
  E[N] extends Entity<infer K, infer C, infer X>
    ? [X] extends [never]
      ? K
      : {
          /** the key, typed by the entity's key schema */
          readonly key: K;
          /** the context attributes, required, and the other carried attributes, optional */
          readonly carries: Flat<
            { readonly [A in X]: C[A] } & { readonly [A in Exclude<keyof C, X>]?: C[A] }
          >;
        }
    : never;

/**
 * The keys `read` takes for entity `N`: one, or a list. A key that may be an array is given in a
 * list, so that one key is never read as several. None for a name that may be one of several
 * entities (`cond ? "track" : "artist"`), whose key type is not one, nor for a graph whose type does
 * not say its entities.
 */
export type ReadKeys<E extends Entities, N extends keyof E> =
  IsUnion<N> extends true
    ? never
    : [ReadKey<E, N>] extends [never]
      ? never
      : [Extract<ReadKey<E, N>, readonly unknown[]>] extends [never]
        ? // an array may still be a key of a type as wide as `unknown`, `{}` or `object`
          never[] extends ReadKey<E, N>
          ? readonly ReadKey<E, N>[]
          : ReadKey<E, N> | readonly ReadKey<E, N>[]
        : readonly ReadKey<E, N>[];

/** What `read` takes besides the entity, the keys and the providers: what holds for this call. */
export type ReadCall<Ctx> = Omit<RunCall<Ctx>, "refs" | "providers">;

/** What a span attribute holds: ids, counts, bytes, durations and outcomes, never a key or a
 *  value. */
export type SpanValue = string | number | boolean | readonly string[];

/** A span's attributes, by name (DESIGN.md §6). */
export type SpanAttributes = Readonly<Record<string, SpanValue>>;

/** One span of a run (DESIGN.md §6). */
export interface Span {
  /** sets an attribute, replacing one of the same name */
  setAttribute(name: string, value: SpanValue): void;
  /** something that happened during the span: a retry */
  addEvent(name: string, attributes?: SpanAttributes): void;
  /** a failure, by its code and its class: never its message */
  recordError(error: { readonly code: string; readonly class?: string }): void;
  /** the span is over: nothing is set on it after */
  end(): void;
}

/**
 * Where a run reports what it does, as spans: the run (`hopgraph.run`); each job, the reads of one
 * loader in one wave (`hopgraph.batch`); and under a job its cache read (`hopgraph.cache.read`),
 * its dry runs (`hopgraph.price`), its calls (`hopgraph.load`) and its cache writes
 * (`hopgraph.cache.write`). A span is a child of the one given as `parent`. Shaped so that an
 * OpenTelemetry tracer adapts in a few lines (examples/otel.ts). An error one of its methods throws
 * never reaches the run: the run goes on, and that span may lack what the call was to give it.
 */
export interface Tracer {
  /** starts a span, a child of `parent` when one is given */
  startSpan(name: string, attributes: SpanAttributes, parent?: Span): Span;
}

/** A metered read the run stopped at: its price, waiting for approval. Its id is the same for the
 *  same loader keys (the loader, its version, the restriction, the keys and what each reads),
 *  whichever steps asked, so the approval can be passed to the next run. */
export interface Gate {
  /** what an approval names: `RunOptions.approved[id]` */
  readonly id: string;
  /** the steps that asked, joined by " + ": for the person who approves, not part of the id */
  readonly step: string;
  /** the metered loader's id */
  readonly loader: string;
  /** how many loader keys it would load */
  readonly keys: number;
  /** what its dry runs priced loading them at */
  readonly bytes: number;
}

/** One link a provider row was reached through, from the base row outwards. */
export interface LinkStep {
  /** the relation's id */
  readonly relation: string;
  /** the loader of the strategy that produced the link */
  readonly strategy: string;
  /** key ids; a personal key's is its digest */
  readonly from: string;
  /** the target's key id; a personal key's is its digest */
  readonly to: string;
  /** the link's attributes, as the relation's link schema parsed them */
  readonly attrs: Attrs;
}

/** One row of a provider for one base row, typed by the provider's fields when it was asked as
 *  itself. */
export interface ProviderRow<F = Attrs> {
  /** the provider entity's key id (digest if personal) and the row's index among that key's rows */
  readonly ref: string;
  /** the row's place among its key's rows */
  readonly index: number;
  /** raw and derived fields */
  readonly fields: F;
  /** every chain of links from the base row to this ref (deduplicated per base row) */
  readonly lineage: ReadonlyArray<readonly LinkStep[]>;
}

/** A provider's answer for one base row. */
export interface ProviderResult<F = Attrs> {
  /** every row the base row reaches, each with its lineage */
  readonly rows: readonly ProviderRow<F>[];
  /** found when any row; absent when every path ran to the end, uncut, and found nothing; unknown
   *  otherwise */
  readonly outcome: "found" | "absent" | "unknown";
  /** why some branch is unknown: also on a found result, when a branch could not be read */
  readonly unknown: readonly UnknownReason[];
  /** every cut met on the way: a found result read under them is not the whole answer */
  readonly cut: readonly Cut[];
  /** what the absent branches covered */
  readonly coverage: readonly Coverage[];
}

/** What one step did for the refs reached from one base row: the material of the consumer's
 *  notes. */
export interface RowStep {
  /** a relation id, `hydrate:<entity>`, `verify:<relation id>` or `provider:<id>` */
  readonly step: string;
  /** the loader the step read */
  readonly loader: string;
  /** the key id of the ref the step read (digest if personal) */
  readonly ref: string;
  /** what the step said of the ref */
  readonly outcome: "found" | "absent" | "unknown";
  /** why, when unknown; none for a ref a step did not read for a cap, whose `cuts` say so */
  readonly reason?: UnknownReason;
  /** every cut of the ref's answer (a key may be cut in more than one way) */
  readonly cuts?: readonly Cut[];
  /** what was searched for this ref: on absent, and on found when the load reported it */
  readonly coverage?: Coverage;
  /** relation steps: the links the strategy produced for this ref, before verification */
  readonly links?: number;
}

/** The answer for one base row. */
export interface RowResult<Ps extends readonly ProviderRef[] = readonly string[]> {
  /** per requested provider, by id: its rows and outcome */
  readonly providers: ProviderResults<Ps>;
  /** what every step on the way said of every ref it read */
  readonly steps: readonly RowStep[];
}

/** Aggregated per step; per-row detail lives in `RowResult.steps`. */
export interface TraceStep {
  /** a relation id, `hydrate:<entity>`, `verify:<relation id>` or `provider:<id>` */
  readonly step: string;
  /** the loader it read */
  readonly loader: string;
  /** the keys it asked for */
  readonly keysIn: number;
  /** of those, the ones answered without being loaded for it: by the cache, another run's load
   *  or another step */
  readonly cached: number;
  /** keys found */
  readonly found: number;
  /** keys absent */
  readonly absent: number;
  /** keys unknown, by reason */
  readonly unknown: Readonly<Partial<Record<UnknownReason["reason"], number>>>;
  /** keys found or absent under a cut */
  readonly cut: number;
  /** what its loads billed, in bytes */
  readonly billedBytes: number;
  /** the time it spent reading, in ms (not part of the API's promises) */
  readonly ms: number;
  /** calls made again after a retryable failure (a load's or a dry run's), by the loader's
   *  `retry`, that answered or threw */
  readonly retries: number;
  /** the loads' failures (class or code only, never a message): what the consumer words a
   *  connector error from */
  readonly errors: readonly LoadError[];
}

/** What a run answers: per base row, its providers and steps, and the run's gates, trace and
 *  bill. */
export interface RunResult<Ps extends readonly ProviderRef[] = readonly string[]> {
  /** gated: at least one metered step waits for approval; everything else that could run, ran */
  readonly status: "complete" | "gated";
  /** the metered reads waiting for approval */
  readonly gates: readonly Gate[];
  /** by base row id */
  readonly rows: ReadonlyMap<string, RowResult<Ps>>;
  /** per step and loader: what it read and how */
  readonly trace: readonly TraceStep[];
  /** what the run's loads billed, in bytes */
  readonly billedBytes: number;
  /** every price measured or reused, by gate id: for the same run again (`RunOptions.prices`) */
  readonly prices: ReadonlyMap<string, number>;
}
