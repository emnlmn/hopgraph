// Tracing and metrics (DESIGN.md §6; run/types.ts Tracer): a run given a tracer reports itself as
// spans. The run is one; each job (a loader's reads in one wave) is a child of it; each job's cache
// read, dry runs, calls and cache writes are children of the job. Their attributes are ids, counts,
// bytes, durations and outcomes, and a job's are the loader's metrics: keys, cache hits, calls,
// attempts, retries, bytes billed, time. A failure is recorded by its code and class; no key, value
// or message ever reaches a span.

import { describe, expect, it } from "vitest";
import { CostChangedError, envelope } from "../../core/index.ts";
import { createHealth, type RunOptions, run, type Tracer } from "../index.ts";
import {
  type Ctx,
  free,
  MemoryCache,
  m,
  newGraph,
  options,
  type Recorded,
  recorder,
} from "./support.ts";

const ADDRESS = "ada@example.com";
const TRACK = "track-0042";

/** A track reaches its contact address (a personal key) through `contacts`, whose first
 *  `failures` calls throw a reset naming the address; a metered `sends` loader reads the address. */
function build(o: { failures?: number; price?: number } = {}) {
  let failures = o.failures ?? 0;
  const g = newGraph();
  const contacts = g.loader({
    ...free,
    id: "contacts",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    retry: { attempts: 2, initialMs: 0 },
    load: async (keys) => {
      if (failures-- > 0)
        throw Object.assign(new Error(`reset while reading ${ADDRESS}`), { code: "ECONNRESET" });
      return envelope(
        keys.map((r) => [r.key, { kind: "found", value: { to: [ADDRESS] } }] as const),
      );
    },
  });
  const sends = g.loader({
    ...free,
    id: "sends",
    keyedBy: "email",
    connectors: { allOf: ["wh"] },
    cost: { metered: { auto: 1_000, approve: 100_000 } },
    price: async () => o.price ?? 500,
    load: async (keys) =>
      envelope(
        keys.map((r) => [r.key, { kind: "found", value: { n: 3 } }] as const),
        400,
      ),
  });
  const contact = g.relation("track", "email", "contact", {
    cardinality: "N:1",
    strategies: (s) => [s(contacts, { project: (_ref, v) => v.to.map((to) => ({ to })) })],
  });
  return {
    graph: g.graph(
      g.route(
        "track",
        g.provider("sends", {
          loader: sends,
          temporal: "historical",
          rows: "one",
          project: (v) => [{ n: v.n }],
          raw: { n: m("Sends") },
        }),
        g.path(contact),
      ),
    ),
    contact,
  };
}

function ask(graph: ReturnType<typeof build>["graph"], over: Partial<RunOptions<Ctx>> = {}) {
  return run(
    graph,
    options({
      refs: [{ row: "r1", entity: "track", key: TRACK }],
      providers: ["sends"],
      retryable: (e) => e instanceof Error && Reflect.get(e, "code") === "ECONNRESET",
      ...over,
    }),
  );
}

const named = (spans: readonly Recorded[], name: string) => spans.filter((s) => s.name === name);
const job = (spans: readonly Recorded[], loader: string): Recorded => {
  const found = named(spans, "hopgraph.batch").find(
    (s) => s.attributes["hopgraph.loader"] === loader,
  );
  if (!found) throw new Error(`no job of ${loader}`);
  return found;
};
const under = (spans: readonly Recorded[], parent: Recorded) =>
  spans.filter((s) => s.parent === parent).map((s) => s.name);

describe("run: tracing", () => {
  it("a run is a span; each job a child of it; each cache read, dry run, call and cache write a child of its job", async () => {
    const { graph } = build();
    const { tracer, spans } = recorder();
    await ask(graph, { tracer });

    const [root, ...rest] = spans;
    expect(root?.name).toBe("hopgraph.run");
    expect(root?.parent).toBeUndefined();
    for (const span of named(rest, "hopgraph.batch")) expect(span.parent).toBe(root);
    expect(under(spans, job(spans, "contacts"))).toEqual([
      "hopgraph.cache.read",
      "hopgraph.load",
      "hopgraph.cache.write",
    ]);
    expect(under(spans, job(spans, "sends"))).toEqual([
      "hopgraph.cache.read",
      "hopgraph.price",
      "hopgraph.load",
      "hopgraph.cache.write",
    ]);
    expect(spans.every((s) => s.ended)).toBe(true);
  });

  it("a job's span holds the loader's metrics: keys, cache hits, calls, attempts, retries, bytes, outcomes, time", async () => {
    const { graph, contact } = build({ failures: 1 });
    const cache = new MemoryCache();
    const cold = recorder();
    const result = await ask(graph, { tracer: cold.tracer, cache });

    expect(job(cold.spans, "contacts").attributes).toMatchObject({
      "hopgraph.loader": "contacts",
      "hopgraph.wave": 1,
      "hopgraph.steps": [contact.id],
      "hopgraph.keys": 1,
      "hopgraph.cache.hits": 0,
      "hopgraph.inflight.hits": 0,
      "hopgraph.admission": "free",
      "hopgraph.loaded": 1,
      "hopgraph.calls": 1,
      "hopgraph.attempts": 2,
      "hopgraph.retries": 1,
      "hopgraph.billed_bytes": 0,
      "hopgraph.found": 1,
      "hopgraph.absent": 0,
      "hopgraph.unknown": 0,
    });
    const sends = job(cold.spans, "sends");
    expect(sends.attributes).toMatchObject({
      "hopgraph.wave": 2,
      "hopgraph.steps": ["provider:sends"],
      "hopgraph.admission": "auto",
      "hopgraph.price_bytes": 500,
      "hopgraph.gate": expect.stringMatching(/^sends:[0-9a-f]{64}$/),
      "hopgraph.calls": 1,
      "hopgraph.attempts": 1,
      "hopgraph.billed_bytes": 400,
      "hopgraph.found": 1,
    });
    for (const key of [
      "hopgraph.waited_ms",
      "hopgraph.cache_ms",
      "hopgraph.price_ms",
      "hopgraph.load_ms",
    ])
      expect(sends.attributes[key]).toBeGreaterThanOrEqual(0);
    expect(cold.spans[0]?.attributes).toMatchObject({
      "hopgraph.rows": 1,
      "hopgraph.providers": 1,
      "hopgraph.status": "complete",
      "hopgraph.gates": 0,
      "hopgraph.billed_bytes": result.billedBytes,
      "hopgraph.jobs": 2,
      "hopgraph.waves": 2,
      "hopgraph.deadline_passed": false,
    });

    // the same run again: every key from the cache, nothing called
    const warm = recorder();
    await ask(graph, { tracer: warm.tracer, cache });
    for (const loader of ["contacts", "sends"])
      expect(job(warm.spans, loader).attributes).toMatchObject({
        "hopgraph.keys": 1,
        "hopgraph.cache.hits": 1,
        "hopgraph.admission": "cached",
        "hopgraph.calls": 0,
        "hopgraph.billed_bytes": 0,
      });
  });

  it("a call says how it ended, the circuit it met and each retry, its failure by code and class", async () => {
    const { graph } = build({ failures: 1 });
    const { tracer, spans } = recorder();
    await ask(graph, { tracer });

    const [load] = named(spans, "hopgraph.load").filter(
      (s) => s.attributes["hopgraph.loader"] === "contacts",
    );
    expect(load?.attributes).toMatchObject({
      "hopgraph.keys": 1,
      "hopgraph.connectors": ["db"],
      "hopgraph.outcome": "done",
      "hopgraph.attempts": 2,
      "hopgraph.circuit": "closed",
    });
    expect(load?.events).toEqual([
      {
        name: "hopgraph.retry",
        attributes: {
          "hopgraph.attempt": 2,
          "hopgraph.error.code": "ECONNRESET",
          "hopgraph.error.class": "Error",
        },
      },
    ]);

    // with no retry left, the call ends failed, by its code and class
    const failing = build({ failures: 2 });
    const twice = recorder();
    await ask(failing.graph, { tracer: twice.tracer });
    const [failed] = named(twice.spans, "hopgraph.load");
    expect(failed?.attributes).toMatchObject({
      "hopgraph.outcome": "threw",
      "hopgraph.attempts": 2,
    });
    expect(failed?.errors).toEqual([{ code: "ECONNRESET", class: "Error", keys: 1 }]);
  });

  it("an open circuit is a call refused: its span says so", async () => {
    const { graph } = build({ failures: 99 });
    const health = createHealth({
      db: { breaker: { failures: 1, windowMs: 60_000, coolDownMs: 60_000 } },
    });
    await ask(graph, { health, retryable: () => false });
    const { tracer, spans } = recorder();
    await ask(graph, { health, tracer });

    const [load] = named(spans, "hopgraph.load");
    expect(load?.attributes).toMatchObject({
      "hopgraph.circuit": "open",
      "hopgraph.outcome": "open",
      "hopgraph.attempts": 0,
    });
    expect(load?.errors).toEqual([{ code: "HG_CIRCUIT_OPEN", keys: 1 }]);
  });

  it("a gated job says its gate and price; a run that fails records its error on the run's span", async () => {
    const { graph } = build({ price: 5_000 });
    const cache = new MemoryCache();
    const gated = recorder();
    const first = await ask(graph, { tracer: gated.tracer, cache });
    const gate = first.gates[0];
    if (!gate) throw new Error("expected a gate");
    expect(job(gated.spans, "sends").attributes).toMatchObject({
      "hopgraph.admission": "gated",
      "hopgraph.gate": gate.id,
      "hopgraph.price_bytes": 5_000,
      "hopgraph.calls": 0,
    });
    expect(gated.spans[0]?.attributes).toMatchObject({
      "hopgraph.status": "gated",
      "hopgraph.gates": 1,
    });

    const refused = recorder();
    const error = await ask(graph, {
      tracer: refused.tracer,
      cache,
      approved: { [gate.id]: gate.bytes - 1 },
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CostChangedError);
    expect(refused.spans[0]?.attributes["hopgraph.status"]).toBe("failed");
    expect(refused.spans[0]?.errors).toEqual([
      { code: "HG_COST_CHANGED", class: "CostChangedError" },
    ]);
    expect(job(refused.spans, "sends").attributes["hopgraph.admission"]).toBe("refused");

    const aborting = new AbortController();
    aborting.abort(new Error("the page was closed"));
    const aborted = recorder();
    await ask(graph, { tracer: aborted.tracer, signal: aborting.signal }).catch(() => undefined);
    expect(aborted.spans[0]?.attributes["hopgraph.status"]).toBe("aborted");
    expect(aborted.spans[0]?.errors).toEqual([{ code: "Error" }]);
  });

  it("no key, personal or not, and no message of a source's error reaches a span", async () => {
    const { graph } = build({ failures: 2 });
    const { tracer, spans } = recorder();
    await ask(graph, { tracer });

    const text = JSON.stringify(
      spans.map((s) => ({ name: s.name, a: s.attributes, e: s.events, x: s.errors })),
    );
    expect(text).not.toContain(ADDRESS);
    expect(text).not.toContain(TRACK);
    expect(text).not.toContain("reset while reading");
  });

  it("a tracer that throws never changes the run: the run answers as it does with none", async () => {
    const { graph } = build();
    const plain = await ask(graph);
    const broken = (where: "start" | "end"): Tracer => ({
      startSpan: (name) => {
        if (where === "start" && name === "hopgraph.batch") throw new Error("exporter down");
        const fails = () => {
          throw new Error("exporter down");
        };
        return { setAttribute: fails, addEvent: fails, recordError: fails, end: fails };
      },
    });
    for (const where of ["start", "end"] as const) {
      const answered = await Promise.race([
        ask(graph, { tracer: broken(where) }),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`hung (${where})`)), 1_000)),
      ]);
      expect(answered, where).toEqual(plain);
    }
  });
});
