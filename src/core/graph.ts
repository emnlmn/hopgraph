// The graph builder (DESIGN.md §3, §3.5, §4, §7). An application declares its entities once, then
// one statement per loader, hydrator, relation and provider, and gives its routes to `g.graph()`,
// whose type then carries every (base, provider) pair a route joins. Local properties are checked
// by the compiler at the call site; global ones (coverage of every base and provider, stale
// exemptions, unused loaders) by `checkGraph` in the application's graph test.

import { routeProblems } from "./check.ts";
import { DefinitionError } from "./errors.ts";
import type { Budget, Coverage, Envelope, Kept, Retention } from "./outcome.ts";
import type { Schema, StandardSchemaV1 } from "./standard.ts";

/** Attributes by name: what a ref carries, a link holds, a row's fields are. */
export type Attrs = Readonly<Record<string, unknown>>;
type Empty = Record<never, never>;

// ---------------------------------------------------------------- entities

/** What every entity is, whatever its key and attributes. */
export interface EntityBase {
  /** "entity" */
  readonly kind: "entity";
  /** whether its key is personal: a result shows it only as `digest(entity, keyId)` */
  readonly personal: boolean;
}

/** An entity as `entity()` declares it: its key of type `K`, the attributes `C` a ref of it may
 *  carry, and `X`, those of them only a base row or a link brings (`context`; none unless given,
 *  so an entity written `Entity<K, C>` has no context, and one with context is not one). `KIn`
 *  is what the key's schema accepts, `K` unless it says otherwise (a schema that parses `"5"` to
 *  5): a base row gives that, and the run hands loads, links and results the parsed `K`. */
export interface Entity<K, C extends Attrs, X extends keyof C & string = never, KIn = K>
  extends EntityBase {
  /** the key's schema: base rows' keys and links' targets are checked against it */
  readonly key: StandardSchemaV1<KIn, K>;
  /** stable text of a key: cache entries, maps, the trace's digest */
  readonly id: (key: K) => string;
  /** attributes a ref may carry besides its key, produced by the entity's hydrator or by the link
   *  that found it */
  readonly carries: { readonly [A in keyof C]: Schema<C[A]> };
  /** carried attributes that only the base row or the reaching link brings (a window around the
   *  referring track's date): never hydrated, so the graph check asks no hydrator for them, and a
   *  base row read by `read` must bring them */
  readonly context: readonly X[];
}

type IdInput<K> = [K] extends [string | number]
  ? { readonly id?: (key: K) => string }
  : { readonly id: (key: K) => string };

/** An entity: its key schema, its carried attributes, whether its key is personal (then the trace
 *  shows a digest, never the value). A key that is not a string or a number needs `id`. */
export function entity<
  K,
  C extends Attrs = Empty,
  const X extends keyof C & string = never,
  KIn = K,
>(
  spec: {
    readonly key: StandardSchemaV1<KIn, K>;
    readonly personal?: boolean;
    readonly carries?: { readonly [A in keyof C]: Schema<C[A]> };
    readonly context?: readonly X[];
  } & IdInput<K>,
): Entity<K, C, X, KIn> {
  return {
    kind: "entity",
    key: spec.key,
    id: spec.id ?? String,
    personal: spec.personal ?? false,
    carries: spec.carries ?? ({} as { readonly [A in keyof C]: Schema<C[A]> }),
    context: spec.context ?? [],
  };
}

/** A graph's entities, by name, as `hopgraph().entities({...})` takes them. */
export type Entities = Readonly<Record<string, EntityBase>>;

/** The key type of entity `N` among the entities `E` of a graph: what its key's schema parses to,
 *  as loads, links and results see it. */
export type KeyOf<E extends Entities, N extends keyof E> =
  E[N] extends Entity<infer K, infer _C, infer _X, infer _KIn> ? K : never;
/** What a base row of entity `N` gives as its key: what its key's schema accepts, when the schema
 *  says (`z.string().transform(Number)`: a string); the key type when it says `unknown`, as a
 *  `Schema<T>` does, so that a key is still checked. */
export type KeyInputOf<E extends Entities, N extends keyof E> =
  E[N] extends Entity<infer K, infer _C, infer _X, infer KIn> ? KeyInput<K, KIn> : never;

/** What a key's schema accepts, `K` when it says `unknown`. */
export type KeyInput<K, KIn> = unknown extends KIn ? K : KIn;
/** The attributes a ref of entity `N` may carry, by name. */
export type CarriedOf<E extends Entities, N extends keyof E> =
  E[N] extends Entity<infer _K, infer C, infer _X, infer _KIn> ? C : never;
/** The carried attributes of entity `N` only a base row or a link brings (its `context`). */
export type ContextOf<E extends Entities, N extends keyof E> =
  E[N] extends Entity<infer _K, infer _C, infer X, infer _KIn> ? X : never;

/**
 * A base row of entity `N` as `g.ref` makes it: its entity's name kept as a literal, so that a run
 * checks its providers against the routes from it.
 */
export interface TypedRef<N extends string> {
  /** the row's id in the result: its key's id unless given */
  readonly row: string;
  /** the entity the row is of */
  readonly entity: N;
  /** the row's key */
  readonly key: unknown;
  /** carried attributes the row already knows */
  readonly carries?: Attrs;
}

/** What `g.ref` takes after the key: the carried attributes, every context one required (none
 *  when the entity has no context), then the row's id. */
type RefRest<E extends Entities, N extends keyof E> = [ContextOf<E, N>] extends [never]
  ? [carries?: Partial<CarriedOf<E, N>>, row?: string]
  : [
      carries: { readonly [A in ContextOf<E, N>]: CarriedOf<E, N>[A] } & Partial<CarriedOf<E, N>>,
      row?: string,
    ];

/** A ref as a load or a projection sees it: the key, the declared needs (present), and the
 *  declared hints (optional: there when the base row or the link brought them, never hydrated,
 *  never a reason to be unknown). */
export type Ref<K, Needs extends Attrs, Hints extends Attrs = Empty> = { readonly key: K } & {
  readonly [A in keyof Needs]-?: Exclude<Needs[A], undefined>;
} & { readonly [A in keyof Hints]?: Hints[A] };

// ---------------------------------------------------------------- loaders

/** The connectors a loader reads through, and when it may run: `allOf` when every one is readable
 *  (a query that joins two stores), `oneOf` when one is (replicas, mirrors: the load reads the
 *  readable ones). */
export type Connectors<C extends string> =
  /** available only when every one is readable */
  | { readonly allOf: readonly [C, ...C[]] }
  /** available when one is readable */
  | { readonly oneOf: readonly [C, ...C[]] };

/** How a loader cuts its keys into calls. */
export type Batch =
  /** row stores: N keys per statement */
  | { readonly by: "keys"; readonly max: number }
  /** warehouses billed by bytes scanned: one job over the union of the keys' partitions */
  | { readonly by: "partition" }
  /** APIs without a batch endpoint: one key per call, bounded concurrency */
  | { readonly by: "one"; readonly concurrency: number };

/** A paid source: under `auto` bytes it runs, up to `approve` it waits for approval, above it the
 *  keys are unknown, too heavy. */
export interface Metered {
  /** `auto`: the most bytes a job runs without approval; `approve`: the most a person may
   *  approve */
  readonly metered: { readonly auto: number; readonly approve: number };
}

/**
 * How a call of the loader (a load or a dry run) is tried again after it threw an error the run
 * calls retryable (`RunOptions.retryable`). The wait before retry n is a random time up to
 * `initialMs × factor^(n-1)`, at most `maxMs` (full jitter), and never ends past the run's deadline.
 */
export interface Retry {
  /** the most attempts of one call, the first included: 3 is the call and two retries */
  readonly attempts: number;
  /** the bound of the wait before the first retry, in ms (100) */
  readonly initialMs?: number;
  /** the largest bound of a wait, in ms (10 000) */
  readonly maxMs?: number;
  /** each bound is this many times the one before (2) */
  readonly factor?: number;
  /** "full" (the default): each wait is a random time up to its bound; "none": the bound */
  readonly jitter?: "full" | "none";
}

/** What every loader is, whatever its types: its declaration, defaults filled in. */
export interface LoaderBase {
  /** "loader" */
  readonly kind: "loader";
  /** unique in the graph; the head of its cache entries and gate ids */
  readonly id: string;
  /** part of every cache key: bump it when the value's shape or meaning changes */
  readonly version: number;
  /** the entity whose keys it reads */
  readonly keyedBy: string;
  /** carried attributes the load reads besides the key */
  readonly needs: readonly string[];
  /** carried attributes the load reads when present */
  readonly hints: readonly string[];
  /** the run values the load reads (its `ctx`) */
  readonly ctxKeys: readonly string[];
  /** the connectors it reads through */
  readonly connectors: Connectors<string>;
  /** how its keys are cut into calls */
  readonly batch: Batch;
  /** its caps when its source bills; none for a free source */
  readonly cost: Metered | undefined;
  /** one failed statement: keep the keys that answered, or void the batch */
  readonly partial: "keep" | "drop";
  /** how long the cache keeps an answer */
  readonly keep: (o: Kept) => Retention;
  /** no policy: a call is made once */
  readonly retry: Retry | undefined;
}

/** A loader as `g.loader()` returns it: keyed by entity `N` of key `K`, its value `V`, the needs,
 *  run values and hints its load reads. Strategies, verifications, hydrators and providers name
 *  it. */
export interface Loader<
  N extends string,
  K,
  V,
  Needs extends Attrs,
  CtxPart,
  Hints extends Attrs = Empty,
> extends LoaderBase {
  /** the entity whose keys it reads */
  readonly keyedBy: N;
  /** the dry run of a metered loader: the bytes loading these refs would bill */
  readonly price:
    | ((
        refs: readonly Ref<K, Needs, Hints>[],
        ctx: CtxPart,
        signal: AbortSignal,
      ) => Promise<number>)
    | undefined;
  /** reads the refs' keys and says, per key, what it found */
  readonly load: (
    refs: readonly Ref<K, Needs, Hints>[],
    ctx: CtxPart,
    budget: Budget,
    signal: AbortSignal,
  ) => Promise<Envelope<K, V>>;
}

/** What `g.loader()` takes: a loader's declaration, typed by the graph's entities, run values and
 *  connectors. README, "Loaders", walks through it. */
export type LoaderInput<
  N extends string,
  K,
  V,
  C extends Attrs,
  NeedK extends keyof C,
  HintK extends keyof C,
  Ctx,
  CtxK extends keyof Ctx,
  Conn extends string,
> = {
  /** unique in the graph; the head of its cache entries and gate ids */
  readonly id: string;
  /** part of every cache key: bump it when the value's shape or meaning changes. Default: 1 */
  readonly version?: number;
  /** the entity whose keys it reads */
  readonly keyedBy: N;
  /** carried attributes of `keyedBy` the load reads besides the key (a ref's date for its
   *  window) */
  readonly needs?: readonly NeedK[];
  /** carried attributes it reads when present (an id's type, when the base row gave it): part
   *  of its key like needs, but optional */
  readonly hints?: readonly HintK[];
  /** run values the load reads (`today`) */
  readonly ctx?: readonly CtxK[];
  /** the connectors it reads through, by which a run switches it off (`readable`), limits it and
   *  watches its health. Required: a loader with none would escape all of them */
  readonly connectors: Connectors<Conn>;
  /** how its keys are cut into calls: the one choice that depends on the source, so it has no
   *  default */
  readonly batch: Batch;
  /** how long the cache keeps an answer, decided on its outcome. Default: a whole found answer
   *  for a `day`, an absent or a cut one `brief`ly */
  readonly keep?: (o: Kept) => Retention;
  /** one failed statement: keep the keys that answered (the default), or void the batch */
  readonly partial?: "keep" | "drop";
  /** how a call that threw a retryable error is tried again; none: it is made once. A metered
   *  loader's retries draw on its wave's budget like its calls do */
  readonly retry?: Retry;
  /**
   * Reads the refs' keys. `signal` aborts when the run no longer waits for the answer (its caller
   * aborted it, its deadline passed, or it failed): pass it to the source's client. A load that
   * ignores it is not waited for; what the source billed before it stopped is billed. One that
   * throws after its source billed says how much in the error's `billedBytes`.
   */
  readonly load: (
    refs: readonly Ref<K, Pick<C, NoInfer<NeedK>>, Pick<C, NoInfer<HintK>>>[],
    ctx: Pick<Ctx, CtxK>,
    budget: Budget,
    signal: AbortSignal,
  ) => Promise<Envelope<K, V>>;
  /**
   * Refs of one key whose needs differ (a venue reached by two tracks, each with its window),
   * read once instead of once each: `needs` gives the values of that one read (undefined: read
   * them apart), `narrow` keeps of its value what one ref's own needs select (undefined: nothing,
   * absent). A read that came back cut leaves every ref cut, `empty` when nothing of it is left:
   * what was past the cut was not read for any of them. Not for a loader with hints.
   */
  readonly merge?: {
    readonly needs: (
      refs: readonly Ref<K, Pick<C, NoInfer<NeedK>>>[],
    ) => Pick<C, NoInfer<NeedK>> | undefined;
    /** `value` is the load's value: annotate it. Typed `never` here because a `V` in a parameter
     *  makes TypeScript fix `V` before it reads it from `load` (it would infer `{}`). */
    readonly narrow: (value: never, ref: Ref<K, Pick<C, NoInfer<NeedK>>>) => NoInfer<V> | undefined;
    readonly empty: NoInfer<V>;
  };
} & (
  | { readonly cost?: undefined; readonly price?: undefined }
  | {
      readonly cost: Metered;
      /** a dry run: the bytes loading these refs would bill; `signal` as for `load` */
      readonly price: (
        refs: readonly Ref<K, Pick<C, NoInfer<NeedK>>, Pick<C, NoInfer<HintK>>>[],
        ctx: Pick<Ctx, CtxK>,
        signal: AbortSignal,
      ) => Promise<number>;
    }
);

// ---------------------------------------------------------------- relations

/** How many targets a ref of a relation's `from` may have, and how many refs a target: `N:1`, a
 *  track has one performer and a performer many tracks. A relation that says one target (`1:1`,
 *  `N:1`) and finds two for a ref answers that ref `unknown: ambiguous`. */
export type Cardinality = "1:1" | "1:N" | "N:1" | "N:N";

/** What a projection returns for one target: its key, the link's attributes, and attributes of
 *  the target it already knows (so the target needs no hydration for them). */
export type LinkOut<KT, L extends Attrs, CT extends Attrs> = {
  readonly to: KT;
  readonly carries?: Partial<CT>;
} & ([keyof L] extends [never] ? { readonly attrs?: L } : { readonly attrs: L });

/** One way a relation finds its links, as the graph keeps it: a loader keyed by the relation's
 *  `from`, and a projection of its value into links. */
export interface StrategyDef {
  /** the id of the loader it reads */
  readonly loader: string;
  /** carried attributes of the `from` ref the projection reads */
  readonly needs: readonly string[];
  /** carried attributes the projection reads when present */
  readonly hints: readonly string[];
  /** what an absence from this strategy covered, when its load does not say */
  readonly coverage: Coverage | undefined;
  /** the ref's links, from its loader's value */
  readonly project: (
    ref: Ref<unknown, Attrs>,
    value: unknown,
  ) => readonly LinkOut<unknown, Attrs, Attrs>[];
}

/** A strategy of a relation from `F` to `T`, as the strategy maker returns it. */
export interface Strategy<F extends string, T extends string> extends StrategyDef {
  /** never set: carries the relation's `from` in the type */
  readonly _from?: F;
  /** never set: carries the relation's `to` in the type */
  readonly _to?: T;
}

/** The `s` a relation's `strategies` receives: `s(loader, { needs, hints, coverage, project })`
 *  makes one strategy, its loader keyed by the relation's `from` and its projection typed. */
export type StrategyMaker<
  E extends Entities,
  F extends keyof E & string,
  T extends keyof E & string,
  L extends Attrs,
> = <
  V,
  LN extends Attrs,
  CP,
  LH extends Attrs,
  const NeedK extends keyof CarriedOf<E, F> & string = never,
  const HintK extends keyof CarriedOf<E, F> & string = never,
>(
  loader: Loader<F, KeyOf<E, F>, V, LN, CP, LH>,
  spec: {
    /** carried attributes of the `from` ref the projection reads */
    readonly needs?: readonly NeedK[];
    /** carried attributes it reads when present */
    readonly hints?: readonly HintK[];
    /** what an absence from this strategy covered */
    readonly coverage?: Coverage;
    /** the ref's links from the loader's value: a pure function, no I/O */
    readonly project: (
      ref: Ref<
        KeyOf<E, F>,
        Pick<CarriedOf<E, F>, NoInfer<NeedK>>,
        Pick<CarriedOf<E, F>, NoInfer<HintK>>
      >,
      value: V,
    ) => readonly LinkOut<KeyOf<E, T>, L, CarriedOf<E, T>>[];
  },
) => Strategy<F, T>;

/** What a verification says of a candidate link: keep it, drop it, or leave it undecided (it
 *  stays, marked ambiguous). */
export type Verdict = "keep" | "drop" | "undecided";

/** One candidate link as a verification sees it: the link, and what the verification loader said
 *  about its target (`value` only when found). */
export interface Candidate<Link, V> {
  /** the link as the strategy's projection gave it */
  readonly link: Link;
  /** what the verification loader said of the link's target */
  readonly state: "found" | "absent" | "unknown";
  /** the verification loader's value for the target, when found */
  readonly value: V | undefined;
}

/** A relation's verification, as the graph keeps it: a loader keyed by the relation's `to`, read
 *  on the candidate targets, and the rule that judges them. */
export interface VerificationDef {
  /** the id of the loader it reads */
  readonly loader: string;
  /** all the candidates of one `from` ref at once (a rule may depend on the siblings: drop the
   *  unmatched when another matched); one verdict per candidate, in order */
  readonly decide: (
    candidates: readonly Candidate<LinkOut<unknown, Attrs, Attrs>, unknown>[],
  ) => readonly Verdict[];
}

/** The `v` a relation's `verify` receives: `v(loader, decide)` makes the verification, its loader
 *  keyed by the relation's `to` and its rule typed. */
export type VerifyMaker<E extends Entities, T extends keyof E & string, L extends Attrs> = <
  V,
  LN extends Attrs,
  CP,
  LH extends Attrs,
>(
  loader: Loader<T, KeyOf<E, T>, V, LN, CP, LH>,
  decide: (
    candidates: readonly Candidate<LinkOut<KeyOf<E, T>, L, CarriedOf<E, T>>, V>[],
  ) => readonly Verdict[],
) => VerificationDef;

/** What every relation is, whatever its types. */
export interface RelationBase {
  /** "relation" */
  readonly kind: "relation";
  /** `from › to:name` */
  readonly id: string;
  /** the entity its links start at */
  readonly from: string;
  /** the entity its links reach */
  readonly to: string;
}

/** A relation as the graph keeps it. */
export interface RelationDef extends RelationBase {
  /** its name, the part of its id after the colon: what it means (`recent`, `latest`) */
  readonly name: string;
  /** how many targets a ref may have */
  readonly cardinality: Cardinality;
  /** the schema of its links' attributes */
  readonly link: Schema<unknown> | undefined;
  /** how its strategies combine: `fallback` (the next on what the one before did not find) or
   *  `union` (every one on every ref) */
  readonly combine: "fallback" | "union";
  /** its strategies, in order */
  readonly strategies: readonly StrategyDef[];
  /** its verification, when it has one */
  readonly verify: VerificationDef | undefined;
  /** the most links one ref follows (its fan-out); past it the ref is cut */
  readonly caps: { readonly links?: number };
}

/** A relation as `g.relation()` returns it, typed by its ends, its id and its link attributes:
 *  paths are built from it. */
export interface Relation<F extends string, T extends string, Id extends string, L extends Attrs>
  extends RelationDef {
  /** `from › to:name` */
  readonly id: Id;
  /** the entity its links start at */
  readonly from: F;
  /** the entity its links reach */
  readonly to: T;
  /** never set: carries the link attributes in the type */
  readonly _link?: L;
}

// ---------------------------------------------------------------- providers and fields

/** One field of a provider: what it means. */
export interface FieldSpec<T, Meta> {
  /** the application's meaning of the field: required, opaque to the library */
  readonly meta: Meta;
  /** the value's schema; kept for the application, never run (DESIGN.md §11) */
  readonly schema?: Schema<T>;
}

/** A field computed from raw fields of its own provider, as `d(inputs, compute, spec)` makes it. */
export interface DerivedField<R, T, Meta> {
  /** "derived" */
  readonly kind: "derived";
  /** the raw fields it reads */
  readonly inputs: readonly string[];
  /** its value from exactly its inputs: a pure function */
  readonly compute: (row: R) => T;
  /** the application's meaning of the field */
  readonly meta: Meta;
  /** the value's schema; never run */
  readonly schema: Schema<T> | undefined;
}

/** The `d` a provider's `derived` receives: `d(inputs, compute, spec)` makes a derived field whose
 *  function receives exactly its inputs, typed. */
export type DeriveMaker<R extends object, Meta> = <const I extends keyof R & string, T>(
  inputs: readonly I[],
  compute: (row: { readonly [P in I]: R[P] }) => T,
  spec: FieldSpec<T, Meta>,
) => DerivedField<R, T, Meta>;

/** What every provider is, whatever its types: what a run is asked for, by id or as itself. */
export interface ProviderBase {
  /** "provider" */
  readonly kind: "provider";
  /** unique in the graph: the key of its result in each row */
  readonly id: string;
  /** the entity whose keys its rows hang on: its loader's */
  readonly entity: string;
}

/**
 * What a provider's `raw` must be for rows of type `R`: every value a row holds, with its meaning.
 * The run keeps of a row the fields `raw` names, and a result types them as `R` does, so a row type
 * whose fields `raw` cannot name is refused, with why: `any` (what `JSON.parse` returns), and a
 * union of shapes (only the fields they share could be named). The rows are read from `project`
 * alone: the field specs are `NoInfer`. A row type may be an interface or a type alias.
 *
 * `any` is told by `unknown extends R`, not by the usual `0 extends 1 & R`: the rows are
 * constrained to `object` so that an interface is accepted, and the compiler reduces `1 & R` to
 * `never` for a type parameter constrained to `object`, which would let `any` through.
 */
export type RawFields<R, Meta> = unknown extends R
  ? "a provider's rows need a type: what project returns is any, annotate it"
  : IsUnion<R> extends true
    ? "a provider's rows have one shape: declare one row type with optional fields, not a union"
    : { readonly [P in keyof NoInfer<R>]-?: FieldSpec<NoInfer<R>[P], Meta> };

/**
 * What `provider()` returns for rows of type `R`: the provider, or why not, which a route or a run
 * then refuses, for rows with an index signature or a pattern of keys (an index over
 * `x_${string}`): such a key names no field, so `raw` names none of them and the run keeps none,
 * while a result would type every key of the pattern. Checked on the result, not on `raw`: a check
 * on `raw` that reads `R`'s keys makes the compiler stop reading `R` from `project`.
 */
export type NamedFields<R, P> = [UnnamedKeys<R>] extends [never]
  ? P
  : "a provider's rows have named fields, not an index signature";

/** The keys of `R` that name no one field: index signatures (`string`, `number`, `symbol`) and
 *  patterns (`x_${string}`). A record over such a key need hold none of them, so `{}` is one. */
type UnnamedKeys<R> = {
  [K in keyof R]-?: Empty extends Record<K, unknown> ? K : never;
}[keyof R];

/** Whether `T` is a union of several types. */
type IsUnion<T, U = T> = T extends unknown ? ([U] extends [T] ? false : true) : never;

/** A provider as the graph keeps it. */
export interface ProviderDef<Meta> extends ProviderBase {
  /** the id of the loader whose value it projects */
  readonly loader: string;
  /** historical: as it was when written; current: today's state, maybe changed since */
  readonly temporal: "historical" | "current";
  /** whether a key has one row or many */
  readonly rows: "one" | "many";
  /** a key's rows from its loader's value */
  readonly project: (value: unknown, key: unknown) => readonly Attrs[];
  /** the projected fields, by name, each with its meaning */
  readonly raw: Readonly<Record<string, FieldSpec<unknown, Meta>>>;
  /** the fields computed from raw ones, by name */
  readonly derived: Readonly<Record<string, DerivedField<Attrs, unknown, Meta>>>;
  /** the most rows one ref gets; past it the ref is cut */
  readonly caps: { readonly rows?: number };
}

/** A provider as `g.provider()` returns it, typed by its id, its entity, its raw fields `R` and its
 *  derived fields `D`: routes name it, and a run asked for it as itself types its rows. */
export interface Provider<Id extends string, N extends string, R extends object, D, Meta>
  extends ProviderDef<Meta> {
  /** unique in the graph: the key of its result in each row */
  readonly id: Id;
  /** the entity whose keys its rows hang on */
  readonly entity: N;
  /** never set: carries the raw fields in the type */
  readonly _row?: R;
  /** never set: carries the derived fields in the type */
  readonly _derived?: D;
}

// ---------------------------------------------------------------- routes

/** A chain of relations from entity `B` to entity `P`, as `g.path()` or `g.itself()` makes it. */
export interface Path<B extends string, P extends string> {
  /** "path" */
  readonly kind: "path";
  /** the entity it starts at */
  readonly from: B;
  /** the entity it ends at */
  readonly to: P;
  /** the ids of its relations, in order; none for `itself` */
  readonly relations: readonly string[];
}

/** What `path` returns when its relations do not chain: `route` refuses it, with this message. */
export interface PathError<Message extends string> {
  /** "path-error" */
  readonly kind: "path-error";
  /** where the chain breaks, in words */
  readonly error: Message;
}

type First<Rs> = Rs extends readonly [infer A extends RelationBase, ...unknown[]] ? A : never;
type Last<Rs> = Rs extends readonly [...unknown[], infer Z extends RelationBase] ? Z : never;
type ChainError<Rs> = Rs extends readonly [
  infer A extends RelationBase,
  infer B extends RelationBase,
  ...infer Rest extends readonly RelationBase[],
]
  ? A["to"] extends B["from"]
    ? ChainError<readonly [B, ...Rest]>
    : `${A["id"]} ends at ${A["to"]}, but ${B["id"]} starts at ${B["from"]}`
  : never;

/** Paths that share both ends, every one run on every ref, as `g.union()` makes them. */
export interface Combined<B extends string, P extends string> {
  /** "union" */
  readonly kind: "union";
  /** the entity they start at */
  readonly from: B;
  /** the entity they end at */
  readonly to: P;
  /** the paths, in order */
  readonly paths: readonly Path<B, P>[];
}

/** How a route from base `B` reaches a provider keyed by `PE`: a path or a union of paths. */
export type RouteHow<B extends string, PE extends string> = Path<B, PE> | Combined<B, PE>;

/**
 * A route as `g.route()` makes it: how rows of base `B` reach provider `P`. It declares nothing on
 * its own: `g.graph(...routes)` takes it, and the graph's type then knows that `P` is read from
 * `B`, so a run or a read that asks `P` for rows of another entity does not compile.
 */
export interface Route<B extends string, P extends ProviderBase> {
  /** "route" */
  readonly kind: "route";
  /** the entity of the base rows it starts from */
  readonly base: B;
  /** the provider it reaches */
  readonly provider: P;
  /** the paths it follows */
  readonly how: Path<string, string> | Combined<string, string>;
}

/** Any route: what a graph whose type does not list its routes is taken to have, so that it
 *  refuses no provider at compile time and leaves `HG_NO_ROUTE` to the run. */
export type AnyRoute = Route<string, ProviderBase>;

/** A route as the graph keeps it. */
export interface RouteDef {
  /** the entity of the base rows it starts from */
  readonly base: string;
  /** the id of the provider it reaches */
  readonly provider: string;
  /** the paths it follows */
  readonly how: Path<string, string> | Combined<string, string>;
}

// ---------------------------------------------------------------- the graph

/** An entity's hydrator, as the graph keeps it: the loader that gives its carried attributes. */
export interface HydratorDef {
  /** the entity it hydrates */
  readonly entity: string;
  /** the id of the loader it reads, keyed by that entity */
  readonly loader: string;
  /** the carried attributes in the loader's value */
  readonly project: (value: unknown) => Attrs;
}

/** An entity as the graph keeps it, its types erased. */
export interface EntityDef extends EntityBase {
  /** the key's schema */
  readonly key: Schema<unknown>;
  /** stable text of a key */
  readonly id: (key: unknown) => string;
  /** the schemas of the attributes a ref may carry, by name */
  readonly carries: Readonly<Record<string, Schema<unknown>>>;
  /** carried attributes only a base row or a link brings */
  readonly context: readonly string[];
}

/** `LoaderInput.merge`, erased. */
export interface LoaderMerge {
  /** the values of the one read of refs of one key whose needs differ; undefined: read apart */
  readonly needs: (refs: readonly Ref<unknown, Attrs>[]) => Attrs | undefined;
  /** what of the merged read's value one ref's own needs select; undefined: nothing, absent */
  readonly narrow: (value: unknown, ref: Ref<unknown, Attrs>) => unknown;
  /** the value of a ref a cut read left nothing of */
  readonly empty: unknown;
}

/** A loader as the graph keeps it, its types erased. */
export interface LoaderDef extends LoaderBase {
  /** how refs of one key whose needs differ are read once */
  readonly merge: LoaderMerge | undefined;
  /** the dry run of a metered loader */
  readonly price:
    | ((refs: readonly Ref<unknown, Attrs>[], ctx: unknown, signal: AbortSignal) => Promise<number>)
    | undefined;
  /** reads the refs' keys */
  readonly load: (
    refs: readonly Ref<unknown, Attrs>[],
    ctx: unknown,
    budget: Budget,
    signal: AbortSignal,
  ) => Promise<Envelope<unknown, unknown>>;
}

/** The declared graph, as the executor and the checker read it. */
export interface GraphDef<Meta> {
  /** by name */
  readonly entities: Readonly<Record<string, EntityDef>>;
  /** by id */
  readonly loaders: ReadonlyMap<string, LoaderDef>;
  /** by entity */
  readonly hydrators: ReadonlyMap<string, HydratorDef>;
  /** by id (`from › to:name`) */
  readonly relations: ReadonlyMap<string, RelationDef>;
  /** by id */
  readonly providers: ReadonlyMap<string, ProviderDef<Meta>>;
  /** in the order they were declared */
  readonly routes: readonly RouteDef[];
}

/**
 * The declared graph as `g.graph(...routes)` returns it: what the executor and the checker read,
 * and, in its type, the graph's entities, the ctx its runs carry and its routes `R`. `run` checks a
 * run's `ctx` against it and the providers asked against the routes; a runner's `read` takes the
 * entity names and key types from it too. Its routes are not widened by an assignment: a graph of
 * some routes is not one of more. The graph with its types forgotten, a `GraphDef<Meta>`, has any
 * route as far as the compiler knows, and the run refuses a missing one (`HG_NO_ROUTE`).
 */
export interface Graph<E extends Entities, Ctx, Meta, R extends AnyRoute = AnyRoute>
  extends GraphDef<Meta> {
  /** never set: carries the entities, the runs' ctx and the routes in the type. The ctx and the
   *  routes are a function's parameter and result, so that a graph is one of its own `Ctx` and
   *  routes only: one whose loads read `{ a, b }` is not a graph of `{ a }`, whose runs would give
   *  them half of it, and one of some routes is not one of more. `GraphDef<Meta>` is the graph
   *  with its types forgotten */
  readonly _types?: {
    readonly entities: E;
    readonly ctx: (ctx: Ctx) => Ctx;
    readonly routes: (routes: R) => R;
  };
}

/** One field of one provider, with its meaning: what a field picker, its search and the docs
 *  read. */
export interface CatalogEntry<Meta> {
  /** the provider's id */
  readonly provider: string;
  /** the entity the provider's rows hang on */
  readonly entity: string;
  /** the field's name */
  readonly field: string;
  /** projected from the loader, or computed from raw fields */
  readonly kind: "raw" | "derived";
  /** the raw fields a derived field reads */
  readonly inputs: readonly string[];
  /** the application's meaning of the field */
  readonly meta: Meta;
  /** the provider's: as it was when written, or as it is today */
  readonly temporal: "historical" | "current";
  /** the provider's: one row per key, or many */
  readonly rows: "one" | "many";
}

/**
 * What `hopgraph<Ctx, Meta, Conn>().entities({...})` returns: one statement per loader, hydrator,
 * relation, provider and route, each checked by the compiler at its call site (DESIGN.md §7) and
 * refused at declaration time when it contradicts itself.
 */
export interface GraphBuilder<E extends Entities, Ctx, Meta, Conn extends string> {
  /** A loader: the unit of I/O, reading one source by keys of one entity (`LoaderInput`). */
  loader<
    N extends keyof E & string,
    V,
    const NeedK extends keyof CarriedOf<E, N> & string = never,
    const CtxK extends keyof Ctx & string = never,
    const HintK extends keyof CarriedOf<E, N> & string = never,
  >(
    spec: LoaderInput<N, KeyOf<E, N>, V, CarriedOf<E, N>, NeedK, HintK, Ctx, CtxK, Conn>,
  ): Loader<
    N,
    KeyOf<E, N>,
    V,
    Pick<CarriedOf<E, N>, NeedK>,
    Pick<Ctx, CtxK>,
    Pick<CarriedOf<E, N>, HintK>
  >;

  /** The loader that produces an entity's carried attributes. It reads by key alone. */
  hydrator<N extends keyof E & string, V, CP>(
    entity: N,
    loader: Loader<N, KeyOf<E, N>, V, Empty, CP>,
    project: (value: V) => Partial<CarriedOf<E, N>>,
  ): void;

  /** A relation `from › to:name`: its strategies project loaders' values into links, combined as
   *  `fallback` or `union`, optionally verified, held to its cardinality and its caps. */
  relation<
    F extends keyof E & string,
    T extends keyof E & string,
    const Name extends string,
    L extends Attrs = Empty,
  >(
    from: F,
    to: T,
    name: Name,
    spec: {
      readonly cardinality: Cardinality;
      readonly link?: Schema<L>;
      /** required with more than one strategy */
      readonly combine?: "fallback" | "union";
      readonly strategies: (
        s: StrategyMaker<E, F, T, L>,
      ) => readonly [Strategy<F, T>, ...Strategy<F, T>[]];
      readonly verify?: (v: VerifyMaker<E, T, L>) => VerificationDef;
      /** `links`: the most links one ref follows; past it the ref keeps the first ones, cut */
      readonly caps?: { readonly links?: number };
    },
  ): Relation<F, T, `${F} › ${T}:${Name}`, L>;

  /** A provider: a loader's value projected into rows of fields, each with its `Meta`, plus the
   *  fields derived from them. */
  provider<
    const Id extends string,
    N extends keyof E & string,
    V,
    LN extends Attrs,
    CP,
    LH extends Attrs,
    R extends object,
    D extends Readonly<Record<string, DerivedField<R, unknown, Meta>>> = Empty,
  >(
    id: Id,
    spec: {
      readonly loader: Loader<N, KeyOf<E, N>, V, LN, CP, LH>;
      readonly temporal: "historical" | "current";
      readonly rows: "one" | "many";
      /** the provider's rows for one key; one element when `rows` is "one" */
      readonly project: (value: V, key: KeyOf<E, N>) => readonly R[];
      /** every projected value is a field, and every field says what it means */
      readonly raw: RawFields<R, Meta>;
      readonly derived?: (d: DeriveMaker<R, Meta>) => D & { readonly [P in keyof R]?: never };
      /** `rows`: the most rows one ref gets; past it the ref keeps the first ones, cut */
      readonly caps?: { readonly rows?: number };
    },
  ): NamedFields<R, Provider<Id, N, R, D, Meta>>;

  /** A chain of relations; the compiler refuses one that does not chain, with where it breaks. */
  path<const Rs extends readonly [RelationBase, ...RelationBase[]]>(
    ...relations: Rs
  ): [ChainError<Rs>] extends [never]
    ? Path<First<Rs>["from"], Last<Rs>["to"]>
    : PathError<ChainError<Rs>>;

  /** The base ref itself, as a path of no relation: the route of a provider keyed by the base
   *  (`route("track", streams, itself("track"))`), or one path of a union. */
  itself<B extends keyof E & string>(base: B): Path<B, B>;

  /** every path runs on every ref; links are concatenated */
  union<const Ps extends readonly [Path<string, string>, ...Path<string, string>[]]>(
    ...paths: Ps
  ): Combined<Ps[number]["from"], Ps[number]["to"]>;

  /** How rows of `base` reach `provider`: a path (`itself(base)` when the provider is keyed by
   *  the base), or a union of paths. Declares nothing until `graph(...routes)` takes it. */
  route<B extends keyof E & string, P extends ProviderBase>(
    base: B,
    provider: P,
    how: IsUnion<B> extends true
      ? "a route starts at one entity: give one route per base"
      : IsUnion<P> extends true
        ? "a route reaches one provider: give one route per provider"
        : RouteHow<NoInfer<B>, P["entity"]>,
  ): Route<B, P>;

  /**
   * A base row of `entity` for `run`, its key typed by the entity's key schema and its entity's
   * name kept, so that `refs: ids.map((id) => g.ref("track", id))` has its providers checked
   * against the routes at compile time. The carried attributes follow the key, every context one
   * required, then the row's id, which is the key's id (the entity's `id(key)`) unless given; a
   * personal key's row id is then the key, as for a runner's `read`.
   */
  ref<N extends keyof E & string>(
    entity: N,
    key: KeyInputOf<E, N>,
    ...rest: RefRest<E, N>
  ): TypedRef<N>;

  /** Every field of every provider with its meaning, for field pickers, search and docs. */
  catalog(): readonly CatalogEntry<Meta>[];
  /** The declared graph, with its routes, for `createRunner`, `run` and `checkGraph`. Its type
   *  carries every (base, provider) pair the routes join. */
  graph<Rs extends readonly Route<keyof E & string, ProviderBase>[]>(
    ...routes: Rs
  ): Graph<E, Ctx, Meta, Rs[number]>;
}

/**
 * Starts a graph. Type arguments first (no partial inference in TypeScript): `Ctx` is what a run
 * carries (`undefined` for a graph whose runs carry nothing: a run may then leave `ctx` out),
 * `Meta` what every field must say about itself, `Conn` the connector names.
 */
export function hopgraph<Ctx, Meta, Conn extends string = string>() {
  return {
    entities<const E extends Entities>(entities: E): GraphBuilder<E, Ctx, Meta, Conn> {
      return builder<Meta>(
        entities as unknown as Readonly<Record<string, EntityDef>>,
      ) as unknown as GraphBuilder<E, Ctx, Meta, Conn>;
    },
  };
}

// ---------------------------------------------------------------- implementation (erased types)

interface RelationSpecErased {
  readonly cardinality: Cardinality;
  readonly link?: Schema<unknown>;
  readonly combine?: "fallback" | "union";
  readonly strategies: (
    s: (loader: LoaderDef, spec: StrategySpecErased) => StrategyDef,
  ) => readonly StrategyDef[];
  readonly verify?: (
    v: (loader: LoaderDef, decide: VerificationDef["decide"]) => VerificationDef,
  ) => VerificationDef;
  readonly caps?: RelationDef["caps"];
}

interface StrategySpecErased {
  readonly needs?: readonly string[];
  readonly hints?: readonly string[];
  readonly coverage?: Coverage;
  readonly project: StrategyDef["project"];
}

interface ProviderSpecErased<Meta> {
  readonly loader: LoaderDef;
  readonly temporal: "historical" | "current";
  readonly rows: "one" | "many";
  readonly project: ProviderDef<Meta>["project"];
  readonly raw: Readonly<Record<string, FieldSpec<unknown, Meta>>>;
  readonly derived?: (
    d: (
      inputs: readonly string[],
      compute: (row: Attrs) => unknown,
      spec: FieldSpec<unknown, Meta>,
    ) => DerivedField<Attrs, unknown, Meta>,
  ) => Readonly<Record<string, DerivedField<Attrs, unknown, Meta>>>;
  readonly caps?: ProviderDef<Meta>["caps"];
}

type LoaderSpecErased = Omit<
  LoaderDef,
  | "kind"
  | "version"
  | "needs"
  | "hints"
  | "ctxKeys"
  | "cost"
  | "price"
  | "merge"
  | "retry"
  | "keep"
  | "partial"
> & {
  readonly version?: number;
  readonly keep?: LoaderDef["keep"];
  readonly partial?: LoaderDef["partial"];
  readonly merge?: LoaderMerge;
  readonly retry?: Retry;
  readonly needs?: readonly string[];
  readonly hints?: readonly string[];
  readonly ctx?: readonly string[];
  readonly cost?: Metered;
  readonly price?: LoaderDef["price"];
};

/** The id of a key as its schema parses it, as a run names the key: of the key given when the
 *  schema answers later (asynchronously) or refuses it, which the run then names by its row. */
function parsedId(def: EntityDef, key: unknown): string {
  const parsed = def.key["~standard"].validate(key);
  return def.id("value" in parsed ? parsed.value : key);
}

function builder<Meta>(entities: Readonly<Record<string, EntityDef>>) {
  const loaders = new Map<string, LoaderDef>();
  const hydrators = new Map<string, HydratorDef>();
  const relations = new Map<string, RelationDef>();
  const providers = new Map<string, ProviderDef<Meta>>();

  const hasEntity = (name: string, where: string) => {
    if (!Object.hasOwn(entities, name))
      throw new DefinitionError("HG_UNKNOWN_ENTITY", `${where}: no entity "${name}"`);
  };
  const known = (loader: LoaderDef, where: string) => {
    if (loaders.get(loader.id) !== loader)
      throw new DefinitionError(
        "HG_FOREIGN",
        `${where}: loader "${loader.id}" was not declared on this graph`,
      );
  };
  // a loader of this graph that reads by `entity`, as a hydrator, a strategy or a verification takes
  const keyedBy = (loader: LoaderDef, entity: string, where: string) => {
    known(loader, where);
    if (loader.keyedBy !== entity)
      throw new DefinitionError(
        "HG_KEYED_BY",
        `${where}: loader "${loader.id}" is keyed by "${loader.keyedBy}"`,
      );
  };
  // a route as `route` makes it, checked where it is made and again where `graph` takes it: one
  // from plain JavaScript or another graph is refused there too
  const routeDef = (value: unknown): RouteDef => {
    const r = (value ?? {}) as Partial<Route<string, ProviderDef<Meta>>>;
    if (r.kind !== "route" || typeof r.base !== "string" || !r.provider)
      throw new DefinitionError(
        "HG_SPEC",
        "graph: a route is made by g.route(base, provider, how)",
      );
    const { base, provider, how } = r;
    hasEntity(base, `route from "${base}"`);
    if (providers.get(provider.id) !== provider)
      throw new DefinitionError(
        "HG_FOREIGN",
        `route from "${base}": provider "${provider.id}" was not declared on this graph`,
      );
    if (!isRouteHow(how))
      throw new DefinitionError(
        "HG_SPEC",
        `route "${base}" › "${provider.id}": how must be g.path(...), g.itself(base) or g.union(...)`,
      );
    const route: RouteDef = { base, provider: provider.id, how };
    // the types check the chain; a route from a cast or plain JavaScript is checked here
    const [problem] = routeProblems(route, base, provider.entity, relations);
    if (problem) throw new DefinitionError(problem.code, problem.message);
    return route;
  };

  return {
    loader(spec: LoaderSpecErased): LoaderDef {
      hasEntity(spec.keyedBy, `loader "${spec.id}"`);
      if (loaders.has(spec.id))
        throw new DefinitionError("HG_DUPLICATE", `loader "${spec.id}" is declared twice`);
      checkLoaderSpec(spec);
      const def: LoaderDef = {
        kind: "loader",
        id: spec.id,
        version: spec.version ?? 1,
        keyedBy: spec.keyedBy,
        needs: spec.needs ?? [],
        hints: spec.hints ?? [],
        ctxKeys: spec.ctx ?? [],
        connectors: spec.connectors,
        batch: spec.batch,
        cost: spec.cost,
        partial: spec.partial ?? "keep",
        keep: spec.keep ?? keepByOutcome,
        price: spec.price,
        load: spec.load,
        merge: spec.merge,
        retry: spec.retry,
      };
      loaders.set(def.id, def);
      return def;
    },

    hydrator(entity: string, loader: LoaderDef, project: HydratorDef["project"]): void {
      hasEntity(entity, "hydrator");
      keyedBy(loader, entity, `hydrator of "${entity}"`);
      if (hydrators.has(entity))
        throw new DefinitionError("HG_DUPLICATE", `entity "${entity}" has two hydrators`);
      hydrators.set(entity, { entity, loader: loader.id, project });
    },

    relation(from: string, to: string, name: string, spec: RelationSpecErased): RelationDef {
      const id = `${from} › ${to}:${name}`;
      hasEntity(from, `relation "${id}"`);
      hasEntity(to, `relation "${id}"`);
      if (relations.has(id))
        throw new DefinitionError("HG_DUPLICATE", `relation "${id}" is declared twice`);
      const strategies = spec.strategies((loader, s) => {
        keyedBy(loader, from, `relation "${id}"`);
        return {
          loader: loader.id,
          needs: s.needs ?? [],
          hints: s.hints ?? [],
          coverage: s.coverage,
          project: s.project,
        };
      });
      if (strategies.length === 0)
        throw new DefinitionError("HG_SPEC", `relation "${id}" has no strategy`);
      if (strategies.length > 1 && !spec.combine)
        throw new DefinitionError(
          "HG_SPEC",
          `relation "${id}" has ${strategies.length} strategies: say combine`,
        );
      const verify = spec.verify?.((loader, decide) => {
        keyedBy(loader, to, `verification of "${id}"`);
        return { loader: loader.id, decide };
      });
      const def: RelationDef = {
        kind: "relation",
        id,
        from,
        to,
        name,
        cardinality: spec.cardinality,
        link: spec.link,
        combine: spec.combine ?? "fallback",
        strategies,
        verify,
        caps: checkCaps(`relation "${id}"`, spec.caps ?? {}),
      };
      relations.set(id, def);
      return def;
    },

    provider(id: string, spec: ProviderSpecErased<Meta>): ProviderDef<Meta> {
      known(spec.loader, `provider "${id}"`);
      if (providers.has(id))
        throw new DefinitionError("HG_DUPLICATE", `provider "${id}" is declared twice`);
      const rawNames = new Set(Object.keys(spec.raw));
      const derived =
        spec.derived?.((inputs, compute, field) => {
          for (const input of inputs)
            if (!rawNames.has(input))
              throw new DefinitionError(
                "HG_SPEC",
                `provider "${id}": a derived field reads "${input}", not a raw field`,
              );
          return { kind: "derived", inputs, compute, meta: field.meta, schema: field.schema };
        }) ?? {};
      for (const name of Object.keys(derived))
        if (rawNames.has(name))
          throw new DefinitionError(
            "HG_SPEC",
            `provider "${id}": derived field "${name}" has the name of a raw field`,
          );
      const def: ProviderDef<Meta> = {
        kind: "provider",
        id,
        entity: spec.loader.keyedBy,
        loader: spec.loader.id,
        temporal: spec.temporal,
        rows: spec.rows,
        project: spec.project,
        raw: spec.raw,
        derived,
        caps: checkCaps(`provider "${id}"`, spec.caps ?? {}),
      };
      providers.set(id, def);
      return def;
    },

    path(...rels: RelationDef[]): Path<string, string> {
      const first = rels[0];
      const last = rels[rels.length - 1];
      if (!first || !last)
        throw new DefinitionError("HG_SPEC", "a path needs at least one relation");
      return { kind: "path", from: first.from, to: last.to, relations: rels.map((r) => r.id) };
    },

    itself(base: string): Path<string, string> {
      hasEntity(base, "itself");
      return { kind: "path", from: base, to: base, relations: [] };
    },

    union(...paths: Path<string, string>[]): Combined<string, string> {
      return combined(paths);
    },

    route(base: string, provider: ProviderDef<Meta>, how: RouteDef["how"]): AnyRoute {
      const route = { kind: "route", base, provider, how } as const;
      routeDef(route);
      return route;
    },

    ref(entity: string, key: unknown, carries?: Attrs, row?: string): TypedRef<string> {
      hasEntity(entity, "ref");
      const id = row ?? parsedId(entities[entity] as EntityDef, key);
      return { row: id, entity, key, ...(carries === undefined ? {} : { carries }) };
    },

    catalog(): CatalogEntry<Meta>[] {
      return [...providers.values()].flatMap((p) => [
        ...Object.entries(p.raw).map(
          ([field, spec]): CatalogEntry<Meta> => ({
            provider: p.id,
            entity: p.entity,
            field,
            kind: "raw",
            inputs: [],
            meta: spec.meta,
            temporal: p.temporal,
            rows: p.rows,
          }),
        ),
        ...Object.entries(p.derived).map(
          ([field, d]): CatalogEntry<Meta> => ({
            provider: p.id,
            entity: p.entity,
            field,
            kind: "derived",
            inputs: d.inputs,
            meta: d.meta,
            temporal: p.temporal,
            rows: p.rows,
          }),
        ),
      ]);
    },

    graph(...given: readonly unknown[]): GraphDef<Meta> {
      const routes: RouteDef[] = [];
      for (const route of given.map(routeDef)) {
        if (routes.some((r) => r.base === route.base && r.provider === route.provider))
          throw new DefinitionError(
            "HG_DUPLICATE",
            `route "${route.base}" › "${route.provider}" is given twice`,
          );
        routes.push(route);
      }
      return { entities, loaders, hydrators, relations, providers, routes };
    },
  };
}

/**
 * The retention of a loader that declares none: a whole found answer for a day; an absent one, or
 * one a cut left short, briefly, since a key absent today may be found tonight and a cut answer is
 * not the whole one.
 */
function keepByOutcome(o: Kept): Retention {
  return o.found && !o.cut ? "day" : "brief";
}

/** A loader's spec as a run can follow it: a price for what it meters, no hints when it merges,
 *  and a retry, connectors and batch that can be held. */
function checkLoaderSpec(spec: LoaderSpecErased): void {
  if (spec.cost && !spec.price)
    throw new DefinitionError("HG_SPEC", `loader "${spec.id}" is metered without price`);
  if (spec.merge && (spec.hints?.length ?? 0) > 0)
    throw new DefinitionError(
      "HG_SPEC",
      `loader "${spec.id}" merges refs and has hints: a merge reads needs only`,
    );
  if (spec.retry) checkRetry(spec.id, spec.retry);
  checkShapes(spec.id, spec.connectors, spec.batch);
}

/** A retry policy that can be followed: at least one attempt, waits from 0 to the longest a timer
 *  waits (about 24.8 days), bounds that do not shrink. */
function checkRetry(loader: string, retry: Retry): void {
  const wrong = (what: string) =>
    new DefinitionError("HG_SPEC", `loader "${loader}": retry ${what}`);
  if (!Number.isInteger(retry.attempts) || retry.attempts < 1)
    throw wrong("attempts must be a whole number from 1");
  for (const name of ["initialMs", "maxMs"] as const) {
    const ms = retry[name];
    if (ms !== undefined && !(Number.isFinite(ms) && ms >= 0 && ms <= LONGEST_WAIT))
      throw wrong(`${name} must be a number of milliseconds from 0 to ${LONGEST_WAIT}`);
  }
  if (retry.factor !== undefined && !(Number.isFinite(retry.factor) && retry.factor >= 1))
    throw wrong("factor must be a finite number from 1");
  if (retry.jitter !== undefined && retry.jitter !== "full" && retry.jitter !== "none")
    throw wrong('jitter must be "full" or "none"');
}

/** Caps that can be held: each a whole number from 1. A cap of 0 would cut every ref, which is
 *  not reading the relation at all. */
function checkCaps<C extends Readonly<Record<string, number | undefined>>>(
  where: string,
  caps: C,
): C {
  for (const [name, cap] of Object.entries(caps))
    if (cap !== undefined && !(Number.isInteger(cap) && cap >= 1))
      throw new DefinitionError("HG_SPEC", `${where}: caps.${name} must be a whole number from 1`);
  return caps;
}

/**
 * A loader's connectors and batch as the types allow them. The types refuse any other shape, but a
 * declaration from plain JavaScript, or behind a cast, would reach the run and fail there with a
 * TypeError instead of a `DefinitionError` here.
 */
function checkShapes(loader: string, connectors: unknown, batch: unknown): void {
  // at least one: `allOf: []` would be readable whatever `readable` says and held by no limit,
  // breaker or rate; `oneOf: []` never readable
  const names = (value: unknown) =>
    Array.isArray(value) && value.length > 0 && value.every((name) => typeof name === "string");
  const keys = connectors !== null && typeof connectors === "object" ? Object.keys(connectors) : [];
  const [key] = keys;
  if (
    keys.length !== 1 ||
    (key !== "allOf" && key !== "oneOf") ||
    !names((connectors as Record<string, unknown>)[key])
  )
    throw new DefinitionError(
      "HG_SPEC",
      `loader "${loader}": connectors must be { allOf: [...] } or { oneOf: [...] }, naming one or more`,
    );
  const b = (batch ?? {}) as { by?: unknown; max?: unknown; concurrency?: unknown };
  const count = (n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 1;
  if (
    !(
      b.by === "partition" ||
      (b.by === "keys" && count(b.max)) ||
      (b.by === "one" && count(b.concurrency))
    )
  )
    throw new DefinitionError(
      "HG_SPEC",
      `loader "${loader}": batch must be { by: "keys", max }, { by: "partition" } or ` +
        `{ by: "one", concurrency }, with numbers from 1`,
    );
}

/** A route's `how` as `path`, `itself` and `union` make it. */
function isRouteHow(how: unknown): how is RouteDef["how"] {
  if (how === null || typeof how !== "object") return false;
  const h = how as { kind?: unknown; relations?: unknown; paths?: unknown };
  if (h.kind === "path") return Array.isArray(h.relations);
  return h.kind === "union" && Array.isArray(h.paths) && h.paths.every(isRouteHow);
}

/** setTimeout's largest delay. */
const LONGEST_WAIT = 2 ** 31 - 1;

function combined(paths: Path<string, string>[]): Combined<string, string> {
  const first = paths[0];
  if (!first) throw new DefinitionError("HG_SPEC", "a union needs at least one path");
  for (const p of paths)
    if (p.from !== first.from || p.to !== first.to)
      throw new DefinitionError(
        "HG_SPEC",
        `a union mixes ${first.from} › ${first.to} with ${p.from} › ${p.to}`,
      );
  return { kind: "union", from: first.from, to: first.to, paths };
}
