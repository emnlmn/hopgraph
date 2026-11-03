// Plays a scenario against the executor. The graph is built through the public builder; every
// source is a fake that answers from the scenario's world; and everything the run does to the
// outside is written down in order: each dry run and what it said, each call with its keys, its
// budget and how it ended, each cache read and write, and each job, as the run's tracer reports it
// when the job ends. That record is what the properties and the oracle read, so nothing here knows
// how the executor is built. A player may
// also make its sources fail now and then (`Resilience`): each call throws a transient error on
// its first attempts, every loader retries, and the runs may share a health.

import {
  type Budget,
  type CachedAnswer,
  type CachePort,
  type Combined,
  type Cut,
  type Envelope,
  entity,
  type GraphDef,
  type Health,
  hopgraph,
  type Kept,
  type LinkOut,
  type LoadReason,
  type Path,
  type ProviderDef,
  type RelationDef,
  type Retry,
  type RunResult,
  type Schema,
  type Span,
  type Tracer,
} from "hopgraph";
// not part of the package: `run` with the rule it replaced, to compare the two (scheduling.test.ts)
import { runWith } from "../../src/run/executor.ts";
import {
  type Approval,
  type BaseRow,
  behaviourOf,
  decide,
  foundValue,
  keyOf,
  type LoaderSpec,
  NOW,
  type Request,
  type Row,
  rowsOf,
  type Scenario,
  SEARCHED,
  targetsOf,
  type Value,
} from "./scenario.ts";

// ---------------------------------------------------------------- the record

export type Event =
  | {
      readonly kind: "price";
      readonly loader: string;
      readonly keys: string[];
      /** 1 for a call, 2 for its first retry… */
      readonly attempt: number;
      bytes: number | "threw";
    }
  | {
      readonly kind: "load";
      readonly loader: string;
      readonly keys: string[];
      readonly attempt: number;
      readonly budget: Budget;
      end?: LoadEnd;
    }
  | { readonly kind: "get"; readonly entries: number; readonly hits: number }
  | { readonly kind: "set"; readonly retentions: readonly string[] }
  | { readonly kind: "batch"; readonly batch: Batch };

/** A job of the run, from its span (`hopgraph.batch`), written down when it ends. */
export interface Batch {
  readonly loader: string;
  readonly wave: number;
  /** loader keys to fetch, and how many the cache, or another run's load in flight, answered */
  readonly keys: number;
  readonly hits: number;
  /** the cache lookups it made */
  readonly lookups: number;
}

export type LoadEnd =
  | { readonly kind: "done"; readonly envelope: Envelope<string, Value> }
  /** `billed`: what the error said the source billed, if it said */
  | { readonly kind: "threw"; readonly billed: number | undefined }
  | { readonly kind: "fatal" };

export type LoadEvent = Extract<Event, { kind: "load" }>;
export type PriceEvent = Extract<Event, { kind: "price" }>;

/** One run of a scenario: what it was asked, what it did, how it ended. */
export interface Played {
  readonly label: string;
  /** its place in the scenario's runs: a dry run that `grows` prices more on each */
  readonly index: number;
  readonly request: Request;
  readonly approved: Readonly<Record<string, number>>;
  readonly events: readonly Event[];
  readonly outcome:
    | { readonly kind: "result"; readonly result: RunResult }
    /** `settled`: how many events there were when the run rejected */
    | { readonly kind: "error"; readonly error: unknown; readonly settled: number };
}

/** A call that throws: it fails every key it held. It throws before its source bills, and says
 *  so. */
export class Broke extends Error {
  override name = "Broke";
  readonly billedBytes = 0;
}
/** A job that would bill more than its budget: the source refuses it before it bills, as a
 *  warehouse given a byte limit does, and does not say what it billed. */
export class OverBudget extends Error {
  override name = "OverBudget";
}
/** A transient failure (a reset connection): the run calls it retryable. The source threw before
 *  it billed, and says so. */
export class Flaky extends Error {
  override name = "Flaky";
  readonly billedBytes = 0;
}
/** What the run declares fatal: a spent quota. */
export class Fatal extends Error {
  override name = "Fatal";
}
export class PriceBroke extends Error {
  override name = "PriceBroke";
}

// ---------------------------------------------------------------- the sources

/** Sources that fail now and then, and what the runs do about it. */
export interface Resilience {
  /** how many attempts of each call of a loader throw `Flaky` before one answers */
  readonly flaky: (loader: string) => number;
  /** the policy every loader declares; the runs call `Flaky` retryable */
  readonly retry: Retry;
  /** the health every run of the player shares */
  readonly health?: Health;
}

/** What every fake source reads while a run plays: the record, the world's age, the timing, and
 *  how many times each call was attempted in this run. */
interface Stage {
  log: Event[];
  index: number;
  stale: boolean;
  inflight: number;
  pause: (ticks: number) => Promise<void>;
  resilience: Resilience | undefined;
  attempts: Map<string, number>;
}

/** The attempt this is of a call: the same loader, kind and keys again in one run is a retry. */
function attemptOf(stage: Stage, call: string): number {
  const n = (stage.attempts.get(call) ?? 0) + 1;
  stage.attempts.set(call, n);
  return n;
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A seeded order of finishing: each pause lasts a few macrotask turns more or less. */
function pacer(seed: number): (ticks: number) => Promise<void> {
  let state = seed >>> 0 || 1;
  return async (ticks) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const turns = ticks + (state >>> 30);
    for (let i = 0; i < turns; i++) await turn();
  };
}

function bytesOf(spec: LoaderSpec, keys: readonly string[], stage: Stage): number {
  const m = spec.metered;
  if (!m) return 0;
  const base = m.overhead + keys.reduce((sum, k) => sum + behaviourOf(spec, k, false).cost, 0);
  return m.price === "grows" ? base * (1 + stage.index) : base;
}

function source(spec: LoaderSpec, stage: Stage) {
  return {
    load: async (
      refs: readonly { readonly key: string }[],
      _ctx: unknown,
      budget: Budget,
    ): Promise<Envelope<string, Value>> => {
      const keys = refs.map((r) => r.key);
      const attempt = attemptOf(stage, `load ${spec.id} ${keys.join(" ")}`);
      const event: LoadEvent = {
        kind: "load",
        loader: spec.id,
        keys,
        attempt,
        budget: { ...budget },
      };
      stage.log.push(event);
      stage.inflight += 1;
      try {
        await stage.pause(spec.ticks);
        if (attempt <= (stage.resilience?.flaky(spec.id) ?? 0)) {
          event.end = { kind: "threw", billed: 0 };
          throw new Flaky();
        }
        const all = keys.map((k) => behaviourOf(spec, k, stage.stale));
        if (all.some((b) => b.kind === "fatal")) {
          event.end = { kind: "fatal" };
          throw new Fatal();
        }
        if (all.some((b) => b.kind === "throws")) {
          event.end = { kind: "threw", billed: 0 };
          throw new Broke();
        }
        const max = budget.maxBytes;
        if (max !== undefined && bytesOf(spec, keys, stage) > max) {
          event.end = { kind: "threw", billed: undefined };
          throw new OverBudget();
        }
        const envelope = envelopeOf(spec, keys, stage);
        event.end = { kind: "done", envelope };
        return envelope;
      } finally {
        stage.inflight -= 1;
      }
    },
    price: async (refs: readonly { readonly key: string }[]): Promise<number> => {
      const keys = refs.map((r) => r.key);
      const attempt = attemptOf(stage, `price ${spec.id} ${keys.join(" ")}`);
      const event: PriceEvent = { kind: "price", loader: spec.id, keys, attempt, bytes: "threw" };
      stage.log.push(event);
      await stage.pause(spec.ticks);
      if (attempt <= (stage.resilience?.flaky(spec.id) ?? 0)) throw new Flaky();
      if (spec.metered?.price === "throws") throw new PriceBroke();
      event.bytes = spec.metered?.price === "nan" ? Number.NaN : bytesOf(spec, event.keys, stage);
      return event.bytes;
    },
  };
}

function envelopeOf(
  spec: LoaderSpec,
  keys: readonly string[],
  stage: Stage,
): Envelope<string, Value> {
  const values: [string, Value][] = [];
  const absent: string[] = [];
  const unknown: [string, LoadReason][] = [];
  const cut: [string, Cut][] = [];
  const coverage: [string, typeof SEARCHED][] = [];
  let statements = 0;
  for (const key of keys) {
    const b = behaviourOf(spec, key, stage.stale);
    if (b.kind === "found") {
      values.push([key, foundValue(b, stage.stale)]);
      for (const c of b.cuts) cut.push([key, c]);
      if (b.coverage) coverage.push([key, SEARCHED]);
    } else if (b.kind === "absent") {
      absent.push(key);
      if (b.coverage) coverage.push([key, SEARCHED]);
    } else if (b.kind === "unknown") unknown.push([key, b.reason]);
    else if (b.kind === "statement") {
      unknown.push([key, { reason: "failed" }]);
      statements += 1;
    }
    // silent: the key is left out
  }
  return {
    values,
    absent,
    unknown,
    cut,
    ...(coverage.length > 0 ? { coverage } : {}),
    billedBytes: bytesOf(spec, keys, stage),
    errors: statements > 0 ? [{ code: "E_STATEMENT", keys: statements }] : [],
  };
}

// ---------------------------------------------------------------- the graph

export type Meta = { readonly label: string };
type Ctx = Record<string, never>;

/** Schemas give types and nothing else: the library never calls them. */
function schema<T>(): Schema<T> {
  return {
    "~standard": { version: 1, vendor: "props", validate: (value) => ({ value: value as T }) },
  };
}

const m = (label: string) => ({ meta: { label } });

function graphOf(s: Scenario, stage: Stage): GraphDef<Meta> {
  const g = hopgraph<Meta, string, Ctx>().entities(
    Object.fromEntries(
      s.entities.map((e) => [e.name, entity({ key: schema<string>(), personal: e.personal })]),
    ),
  );
  const loaders = new Map(
    s.loaders.map((spec) => {
      const fake = source(spec, stage);
      const common = {
        id: spec.id,
        version: 1,
        keyedBy: spec.entity,
        connectors:
          spec.connectors.mode === "allOf"
            ? { allOf: spec.connectors.names }
            : { oneOf: spec.connectors.names },
        batch: spec.batch,
        partial: spec.partial,
        keep: (o: Kept) => (o.found ? spec.keep.found : spec.keep.absent),
        load: fake.load,
        ...(stage.resilience ? { retry: stage.resilience.retry } : {}),
      };
      const caps = spec.metered;
      const loader = caps
        ? g.loader({
            ...common,
            cost: { metered: { auto: caps.auto, approve: caps.approve } },
            price: fake.price,
          })
        : g.loader(common);
      return [spec.id, loader] as const;
    }),
  );
  const loader = (id: string) => {
    const found = loaders.get(id);
    if (!found) throw new Error(`props: no loader ${id}`);
    return found;
  };

  type Out = LinkOut<string, { readonly n: number }, Record<never, never>>;
  const relations = new Map<string, RelationDef>(
    s.relations.map((r) => {
      const verify = r.verify;
      const declared = g.relation(r.from, r.to, r.name, {
        cardinality: "N:N",
        link: schema<{ readonly n: number }>(),
        combine: r.combine,
        strategies: (make) =>
          r.strategies.map((st) =>
            make(loader(st.loader), {
              ...(st.coverage ? { coverage: st.coverage } : {}),
              project: (_ref, value: Value): Out[] =>
                targetsOf(st.pick, value).map((i) => ({ to: keyOf(r.to, i), attrs: { n: i } })),
            }),
          ) as [ReturnType<typeof make>, ...ReturnType<typeof make>[]],
        ...(verify
          ? {
              verify: (v) =>
                v(loader(verify.loader), (candidates) => decide(verify.rule, candidates)),
            }
          : {}),
      });
      if (declared.id !== r.id) throw new Error(`props: relation ${declared.id} is not ${r.id}`);
      return [r.id, declared] as const;
    }),
  );

  const providers = new Map<string, ProviderDef<Meta>>(
    s.providers.map((p) => {
      const spec = {
        loader: loader(p.loader),
        temporal: "current" as const,
        rows: p.rows,
        project: (value: Value): readonly Row[] => rowsOf(p, value),
        raw: { a: m("a"), b: m("b") },
      };
      const declared = p.derived
        ? g.provider(p.id, {
            ...spec,
            derived: (d) => ({ twice: d(["a"], ({ a }) => a * 2, m("twice")) }),
          })
        : g.provider(p.id, spec);
      return [p.id, declared];
    }),
  );

  // a path is spread from a list here, where the builder's types want a literal tuple
  const path = g.path as unknown as (...relations: unknown[]) => Path<string, string>;
  const union = g.union as unknown as (
    ...paths: Path<string, string>[]
  ) => Combined<string, string>;
  const routes = s.routes.map((r) => {
    const provider = providers.get(r.provider);
    if (!provider) throw new Error(`props: no provider ${r.provider}`);
    const paths =
      r.paths === "itself" ? [] : r.paths.map((ids) => path(...ids.map((id) => relations.get(id))));
    const how =
      r.paths === "itself"
        ? g.itself(r.base)
        : paths.length === 1
          ? (paths[0] as Path<string, string>)
          : union(...paths);
    return g.route(r.base, provider, how);
  });
  return g.graph(...routes);
}

// ---------------------------------------------------------------- the cache

/** A per-key store that clones on the way in and out, as a remote one would, and writes down
 *  what it was asked and given. */
class Store implements CachePort {
  readonly entries = new Map<string, CachedAnswer>();
  stage: Stage | undefined;

  async getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedAnswer>> {
    const out = new Map<string, CachedAnswer>();
    for (const k of keys) {
      const hit = this.entries.get(k);
      if (hit) out.set(k, structuredClone(hit));
    }
    // Only a loader's lookups are logged: a resumed run also reads the scopes of its approvals
    // (`hopgraph:1:gate:`), once, and that is not a loader's lookup.
    const answers = keys.filter((k) => k.startsWith("hopgraph:1:answer:"));
    if (answers.length > 0)
      this.stage?.log.push({
        kind: "get",
        entries: answers.length,
        hits: answers.filter((k) => out.has(k)).length,
      });
    await this.stage?.pause(0);
    return out;
  }

  async setMany(entries: Parameters<CachePort["setMany"]>[0]): Promise<void> {
    for (const e of entries) this.entries.set(e.key, structuredClone(e.answer));
    // Only answers are logged: the scope a gated run keeps under `hopgraph:1:gate:` is not an
    // answer, and the model of the cache predicts answers only.
    const answers = entries.filter((e) => e.key.startsWith("hopgraph:1:answer:"));
    this.stage?.log.push({ kind: "set", retentions: answers.map((e) => e.retention) });
    await this.stage?.pause(0);
  }
}

// ---------------------------------------------------------------- the tracer

const quiet: Span = {
  setAttribute: () => undefined,
  addEvent: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

/** A tracer that writes each job down in `log` when it ends, with its cache lookups. */
function tracerOf(log: Event[]): Tracer {
  const jobs = new Map<Span, { lookups: number }>();
  return {
    startSpan(name, attributes, parent) {
      const job = parent && jobs.get(parent);
      if (name === "hopgraph.cache.read" && job) job.lookups += 1;
      if (name !== "hopgraph.batch") return quiet;
      const attrs: Record<string, unknown> = { ...attributes };
      const counts = { lookups: 0 };
      const span: Span = {
        ...quiet,
        setAttribute: (key, value) => {
          attrs[key] = value;
        },
        end: () => {
          const n = (key: string) => Number(attrs[key] ?? 0);
          log.push({
            kind: "batch",
            batch: {
              loader: String(attrs["hopgraph.loader"]),
              wave: n("hopgraph.wave"),
              keys: n("hopgraph.keys"),
              hits: n("hopgraph.cache.hits") + n("hopgraph.inflight.hits"),
              lookups: counts.lookups,
            },
          });
        },
      };
      jobs.set(span, counts);
      return span;
    },
  };
}

// ---------------------------------------------------------------- playing

/** FNV-1a: an opaque text that never contains the key it stands for. */
export function digest(entity: string, keyId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < keyId.length; i++) {
    h ^= keyId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${entity}#${h.toString(16).padStart(8, "0")}`;
}

/** How a key appears in a result: its digest when its entity is personal. */
export function shower(s: Scenario): (entity: string, key: string) => string {
  const personal = new Set(s.entities.filter((e) => e.personal).map((e) => e.name));
  return (entity, key) => (personal.has(entity) ? digest(entity, key) : key);
}

export interface PlayOptions {
  /** its sources answer older rows */
  readonly stale?: boolean;
  readonly approved?: Record<string, number>;
  /** the deadline passes once this many calls have started: the run's clock counts calls */
  readonly deadlineAfter?: number;
}

export interface Player {
  /** the runs played so far */
  readonly played: Played[];
  play(label: string, request: Request, o?: PlayOptions): Promise<Played>;
}

/** When a job may start: as `run` decides (`plan`), or at the barrier it replaced, where a wave
 *  starts once every read of the wave before has ended. */
export type Rule = "plan" | "barrier";

/** A graph, its sources and a cache, to play runs on one after the other; `timing` seeds the
 *  order slow calls finish in. */
export function player(
  s: Scenario,
  timing: number,
  resilience?: Resilience,
  rule: Rule = "plan",
): Player {
  const stage: Stage = {
    log: [],
    index: 0,
    stale: false,
    inflight: 0,
    pause: pacer(timing),
    resilience,
    attempts: new Map(),
  };
  const graph = graphOf(s, stage);
  const store = new Store();
  const played: Played[] = [];
  return {
    played,
    async play(label, request, o = {}) {
      const log: Event[] = [];
      Object.assign(stage, {
        log,
        index: played.length,
        stale: o.stale ?? false,
        attempts: new Map(),
      });
      store.stage = stage;
      const approved = o.approved ?? {};
      const calls = () => log.filter((e) => e.kind === "load").length;
      const deadline =
        o.deadlineAfter !== undefined
          ? NOW + o.deadlineAfter
          : s.deadline === "passed"
            ? NOW - 1
            : undefined;
      const running = runWith(
        graph,
        {
          refs: request.rows.map((r: BaseRow) => ({ row: r.row, entity: r.entity, key: r.key })),
          providers: request.providers,
          ctx: {},
          restriction: "viewer",
          readable: (c) => s.readable[c] ?? true,
          cache: store,
          limits: s.limits,
          digest,
          clock: o.deadlineAfter === undefined ? () => NOW : () => NOW + calls(),
          ...(deadline === undefined ? {} : { deadline }),
          approved,
          fatal: (e) => e instanceof Fatal,
          ...(resilience
            ? {
                retryable: (e: unknown) => e instanceof Flaky,
                ...(resilience.health ? { health: resilience.health } : {}),
              }
            : {}),
          tracer: tracerOf(log),
        },
        rule,
      );
      let outcome: Played["outcome"];
      try {
        outcome = { kind: "result", result: await finishes(running) };
      } catch (error) {
        outcome = { kind: "error", error, settled: log.length };
        // what was running when the run failed finishes; nothing new may start
        for (let i = 0; i < 200 && stage.inflight > 0; i++) await turn();
        for (let i = 0; i < 10; i++) await turn();
      }
      const p: Played = {
        label,
        index: played.length,
        request,
        approved,
        events: log,
        outcome,
      };
      played.push(p);
      return p;
    },
  };
}

/** A run that never ends fails the property instead of the whole suite. */
async function finishes<T>(running: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("props: the run did not finish in 5 s")), 5000);
  });
  try {
    return await Promise.race([running, hung]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The scenario's runs, in order: the warm-ups that fill the cache, the run under test, and, when
 * it stopped at gates and the scenario approves some, the resume with those approvals.
 */
export async function playAll(
  s: Scenario,
  timing = s.timing[0],
  resilience?: Resilience,
  rule: Rule = "plan",
): Promise<Player> {
  const p = player(s, timing, resilience, rule);
  for (const [i, w] of s.warmups.entries()) await p.play(`warm-up ${i + 1}`, w, { stale: w.stale });
  const first = await p.play("run", s.request);
  if (first.outcome.kind !== "result" || s.approvals.length === 0) return p;
  // gates in the order of their loaders: the list's own order is the order the run met them
  const gates = [...first.outcome.result.gates].sort((a, b) => (a.loader < b.loader ? -1 : 1));
  const approved: Record<string, number> = {};
  gates.forEach((gate, i) => {
    const a: Approval = s.approvals[i % s.approvals.length] ?? "skip";
    if (a !== "skip") approved[gate.id] = gate.bytes + (a === "more" ? 10 : a === "less" ? -1 : 0);
  });
  if (Object.keys(approved).length > 0) await p.play("resume", s.request, { approved });
  return p;
}

// ---------------------------------------------------------------- reading the record

/** One job: a loader's part of one wave, its dry runs and calls, and the batch that closed it. */
export interface Part {
  readonly loader: string;
  /** undefined: the job never ended (the run failed in it) */
  readonly batch: Batch | undefined;
  readonly prices: readonly PriceEvent[];
  readonly loads: readonly LoadEvent[];
}

/**
 * The record cut into jobs. A job ends with its batch, and a loader's jobs do not overlap, so
 * every dry run and call of a loader belongs to the next batch of that loader.
 */
export function partsOf(played: Played): Part[] {
  const open = new Map<string, { prices: PriceEvent[]; loads: LoadEvent[] }>();
  const parts: Part[] = [];
  const of = (loader: string) => {
    let part = open.get(loader);
    if (!part) {
      part = { prices: [], loads: [] };
      open.set(loader, part);
    }
    return part;
  };
  for (const e of played.events) {
    if (e.kind === "price") of(e.loader).prices.push(e);
    if (e.kind === "load") of(e.loader).loads.push(e);
    if (e.kind === "batch") {
      parts.push({ loader: e.batch.loader, batch: e.batch, ...of(e.batch.loader) });
      open.delete(e.batch.loader);
    }
  }
  for (const [loader, part] of open)
    if (part.prices.length + part.loads.length > 0)
      parts.push({ loader, batch: undefined, ...part });
  return parts;
}

/** What a call billed: what its envelope says, or what its error says, else nothing. */
export const billed = (call: LoadEvent): number =>
  call.end?.kind === "done"
    ? call.end.envelope.billedBytes
    : call.end?.kind === "threw"
      ? (call.end.billed ?? 0)
      : 0;

/** What a call took from its wave's budget: what it billed, and all it was given when it threw
 *  without saying what it billed (DESIGN.md §5.3). */
export const charged = (call: LoadEvent): number =>
  call.end?.kind === "threw" && call.end.billed === undefined
    ? (call.budget.maxBytes ?? 0)
    : billed(call);
