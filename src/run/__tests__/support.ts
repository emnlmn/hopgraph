// Shared fixtures of the executor's black-box tests (DESIGN.md §5, §6). A small graph vocabulary
// (tracks, artists, masters, studios, regions, email addresses), fake loaders that answer from
// tables and record every call (keys, refs with their needs, budget, concurrency), an in-memory
// cache port that records its reads, its writes and their retentions, a fixed clock and a digest.
// Written from the design and the contract (run/types.ts) only: nothing here knows how the executor
// is built.

import { z } from "zod";
import {
  type Budget,
  type Coverage,
  type Cut,
  type Envelope,
  entity,
  hopgraph,
  type LoadReason,
} from "../../core/index.ts";
import type {
  BaseRef,
  CachedAnswer,
  CachePort,
  LinkStep,
  ProviderRef,
  ProviderResult,
  RowResult,
  RowStep,
  RunOptions,
  RunResult,
  Span,
  SpanAttributes,
  SpanValue,
  Tracer,
  TraceStep,
} from "../types.ts";

// ---------------------------------------------------------------- vocabulary

/** A service the run carries (connectors, readers): handed to the loads that declare it, never part
 *  of a cache key. Each instance differs by its own field, as two pools would. */
export class Deps {
  constructor(readonly instance: number) {}
  read(key: string): string {
    return `${this.instance}:${key}`;
  }
}

/** `today` is data (part of the key of a loader that declares it); `deps` is a service (never). */
export type Ctx = { readonly today: string; readonly deps: Deps };
export type Meta = { readonly label: string };
export type Conn = "db" | "wh" | "api";

export const CTX: Ctx = { today: "2026-11-01", deps: new Deps(0) };
export const NOW = Date.parse("2026-11-01T09:00:00Z");
export const m = (label: string): { readonly meta: Meta } => ({ meta: { label } });

export const track = entity({
  key: z.string(),
  carries: { releasedAt: z.string(), catalog: z.string() },
});
export const artist = entity({ key: z.string(), carries: { country: z.string() } });
export const master = entity({ key: z.string() });
export const studio = entity({ key: z.string() });
export const region = entity({ key: z.string() });
/** a personal key: the result shows it only as `digest("email", keyId)` */
export const email = entity({ key: z.string(), personal: true });

export const newGraph = () =>
  hopgraph<Ctx, Meta, Conn>().entities({ track, artist, master, studio, region, email });

/** The common part of a loader that is free, reads in one job, keeps found for a day and absent
 *  briefly, and keeps the keys that answered when a statement fails. */
export const free = {
  version: 1,
  batch: { by: "partition" },
  keep: (o: { readonly found: boolean }) => (o.found ? "day" : "brief"),
  partial: "keep",
} as const;

// ---------------------------------------------------------------- fake loaders

/** Counts loads in flight; a loader reports to its own and to any shared one it is given. */
export class Inflight {
  now = 0;
  max = 0;
  enter(): void {
    this.now += 1;
    this.max = Math.max(this.max, this.now);
  }
  leave(): void {
    this.now -= 1;
  }
}

/** How a fake loader answers. Mutable between runs (`f.is.price = …`). A ref whose entry (its key,
 *  or `lookup(ref)`) is in `unknown` is unknown; in `found`, found (and cut when in `cut`);
 *  otherwise absent. A call holding a ref unknown `failed` reports a failed statement in
 *  `errors`. */
export interface Behaviour<V> {
  /** the table entry a ref answers from, when its answer depends on its needs (`t1@2026-03-03`) */
  lookup?: (ref: Readonly<Record<string, unknown>> & KeyRef) => string;
  found?: Readonly<Record<string, V>>;
  unknown?: Readonly<Record<string, LoadReason>>;
  /** one cut or several per entry (a key may be cut in more than one way) */
  cut?: Readonly<Record<string, Cut | readonly Cut[]>>;
  /** what was searched for an entry, when the load says so per key */
  coverage?: Readonly<Record<string, Coverage>>;
  /** per call */
  billedBytes?: number;
  /** what `price` answers for any set of keys */
  price?: number;
  delayMs?: number;
  /** when set, a call also waits for it to settle before it answers: a test decides when */
  until?: Promise<unknown>;
  trackers?: readonly Inflight[];
  throws?: boolean;
  onLoad?: (keys: readonly string[]) => void;
}

export interface LoadCall {
  readonly keys: readonly string[];
  /** the refs as handed to the load: key plus the needs present */
  readonly refs: readonly Readonly<Record<string, unknown>>[];
  readonly budget: Budget;
}

type KeyRef = { readonly key: string };

export interface Fake<V> {
  readonly is: Behaviour<V>;
  readonly calls: LoadCall[];
  /** the keys of every `price` call */
  readonly prices: (readonly string[])[];
  readonly inflight: Inflight;
  /** every key loaded over every call, sorted (a key loaded twice shows twice) */
  readonly loaded: () => string[];
  readonly load: (
    refs: readonly KeyRef[],
    ctx: unknown,
    budget: Budget,
  ) => Promise<Envelope<string, V>>;
  readonly price: (refs: readonly KeyRef[], ctx: unknown) => Promise<number>;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function fake<V>(is: Behaviour<V> = {}): Fake<V> {
  const calls: LoadCall[] = [];
  const prices: (readonly string[])[] = [];
  const inflight = new Inflight();
  return {
    is,
    calls,
    prices,
    inflight,
    loaded: () => calls.flatMap((c) => c.keys).sort(),
    load: async (refs, _ctx, budget) => {
      const keys = refs.map((r) => r.key);
      calls.push({ keys, refs: refs.map((r) => ({ ...r })), budget: { ...budget } });
      const trackers = [inflight, ...(is.trackers ?? [])];
      for (const t of trackers) t.enter();
      try {
        is.onLoad?.(keys);
        await Promise.all([sleep(is.delayMs ?? 2), is.until]);
        if (is.throws) throw new Error("fake load failed");
        return envelope(is, refs);
      } finally {
        for (const t of trackers) t.leave();
      }
    },
    price: async (refs) => {
      prices.push(refs.map((r) => r.key));
      return is.price ?? 0;
    },
  };
}

function envelope<V>(is: Behaviour<V>, refs: readonly KeyRef[]): Envelope<string, V> {
  const values: (readonly [string, V])[] = [];
  const absent: string[] = [];
  const unknown: (readonly [string, LoadReason])[] = [];
  const cut: (readonly [string, Cut])[] = [];
  const coverage: (readonly [string, Coverage])[] = [];
  for (const ref of refs) {
    const k = ref.key;
    const entry = is.lookup ? is.lookup(ref) : k;
    const reason = is.unknown?.[entry];
    if (reason) {
      unknown.push([k, reason]);
    } else if (is.found && Object.hasOwn(is.found, entry)) {
      values.push([k, is.found[entry] as V]);
      const c = is.cut?.[entry];
      for (const one of c === undefined ? [] : Array.isArray(c) ? c : [c]) cut.push([k, one]);
    } else {
      absent.push(k);
    }
    const searched = is.coverage?.[entry];
    if (searched && !reason) coverage.push([k, searched]);
  }
  const failed = unknown.filter(([, r]) => r.reason === "failed").length;
  return {
    values,
    absent,
    unknown,
    cut,
    ...(coverage.length > 0 ? { coverage } : {}),
    billedBytes: is.billedBytes ?? 0,
    errors: failed > 0 ? [{ code: "E_FAKE", keys: failed }] : [],
  };
}

// ---------------------------------------------------------------- cache port

export interface CacheWrite {
  readonly key: string;
  readonly answer: CachedAnswer;
  readonly retention: string;
}

/** A per-key store that clones on the way in and out, as a remote store would. */
export class MemoryCache implements CachePort {
  readonly store = new Map<string, CachedAnswer>();
  readonly gets: (readonly string[])[] = [];
  readonly sets: CacheWrite[] = [];

  async getMany(keys: readonly string[]): Promise<ReadonlyMap<string, CachedAnswer>> {
    this.gets.push([...keys]);
    const out = new Map<string, CachedAnswer>();
    for (const k of keys) {
      const hit = this.store.get(k);
      if (hit) out.set(k, structuredClone(hit));
    }
    return out;
  }

  async setMany(entries: Parameters<CachePort["setMany"]>[0]): Promise<void> {
    for (const e of entries) {
      this.sets.push(structuredClone({ key: e.key, answer: e.answer, retention: e.retention }));
      this.store.set(e.key, structuredClone(e.answer));
    }
  }

  /** every cache key written, over every run */
  written(): Set<string> {
    return new Set(this.sets.map((s) => s.key));
  }

  /** every cache key asked for, over every run */
  asked(): Set<string> {
    return new Set(this.gets.flat());
  }
}

// ---------------------------------------------------------------- spans

/** A span as a recording tracer keeps it: what it was started and set with, its events and
 *  errors, its parent, whether it ended. */
export interface Recorded {
  readonly name: string;
  readonly attributes: Record<string, SpanValue>;
  readonly events: { readonly name: string; readonly attributes: SpanAttributes }[];
  readonly errors: { readonly code: string; readonly class?: string }[];
  readonly parent: Recorded | undefined;
  ended: boolean;
}

/** A tracer that keeps every span, in the order they started. */
export function recorder(): { readonly tracer: Tracer; readonly spans: Recorded[] } {
  const spans: Recorded[] = [];
  const of = new Map<Span, Recorded>();
  const tracer: Tracer = {
    startSpan(name, attributes, parent) {
      const recorded: Recorded = {
        name,
        attributes: { ...attributes },
        events: [],
        errors: [],
        parent: parent && of.get(parent),
        ended: false,
      };
      spans.push(recorded);
      const span: Span = {
        setAttribute: (key, value) => {
          recorded.attributes[key] = value;
        },
        addEvent: (event, attrs = {}) => {
          recorded.events.push({ name: event, attributes: attrs });
        },
        recordError: (error) => {
          recorded.errors.push({ ...error });
        },
        end: () => {
          recorded.ended = true;
        },
      };
      of.set(span, recorded);
      return span;
    },
  };
  return { tracer, spans };
}

// ---------------------------------------------------------------- run options

/** FNV-1a: an opaque text that never contains the key it stands for. */
export function digest(entity: string, keyId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < keyId.length; i++) {
    h ^= keyId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${entity}#${h.toString(16).padStart(8, "0")}`;
}

export function options<const Ps extends readonly ProviderRef[] = readonly string[]>(
  over: Partial<RunOptions<Ctx, Ps>> & Pick<RunOptions<Ctx, Ps>, "refs" | "providers">,
): RunOptions<Ctx, Ps> {
  return {
    ctx: CTX,
    restriction: "forbidden:none",
    readable: () => true,
    cache: new MemoryCache(),
    limits: { db: 8, wh: 8, api: 8 },
    clock: () => NOW,
    digest,
    ...over,
  };
}

/** Base rows of one entity whose row id is their key. */
export const refs = (entity: string, ...keys: string[]): BaseRef[] =>
  keys.map((key) => ({ row: key, entity, key }));

// ---------------------------------------------------------------- reading a result

export function rowOf(result: RunResult, row: string): RowResult {
  const r = result.rows.get(row);
  if (!r) throw new Error(`no result for base row "${row}"`);
  return r;
}

export function providerOf(result: RunResult, row: string, provider: string): ProviderResult {
  const p = rowOf(result, row).providers[provider];
  if (!p) throw new Error(`no provider "${provider}" on base row "${row}"`);
  return p;
}

/** The row steps of one base row for one step id (and loader, when given). */
export function stepsOf(result: RunResult, row: string, step: string, loader?: string): RowStep[] {
  return rowOf(result, row).steps.filter(
    (s) => s.step === step && (loader === undefined || s.loader === loader),
  );
}

/** The one trace entry of a step (and loader, when given). */
export function traceOf(result: RunResult, step: string, loader?: string): TraceStep {
  const found = result.trace.filter(
    (t) => t.step === step && (loader === undefined || t.loader === loader),
  );
  if (found.length !== 1)
    throw new Error(`${found.length} trace entries for "${step}"${loader ? ` / ${loader}` : ""}`);
  return found[0] as TraceStep;
}

/** JSON with keys sorted at every level: the same text whatever order an object was built in. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );
}

const byCanonical = (a: unknown, b: unknown) => {
  const x = canonical(a);
  const y = canonical(b);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** Lineage chains in the order `rowsOf` gives them: the contract fixes no order between chains. */
export const chains = (...cs: (readonly LinkStep[])[]): LinkStep[][] =>
  cs.map((c) => [...c]).sort(byCanonical);

/** A provider's rows in a stable order (by ref, then index), each lineage's chains sorted. */
export function rowsOf(p: ProviderResult) {
  return [...p.rows]
    .map((r) => ({
      ref: r.ref,
      index: r.index,
      fields: r.fields,
      lineage: chains(...r.lineage),
    }))
    .sort((a, b) => (a.ref === b.ref ? a.index - b.index : a.ref < b.ref ? -1 : 1));
}

/** The distinct provider refs a base row got rows for, sorted. */
export const refsOf = (p: ProviderResult): string[] =>
  [...new Set(p.rows.map((r) => r.ref))].sort();

/** One link of a lineage chain. */
export const link = (
  relation: string,
  strategy: string,
  from: string,
  to: string,
  attrs: Readonly<Record<string, unknown>> = {},
): LinkStep => ({ relation, strategy, from, to, attrs });

/** The whole result as text, maps included: for "this never appears anywhere" assertions. */
export function dump(result: RunResult): string {
  return JSON.stringify(result, (_k, v: unknown) =>
    v instanceof Map ? Object.fromEntries(v) : v instanceof Set ? [...v] : v,
  );
}

/** Sorted copy, for comparing key sets whose order the contract does not fix. */
export const sorted = <T>(xs: Iterable<T>): T[] => [...xs].sort();
