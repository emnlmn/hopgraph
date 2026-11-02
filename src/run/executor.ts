// The executor (DESIGN.md §5): plans the steps the requested providers' routes need, runs them
// (cache, gates, batches, connector limits, deadline, cancellation), then attributes what was read
// to every base row. It logs nothing: the trace, the row steps and the spans a tracer is given are
// data for the application to render.

import {
  type AnyRoute,
  DefinitionError,
  type Entities,
  type Graph,
  type GraphDef,
  ValidationError,
} from "../core/index.ts";
import { attribute } from "./attribution.ts";
import { described } from "./calls.ts";
import { runCaps } from "./caps.ts";
import { execute } from "./execute.ts";
import { flightsOf } from "./flights.ts";
import { Approvals, Gates } from "./gates.ts";
import { healthOf } from "./health.ts";
import { Hydration } from "./hydration.ts";
import { keyDigest } from "./ids.ts";
import { evaluated, type Ledger } from "./ledger.ts";
import { Limits, runLimits } from "./limits.ts";
import { type PlannedRoute, plan } from "./plan.ts";
import { Providers } from "./providers.ts";
import { Reads } from "./reads.ts";
import { type RefNode, RefStore, showKeys } from "./refs.ts";
import { Relations } from "./relations.ts";
import { everything, reachOf } from "./schedule.ts";
import type { StepContext } from "./step.ts";
import { Stop } from "./stop.ts";
import { TraceBook } from "./trace.ts";
import type {
  BaseRef,
  CachePort,
  ProviderRef,
  RoutedProviders,
  RowResult,
  RunOptions,
  RunResult,
  Span,
  Tracer,
} from "./types.ts";
import { validBase } from "./validate.ts";

/**
 * Reads the requested providers for the base rows along the declared routes. Rejects with a
 * `DefinitionError` before reading anything when the routes cannot run, with the signal's reason
 * when `options.signal` aborts, and with what failed the run when a load throws what rejects it.
 * `options.ctx` is checked against the graph's `Ctx` (`NoInfer`: the graph alone says what it is),
 * and may be left out when that admits `undefined`. A provider with no route from one of the base
 * rows' entities does not compile, when those are literals (`RoutedProviders`). A run given no `cache` keeps nothing, the
 * scopes of its gates included, so an approval covers its own gate id only: a resume whose keys
 * come in parts (some loaded meanwhile by another call) stops at a gate of its own. A runner given
 * no cache keeps those scopes (`createRunner`); else give a cache. A runner (`createRunner`) gives the options
 * that hold for the process once.
 */
export function run<
  Meta,
  Ctx,
  R extends AnyRoute,
  const Ps extends readonly ProviderRef[] = readonly string[],
  const Rs extends readonly BaseRef[] = readonly BaseRef[],
>(
  graph: Graph<Entities, Ctx, Meta, R>,
  options: RunOptions<NoInfer<Ctx>, Ps, Rs> &
    NoInfer<{ readonly providers: RoutedProviders<Ps, R, Rs[number]["entity"]> }>,
): Promise<RunResult<Ps>> {
  // the run answers every requested provider of every row, as ProviderResults types it
  return runWith(graph, options, "plan") as Promise<unknown> as Promise<RunResult<Ps>>;
}

/**
 * How a result names a base row: `run` by the row's own id; a runner's `read` by its key's id,
 * computed of the key as parsed (runner.ts). Called with each row once its key is parsed and before
 * anything is read: what it throws rejects the run.
 */
export type RowNaming = (row: string, ref: RefNode) => string;

/**
 * `run`, with the rule that decides when a job starts (schedule.ts): `plan`, what `run` does, or
 * `barrier`, the rule it replaced (a wave starts once every read of the wave before ended), kept
 * so that the property tests can compare the two; and how the result names its rows. Not part of
 * the package's API.
 */
export async function runWith<Meta, Ctx>(
  graph: GraphDef<Meta>,
  options: RunOptions<Ctx, readonly ProviderRef[]>,
  rule: "plan" | "barrier",
  name: RowNaming = (row) => row,
): Promise<RunResult> {
  const tracer = options.tracer ? guarded(options.tracer) : QUIET;
  const span = tracer.startSpan("hopgraph.run", {
    "hopgraph.rows": options.refs.length,
    "hopgraph.providers": options.providers.length,
  });
  try {
    const result = await runSpanned(graph, options, rule, name, tracer, span);
    span.setAttribute("hopgraph.status", result.status);
    span.setAttribute("hopgraph.gates", result.gates.length);
    span.setAttribute("hopgraph.billed_bytes", result.billedBytes);
    return result;
  } catch (error) {
    // aborted by its caller, or failed: by the error's code and class, never its message
    const aborted = options.signal?.aborted === true && error === options.signal.reason;
    span.setAttribute("hopgraph.status", aborted ? "aborted" : "failed");
    span.recordError(described(error));
    throw error;
  } finally {
    span.end();
  }
}

async function runSpanned<Meta, Ctx>(
  graph: GraphDef<Meta>,
  options: RunOptions<Ctx, readonly ProviderRef[]>,
  rule: "plan" | "barrier",
  name: RowNaming,
  tracer: Tracer,
  span: Span,
): Promise<RunResult> {
  const def: GraphDef<unknown> = graph;
  const planned = plan(
    def,
    options.refs.map((r) => r.entity),
    options.providers.map((p) => providerId(def, p)),
  );
  const caps = runCaps(options.caps);
  const limits = runLimits(options.limits);

  // the shared objects are checked before the run holds a timer or a listener
  const health = healthOf(options.health);
  const flights = flightsOf(options.inflight);
  const clock = options.clock ?? Date.now;
  const validate = options.validate ?? "boundaries";
  const cache = options.cache ?? NO_CACHE;
  const stop = new Stop(options.deadline, clock, options.signal);
  const show = showKeys(def.entities, options.digest ?? keyDigest);
  const trace = new TraceBook();
  const gates = new Gates();
  const refs = new RefStore(def.entities);
  const reads = new Reads({
    entities: def.entities,
    refs,
    ctx: options.ctx,
    restriction: options.restriction ?? "",
    readable: options.readable ?? READ_ALL,
    cache,
    limits: new Limits(limits),
    health,
    approvals: new Approvals(options.approved ?? {}, cache),
    stop,
    gates,
    show,
    fatal: options.fatal ?? (() => false),
    retryable: options.retryable ?? (() => false),
    strict: validate === "strict",
    prices: new Map(options.prices ?? []),
    now: clock,
    tracer,
    span,
    reach: rule === "plan" ? reachOf(def, planned.nodes) : everything,
    ...(flights ? { flights } : {}),
  });
  const ctx: StepContext = { graph: def, caps, refs, reads, trace, clock, validate };
  const hydration = new Hydration(ctx);
  const relations = new Relations(ctx, hydration);
  const providers = new Providers(ctx, hydration);
  const ledger: Ledger = {
    relation: (id, ref) => evaluated(relations.result(id, ref)),
    provider: (id, ref) => evaluated(providers.answer(id, ref)),
    hydration: (ref) => hydration.record(ref),
  };

  let base: Array<{ readonly row: string; readonly ref: RefNode }> = [];
  try {
    // the base rows are the caller's: one that fails its schemas rejects the run before any read
    const given =
      validate === "off" ? options.refs : await stop.race(validBase(def.entities, options.refs));
    base = given.map((r) => {
      const ref = baseRef(refs, r);
      return { row: name(r.row, ref), ref };
    });
    const starts = base.map((b) => b.ref);
    await stop.race(execute(planned, { relations, providers, reads }, starts));
    // a failure held until its wave was done fails the run, even when every step has ended
    const failed = reads.failure();
    if (failed) throw failed.error;
  } catch (error) {
    // nothing new starts once the run has failed, and what runs is aborted: a refused approval
    // must not leave loads billing
    stop.halt(error);
    throw error;
  } finally {
    stop.close();
  }

  const routes = routesByBase(planned.routes);
  // base rows of one ref share one answer: the same reads, the same chains from the same ref
  const answered = new Map<string, RowResult>();
  const rows = new Map<string, RowResult>();
  for (const { row, ref: start } of base) {
    let result = answered.get(start.id);
    if (!result) {
      result = attribute(ledger, routes.get(start.entity) ?? [], start, show);
      answered.set(start.id, result);
    }
    rows.set(row, result);
  }

  const stopped = gates.list();
  const { jobs, waves } = reads.stats();
  span.setAttribute("hopgraph.jobs", jobs);
  span.setAttribute("hopgraph.waves", waves);
  span.setAttribute("hopgraph.deadline_passed", stop.passed());
  return {
    status: stopped.length > 0 ? "gated" : "complete",
    gates: stopped,
    rows,
    trace: trace.steps(),
    billedBytes: trace.billedBytes(),
    prices: reads.prices(),
  };
}

/** The `readable` of a run given none: every connector. */
const READ_ALL = () => true as const;

/** The cache of a run given none: a store that keeps nothing. Every run reads its sources, and an
 *  approval covers its own gate id only, since the scope of a gate is kept in the cache. */
const NO_CACHE: CachePort = {
  getMany: async () => new Map(),
  setMany: async () => undefined,
};

/** The tracer of a run given none: spans that keep nothing. */
const NO_SPAN: Span = {
  setAttribute: () => undefined,
  addEvent: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};
const QUIET: Tracer = { startSpan: () => NO_SPAN };

/**
 * The application's tracer, whose failures never reach the run: a span that fails to start is no
 * span, and its children hang on the nearest span that did; a method that throws, or returns a
 * promise that rejects (an async method type-checks as one returning nothing), does nothing.
 * Telemetry that breaks must not break a read, nor the process after it. A span the run hands
 * back as a parent is the tracer's own again.
 */
function guarded(tracer: Tracer): Tracer {
  const theirs = new WeakMap<Span, Span>();
  const quietly = (work: () => unknown) => {
    try {
      const out = work();
      if (typeof (out as PromiseLike<unknown> | undefined)?.then === "function")
        Promise.resolve(out).catch(() => undefined);
    } catch {
      // the tracer's failure is not the run's
    }
  };
  return {
    startSpan(name, attributes, parent) {
      const above = parent && theirs.get(parent);
      let span: Span;
      try {
        span = tracer.startSpan(name, attributes, above);
      } catch {
        // a quiet span of its own, standing for the nearest real one to its children
        const quiet: Span = { ...NO_SPAN };
        if (above) theirs.set(quiet, above);
        return quiet;
      }
      const ours: Span = {
        setAttribute: (key, value) => quietly(() => span.setAttribute(key, value)),
        addEvent: (event, attrs) => quietly(() => span.addEvent(event, attrs)),
        recordError: (error) => quietly(() => span.recordError(error)),
        end: () => quietly(() => span.end()),
      };
      theirs.set(ours, span);
      return ours;
    },
  };
}

/** A requested provider's id; a provider passed as itself must be the graph's own. */
function providerId(graph: GraphDef<unknown>, provider: ProviderRef): string {
  if (typeof provider === "string") return provider;
  if (graph.providers.get(provider.id) !== provider)
    throw new DefinitionError(
      "HG_FOREIGN",
      `provider "${provider.id}" was not declared on this graph`,
    );
  return provider.id;
}

/** A base row's ref, its key's id computed of the parsed key; an `id` that throws on it refuses the
 *  row by its place, as a key that fails its schema is, never by the key or what `id` said. */
function baseRef(refs: RefStore, row: BaseRef): RefNode {
  try {
    return refs.intern(row.entity, row.key, row.carries);
  } catch {
    throw new ValidationError([{ row: row.row, entity: row.entity, field: "key" }]);
  }
}

function routesByBase(routes: readonly PlannedRoute[]): Map<string, PlannedRoute[]> {
  const out = new Map<string, PlannedRoute[]>();
  for (const route of routes) out.set(route.base, [...(out.get(route.base) ?? []), route]);
  return out;
}
