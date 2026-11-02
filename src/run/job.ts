// What one job does (DESIGN.md §3.1, §5.2, §5.3): the reads of one loader in one wave, fetched
// together. The cache is asked for every key at once; a key another run is loading is waited for
// (flights.ts); a metered loader prices the rest, one dry run per call layer, and is gated once for
// the whole job; the keys are cut into the loader's batches in key order, so which keys share a
// call never depends on which step asked first; each batch is a call (calls.ts), a metered job's
// calls taking turns on its budget; and what may be kept is written back. Each of these is a span
// under the job's own (`hopgraph.batch`), whose attributes say what the job did.
//
// A loader key is a key and what the load reads of its ref (the values of its needs and hints):
// two refs of one key that read different values are two loader keys, answered by separate calls,
// since an envelope tells keys apart by key alone.

import {
  type Attrs,
  type Budget,
  CostChangedError,
  type EntityDef,
  HopgraphError,
  type LoadError,
  type LoaderDef,
  type LoaderMerge,
  type Ref,
} from "../core/index.ts";
import { billOf, type Calls, type Made, type Price, Purse, type Tried } from "./calls.ts";
import {
  answersOf,
  audit,
  DEADLINE,
  FAILED,
  fromCache,
  type KeyAnswer,
  keepable,
} from "./envelope.ts";
import type { Flights } from "./flights.ts";
import { type Approvals, decide, type Gates } from "./gates.ts";
import { gateId, keyToken } from "./ids.ts";
import { entityOf, type RefNode, type Show } from "./refs.ts";
import type { Stop, Within } from "./stop.ts";
import type { CachedAnswer, CachePort, Span, Tracer } from "./types.ts";

/** One loader key of a read. */
export interface LoaderKey {
  /** the key id and the values read: the run's identity of the loader key */
  readonly id: string;
  /** the first ref that asked for it */
  readonly ref: RefNode;
  /** the ref as the load sees it */
  readonly view: Ref<unknown, Attrs>;
  /** the json of what the load reads besides the key (its needs' and hints' values) */
  readonly read: string;
  /** its cache entry */
  readonly entry: string;
}

export interface JobEnv {
  readonly entities: Readonly<Record<string, EntityDef>>;
  readonly restriction: string;
  readonly cache: CachePort;
  /** the loads in flight, shared with other runs (flights.ts); none: this run shares nothing */
  readonly flights?: Flights;
  readonly approvals: Approvals;
  readonly gates: Gates;
  readonly show: Show;
  /** whether every envelope is audited, its contradictions failed (validate.ts `strict`) */
  readonly strict: boolean;
  /** prices known by gate id (a previous run's), and those this run measures */
  readonly prices: Map<string, number>;
  readonly now: () => number;
  readonly tracer: Tracer;
  readonly calls: Calls;
  /** the loader key of a ref that reads `read` besides its key */
  readonly keyReading: (loader: LoaderDef, ref: RefNode, read: Attrs) => LoaderKey;
  /** the connectors a load holds a slot on */
  readonly held: (loader: LoaderDef) => readonly string[];
  /** an approval this job's price grew past: the run collects it and fails (reads.ts) */
  readonly refuse: (wave: number, error: CostChangedError) => void;
  /** whether a job of this wave may still load: not once a wave as early has failed (reads.ts) */
  readonly loads: (wave: number) => boolean;
}

/** What stops a job: `job`, and once it loads, `loads`, which a failure of the job's own
 *  wave stops alone, so that the job's dry runs still end (reads.ts). */
export interface Stops {
  readonly job: Stop;
  loads?: Stop;
}

/** What a job did, besides the answers it settled. */
export interface Done {
  /** the loader keys the cache, or another run's load in flight, answered */
  readonly hits: ReadonlySet<string>;
  readonly billed: number;
  readonly errors: readonly LoadError[];
  readonly retries: number;
}

/** What the calls of a job did. */
interface Loaded {
  readonly billed: number;
  readonly errors: readonly LoadError[];
  readonly retries: number;
  /** attempts that answered or threw */
  readonly attempts: number;
}

/** Whether a job loads, how it was decided (the span's `hopgraph.admission`), and the dry runs
 *  tried again to decide it. */
type Admission = { readonly retries: number; readonly how: string } & (
  | { readonly kind: "run"; readonly budget: Budget }
  | { readonly kind: "refused"; readonly answer: KeyAnswer; readonly errors: readonly LoadError[] }
);

const NONE: Loaded = { billed: 0, errors: [], retries: 0, attempts: 0 };

export class Jobs {
  constructor(private readonly env: JobEnv) {}

  /**
   * Answers `keys` of `loader` into `settled`: from the cache, else admitted and loaded in the
   * loader's batches. `steps`: the steps the job reads for, for the person who approves a gate.
   * Everything it waits for gives up when its stops stop.
   */
  async run(
    loader: LoaderDef,
    wave: number,
    asked: readonly LoaderKey[],
    steps: string,
    settled: Map<string, KeyAnswer>,
    stops: Stops,
    span: Span,
  ): Promise<Done> {
    const stop = stops.job;
    // key order, so that the batches do not depend on which step asked first; no two keys of a job
    // share an id (reads.ts keeps a job's keys by id)
    const keys = [...asked].sort((a, b) => (a.id < b.id ? -1 : 1));
    const hits = new Set<string>();
    const late = (): Done => {
      for (const k of keys) if (!settled.has(k.id)) settled.set(k.id, DEADLINE);
      span.setAttribute("hopgraph.admission", "stopped");
      return { hits, ...NONE };
    };
    // a read asked before the run stopped whose job starts after it does not start either
    if (stop.stopped()) return late();
    const t0 = this.env.now();
    const lookup = this.env.tracer.startSpan(
      "hopgraph.cache.read",
      { "hopgraph.loader": loader.id, "hopgraph.entries": keys.length },
      span,
    );
    const missing: LoaderKey[] = [];
    let read: Within<ReadonlyMap<string, CachedAnswer>>;
    try {
      read = await stop.within(this.env.cache.getMany(keys.map((k) => k.entry)));
      if (read.done)
        for (const k of keys) {
          const hit = read.value.get(k.entry);
          if (hit) {
            settled.set(k.id, fromCache(hit));
            hits.add(k.id);
          } else missing.push(k);
        }
      lookup.setAttribute("hopgraph.hits", hits.size);
    } finally {
      lookup.end();
    }
    const t1 = this.env.now();
    span.setAttribute("hopgraph.cache.hits", hits.size);
    span.setAttribute("hopgraph.cache_ms", t1 - t0);
    if (!read.done) return late();
    if (missing.length === 0) {
      span.setAttribute("hopgraph.admission", "cached");
      return { hits, ...NONE };
    }
    if (stop.stopped()) return late();

    const { reads, members } = this.merged(loader, missing);
    // what another run is loading now is waited for, not loaded again
    const cached = hits.size;
    const left = await this.borrowed(reads, members, settled, hits, stop);
    span.setAttribute("hopgraph.inflight.hits", hits.size - cached);
    if (!left) return late();
    const tb = this.env.now();
    const loaded =
      left.length > 0
        ? await this.loaded(loader, wave, left, steps, settled, stops, span)
        : undefined;
    if (loader.merge) await this.narrowed(loader, loader.merge, members, settled, stop, span);
    const t2 = loaded?.admitted ?? tb;
    span.setAttribute("hopgraph.price_ms", t2 - tb);
    // waiting for another run's load is loading
    span.setAttribute("hopgraph.load_ms", this.env.now() - t2 + (tb - t1));
    span.setAttribute("hopgraph.attempts", loaded?.attempts ?? 0);
    return { hits, ...(loaded ?? NONE) };
  }

  /**
   * Of `reads`, those another run is loading now (flights.ts) are waited for: a found or absent
   * answer settles them as the cache would, and counts as a hit; the others are left to load.
   * Undefined when the job stopped while it waited.
   */
  private async borrowed(
    reads: readonly LoaderKey[],
    members: ReadonlyMap<string, readonly LoaderKey[]>,
    settled: Map<string, KeyAnswer>,
    hits: Set<string>,
    stop: Stop,
  ): Promise<readonly LoaderKey[] | undefined> {
    const { flights } = this.env;
    const flying = reads.map((k) => flights?.waiting(k.entry));
    if (flying.every((f) => f === undefined)) return reads;
    const landed = await stop.within(Promise.all(flying));
    if (!landed.done) return undefined;
    return reads.filter((k, i) => {
      const answer = landed.value[i];
      if (!answer) return true;
      settled.set(k.id, answer);
      for (const m of members.get(k.id) ?? [k]) hits.add(m.id);
      return false;
    });
  }

  /** Admits loader keys and loads them in the loader's batches; `admitted`: when the admission
   *  ended. */
  private async loaded(
    loader: LoaderDef,
    wave: number,
    reads: readonly LoaderKey[],
    steps: string,
    settled: Map<string, KeyAnswer>,
    stops: Stops,
    span: Span,
  ): Promise<Loaded & { readonly admitted: number }> {
    const layers = layersOf(reads);
    const admission = await this.admit(loader, wave, layers, steps, stops.job, span);
    const admitted = this.env.now();
    span.setAttribute("hopgraph.admission", admission.how);
    if (admission.kind === "refused" || !this.env.loads(wave)) {
      // an approval refused in this wave or an earlier one: nothing more of it loads
      const answer = admission.kind === "refused" ? admission.answer : FAILED;
      for (const k of reads) settled.set(k.id, answer);
      const errors = admission.kind === "refused" ? admission.errors : [];
      return { billed: 0, errors, retries: admission.retries, attempts: 0, admitted };
    }
    const stop = stops.job.part();
    stops.loads = stop;
    const batches = layers.flatMap((layer) => batchesOf(loader.batch, layer));
    const budget = admission.budget.maxBytes;
    const purse = budget === undefined ? undefined : new Purse(budget);
    // every key admitted is in flight until its call lands it: a run that asks it meanwhile waits
    // for it, even while the calls before its own take their turns
    const land = this.flying(loader, reads, settled);
    // a free loader's calls run side by side; a metered job's take turns drawing from its budget,
    // so that each is told exactly what the ones before it left
    const call = (batch: readonly LoaderKey[]) =>
      this.load(loader, batch, purse, settled, stop, span).finally(() => land(batch));
    let loads: Loaded[];
    try {
      loads = purse ? await inTurn(batches, call) : await Promise.all(batches.map(call));
    } finally {
      land(reads);
    }
    span.setAttribute("hopgraph.loaded", reads.length);
    span.setAttribute("hopgraph.calls", loads.filter((l) => l.attempts > 0).length);
    return {
      billed: loads.reduce((total, l) => total + l.billed, 0),
      errors: loads.flatMap((l) => l.errors),
      retries: loads.reduce((total, l) => total + l.retries, admission.retries),
      attempts: loads.reduce((total, l) => total + l.attempts, 0),
      admitted,
    };
  }

  /**
   * The reads of some loader keys: one per key id where the loader merges the needs of its refs
   * (`LoaderInput.merge`), each other key as it is. `members` names the keys a merged read answers.
   */
  private merged(
    loader: LoaderDef,
    keys: readonly LoaderKey[],
  ): { reads: LoaderKey[]; members: Map<string, LoaderKey[]> } {
    const members = new Map<string, LoaderKey[]>();
    if (!loader.merge) return { reads: [...keys], members };
    const byKeyId = new Map<string, LoaderKey[]>();
    for (const k of keys) byKeyId.set(k.ref.keyId, [...(byKeyId.get(k.ref.keyId) ?? []), k]);
    const reads: LoaderKey[] = [];
    for (const group of byKeyId.values()) {
      const first = group[0];
      const needs =
        first && group.length > 1 ? loader.merge.needs(group.map((k) => k.view)) : undefined;
      if (!first || !needs) {
        reads.push(...group);
        continue;
      }
      const read = this.env.keyReading(loader, first.ref, needs);
      reads.push(read);
      members.set(read.id, group);
    }
    return { reads, members };
  }

  /** Each key a merged read answered: its own part of the value, kept under its own entry. */
  private async narrowed(
    loader: LoaderDef,
    merge: LoaderMerge,
    members: ReadonlyMap<string, readonly LoaderKey[]>,
    settled: Map<string, KeyAnswer>,
    stop: Stop,
    span: Span,
  ): Promise<void> {
    const writes = [];
    for (const [readId, group] of members) {
      const answer = answered(settled.get(readId));
      settled.delete(readId);
      for (const k of group) {
        const own = narrow(merge, answer, k.view);
        settled.set(k.id, own);
        const kept = keepable(own, loader.keep);
        if (kept) writes.push({ key: k.entry, ...kept });
      }
    }
    await this.write(loader, writes, stop, span);
  }

  /**
   * A free loader runs. A metered one is priced first, one dry run per call layer, and gated once
   * for the whole job (`steps` names the steps it reads for, for the person who approves): it runs
   * under its auto cap, with its own approval, or as a part of an approval of more keys (gates.ts
   * Approvals); it stops at a gate up to its approve cap and is too heavy above it. A gate whose
   * price is known (`JobEnv.prices`: the same request, moments before) is not priced again. An
   * approval the price grew past is refused: the run collects it and fails (reads.ts).
   */
  private async admit(
    loader: LoaderDef,
    wave: number,
    layers: readonly (readonly LoaderKey[])[],
    steps: string,
    stop: Stop,
    span: Span,
  ): Promise<Admission> {
    const caps = loader.cost?.metered;
    const { price } = loader;
    if (!caps || !price)
      return { kind: "run", how: "free", budget: { maxBytes: undefined }, retries: 0 };
    const keys = layers.flat();
    const { restriction } = this.env;
    const tokens = keys.map((k) =>
      keyToken(loader, restriction, k.ref.keyId, this.env.show(k.ref), k.read),
    );
    const gate = gateId(loader, restriction, tokens);
    span.setAttribute("hopgraph.gate", gate);
    const known = this.env.prices.get(gate);
    let bytes = known ?? 0;
    let retries = 0;
    const refused = (
      how: string,
      answer: KeyAnswer,
      errors: readonly LoadError[] = [],
    ): Admission => ({
      kind: "refused",
      how,
      answer,
      errors,
      retries,
    });
    for (const layer of known === undefined ? layers : []) {
      const pricing = await this.price(loader, price, layer, stop, span);
      retries += pricing.retries;
      const { call } = pricing;
      // a dry run the run stopped waiting for prices nothing: no load starts any more
      if (call.kind === "late" || stop.stopped()) return refused("stopped", DEADLINE);
      if (call.kind === "open")
        return refused("open", open(call.connectors), [opened(keys.length)]);
      if (call.kind === "threw") return refused("failed", FAILED, [call.error]);
      // a dry run that answered nonsense prices nothing: its keys failed, nothing is billed
      if (!Number.isFinite(call.value) || call.value < 0) return refused("failed", FAILED);
      bytes += call.value;
    }
    this.env.prices.set(gate, bytes);
    span.setAttribute("hopgraph.price_bytes", bytes);

    const approval = this.env.approvals.exact(gate);
    // keys an approval of more keys covers, at a price it still has: they run on their own price
    if (approval === undefined && bytes > caps.auto && bytes <= caps.approve) {
      const covered = await stop.within(this.env.approvals.cover(loader, tokens, bytes));
      if (!covered.done) return refused("stopped", DEADLINE);
      if (covered.value)
        return { kind: "run", how: "covered", budget: { maxBytes: bytes }, retries };
    }
    let decision: ReturnType<typeof decide>;
    try {
      decision = decide(caps, bytes, gate, approval);
    } catch (error) {
      // the run fails once every approval of this wave is decided, naming them all (reads.ts)
      this.env.refuse(wave, costChanged(error));
      return refused("refused", FAILED);
    }
    if (decision.kind === "run")
      return {
        kind: "run",
        how: approval === undefined ? "auto" : "approved",
        budget: { maxBytes: decision.maxBytes },
        retries,
      };
    if (decision.kind === "too_heavy")
      return refused("too_heavy", { kind: "unknown", reason: { reason: "too_heavy", bytes } });
    if (this.env.gates.add({ id: gate, step: steps, loader: loader.id, keys: keys.length, bytes }))
      await stop.within(this.env.approvals.remember(gate, tokens));
    return refused("gated", { kind: "unknown", reason: { reason: "awaiting_approval", bytes } });
  }

  /** One dry run, under its own span. */
  private async price(
    loader: LoaderDef,
    price: Price,
    layer: readonly LoaderKey[],
    stop: Stop,
    span: Span,
  ): Promise<Tried<number, Made<number>>> {
    const dry = this.env.tracer.startSpan(
      "hopgraph.price",
      { "hopgraph.loader": loader.id, "hopgraph.keys": layer.length },
      span,
    );
    try {
      const views = layer.map((k) => k.view);
      const pricing = await this.env.calls.price(
        loader,
        price,
        views,
        this.env.held(loader),
        stop,
        dry,
      );
      const { call } = pricing;
      ended(dry, call.kind, pricing.attempts);
      if (call.kind === "threw") dry.recordError(call.error);
      if (call.kind === "done" && typeof call.value === "number")
        dry.setAttribute("hopgraph.bytes", call.value);
      return pricing;
    } finally {
      dry.end();
    }
  }

  /**
   * Puts `reads` in flight (flights.ts), and gives back how to land some of them: each with its
   * answer when the cache would keep it, else with none, so a run that waited reads it itself.
   * Landing a key twice lands it once.
   */
  private flying(
    loader: LoaderDef,
    reads: readonly LoaderKey[],
    settled: ReadonlyMap<string, KeyAnswer>,
  ): (keys: readonly LoaderKey[]) => void {
    const flights = this.env.flights;
    if (!flights) return () => undefined;
    const lands = new Map(reads.map((k) => [k.id, flights.start(k.entry)]));
    return (keys) => {
      for (const k of keys) {
        const answer = settled.get(k.id);
        lands.get(k.id)?.(answer && keepable(answer, loader.keep) ? answer : undefined);
      }
    };
  }

  /** One call: its answers settled, what may be kept written back, its bill and failures. */
  private async load(
    loader: LoaderDef,
    batch: readonly LoaderKey[],
    purse: Purse | undefined,
    settled: Map<string, KeyAnswer>,
    stop: Stop,
    span: Span,
  ): Promise<Loaded> {
    const views = batch.map((k) => k.view);
    const held = this.env.held(loader);
    const one = this.env.tracer.startSpan(
      "hopgraph.load",
      {
        "hopgraph.loader": loader.id,
        "hopgraph.keys": views.length,
        "hopgraph.connectors": [...held],
        ...(purse ? { "hopgraph.budget_bytes": purse.left() } : {}),
      },
      span,
    );
    try {
      const { call, attempts, retries, billed } = await this.env.calls.load(
        loader,
        views,
        held,
        purse,
        stop,
        one,
      );
      // a batch holds each key id once (layersOf)
      const asked = batch.map((k) => k.ref.keyId);
      const envelope = call.kind === "done" ? call.value : undefined;
      const idOf = entityOf(this.env.entities, loader.keyedBy).id;
      const answers =
        call.kind === "late"
          ? new Map(asked.map((keyId) => [keyId, DEADLINE]))
          : call.kind === "open"
            ? new Map(asked.map((keyId) => [keyId, open(call.connectors)]))
            : answersOf(asked, idOf, envelope, loader.partial);
      // a strict run trusts no envelope that contradicts itself: those keys fail, and it says why
      const audited = envelope && this.env.strict ? audit(asked, idOf, envelope) : undefined;
      for (const keyId of audited?.conflicted ?? []) answers.set(keyId, FAILED);
      const writes = [];
      for (const k of batch) {
        const answer = answered(answers.get(k.ref.keyId));
        settled.set(k.id, answer);
        const kept = keepable(answer, loader.keep);
        if (kept) writes.push({ key: k.entry, ...kept });
      }
      await this.write(loader, writes, stop, span);
      // what failed attempts said they billed, and the answer's own bill
      const done = { retries, attempts, billed: billed + (billOf(envelope?.billedBytes) ?? 0) };
      ended(one, call.kind, attempts);
      one.setAttribute("hopgraph.billed_bytes", done.billed);
      const errors: LoadError[] =
        call.kind === "done"
          ? [...call.value.errors, ...(audited?.errors ?? [])]
          : call.kind === "threw"
            ? [call.error]
            : call.kind === "spent"
              ? [{ code: "HG_BUDGET_SPENT", keys: asked.length }]
              : call.kind === "open"
                ? [opened(asked.length)]
                : [];
      for (const error of errors) one.recordError(error);
      return { ...done, errors };
    } finally {
      one.end();
    }
  }

  /** Writes answers back; a write the job stopped waiting for may still land: the answers stand
   *  either way. */
  private async write(
    loader: LoaderDef,
    writes: Parameters<CachePort["setMany"]>[0],
    stop: Stop,
    span: Span,
  ): Promise<void> {
    if (writes.length === 0) return;
    const write = this.env.tracer.startSpan(
      "hopgraph.cache.write",
      { "hopgraph.loader": loader.id, "hopgraph.entries": writes.length },
      span,
    );
    try {
      await stop.within(this.env.cache.setMany(writes));
    } finally {
      write.end();
    }
  }
}

/** A key's answer once its job loaded: every key a call asks gets one (envelope.ts `answersOf`),
 *  and so does every merged read, so a missing one is the executor's bug, refused as such rather
 *  than kept as if the source had failed. */
export function answered(answer: KeyAnswer | undefined): KeyAnswer {
  if (answer === undefined)
    throw new HopgraphError("HG_INTERNAL", "a job left one of its keys unanswered");
  return answer;
}

/** What `decide` threw: the approval the price grew past. Anything else is a bug and goes on. */
export function costChanged(error: unknown): CostChangedError {
  if (error instanceof CostChangedError) return error;
  throw error;
}

/** How a call ended, on its span: its outcome and the attempts that got a verdict. */
function ended(span: Span, outcome: string, attempts: number): void {
  span.setAttribute("hopgraph.outcome", outcome);
  span.setAttribute("hopgraph.attempts", attempts);
}

/** One ref's part of a merged read: what `narrow` keeps of a found value, absent when nothing is
 *  left; a cut read stays cut for every ref, `empty` when nothing of it is left. */
export function narrow(merge: LoaderMerge, answer: KeyAnswer, ref: Ref<unknown, Attrs>): KeyAnswer {
  if (answer.kind !== "found") return answer;
  const value = merge.narrow(answer.value, ref);
  if (value !== undefined) return { ...answer, value };
  return answer.cuts.length > 0 ? { ...answer, value: merge.empty } : { kind: "absent" };
}

/** The loader's batches (DESIGN.md §3.1): N keys per call, one call for all, or one key per
 *  call. */
export function batchesOf<T>(batch: LoaderDef["batch"], items: readonly T[]): T[][] {
  if (items.length === 0) return [];
  if (batch.by === "partition") return [[...items]];
  if (batch.by === "one") return items.map((item) => [item]);
  const size = Math.max(1, Math.floor(batch.max));
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}

/** Splits loader keys so that no layer holds one key twice: the first ref of each key, the
 *  second… */
export function layersOf<K extends { readonly ref: { readonly keyId: string } }>(
  keys: readonly K[],
): K[][] {
  const layers: K[][] = [];
  const seen = new Map<string, number>();
  for (const k of keys) {
    const depth = seen.get(k.ref.keyId) ?? 0;
    seen.set(k.ref.keyId, depth + 1);
    const layer = layers[depth] ?? [];
    layer.push(k);
    layers[depth] = layer;
  }
  return layers;
}

/** A key whose source was not called: the circuit of its connectors is open (health.ts). */
function open(connectors: readonly string[]): KeyAnswer {
  return { kind: "unknown", reason: { reason: "failed", why: "open", connectors } };
}

/** The trace's failure for keys whose source was not called, the circuit open. */
function opened(keys: number): LoadError {
  return { code: "HG_CIRCUIT_OPEN", keys };
}

/** `work` on each item, one after the other. */
async function inTurn<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await work(item));
  return out;
}
