// The reads layer: batches and layers, the texts it keys by, the trace it feeds, and on its own how
// a step's refs become load calls and which failures stay inside a read (its keys failed) or reject
// it (a refused approval, an error the application calls fatal).

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CostChangedError,
  type Envelope,
  entity,
  hopgraph,
  type Ref,
  type Retention,
} from "../../core/index.ts";
import { Approvals, Gates } from "../gates.ts";
import { healthOf } from "../health.ts";
import { isData, stableJson } from "../ids.ts";
import { batchesOf, layersOf } from "../job.ts";
import { Limits } from "../limits.ts";
import { Reads } from "../reads.ts";
import { RefStore, showKeys } from "../refs.ts";
import { everything, Lane } from "../schedule.ts";
import { Stop } from "../stop.ts";
import { TraceBook } from "../trace.ts";
import type { CachedAnswer, CachePort, Span } from "../types.ts";

describe("batchesOf", () => {
  const keys = ["a", "b", "c", "d", "e"];

  it("N keys per call, one call for all, or one key per call; nothing for no keys", () => {
    expect(batchesOf({ by: "keys", max: 2 }, keys)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
    expect(batchesOf({ by: "partition" }, keys)).toEqual([keys]);
    expect(batchesOf({ by: "one", concurrency: 4 }, ["a", "b"])).toEqual([["a"], ["b"]]);
    expect(batchesOf({ by: "partition" }, [])).toEqual([]);
  });
});

describe("layersOf", () => {
  it("never puts one key twice in a layer: the first ref of each key, then the second", () => {
    const k = (keyId: string, n: number) => ({ ref: { keyId }, n });
    const layers = layersOf([k("t1", 1), k("t2", 2), k("t1", 3), k("t1", 4)]);
    expect(layers.map((layer) => layer.map((x) => x.n))).toEqual([[1, 2], [3], [4]]);
  });
});

describe("ids", () => {
  it("stable JSON ignores the order keys were set in and spells out bigints", () => {
    expect(stableJson({ b: 1, a: { d: 2n, c: [1] } })).toBe(
      stableJson({ a: { c: [1], d: 2n }, b: 1 }),
    );
  });

  it("data is primitives, dates and plain containers of them; a client or a function is not", () => {
    expect([1, "x", null, new Date(0), [1, { a: true }], Object.create(null)].every(isData)).toBe(
      true,
    );
    class Client {}
    expect([() => 1, new Client(), { client: new Client() }, new Map()].some(isData)).toBe(false);
  });
});

describe("TraceBook", () => {
  it("adds every evaluation of a step, counts per outcome and reason, retries, and failures per code", () => {
    const trace = new TraceBook();
    const stats = (errors: { code: string; keys: number }[]) => ({
      keysIn: 2,
      cached: 1,
      billedBytes: 10,
      ms: 3,
      retries: 1,
      errors,
    });
    trace.record("provider:x", "x", stats([{ code: "E", keys: 1 }]), [
      { outcome: "found", cuts: [{ kind: "cap", limit: 5 }] },
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    trace.record("provider:x", "x", stats([{ code: "E", keys: 2 }]), [
      { outcome: "absent" },
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(trace.steps()).toEqual([
      {
        step: "provider:x",
        loader: "x",
        keysIn: 4,
        cached: 2,
        found: 1,
        absent: 1,
        unknown: { failed: 2 },
        cut: 1,
        billedBytes: 20,
        ms: 6,
        retries: 2,
        errors: [{ code: "E", keys: 3 }],
      },
    ]);
    expect(trace.billedBytes()).toBe(20);
  });
});

class QuotaError extends Error {
  override name = "QuotaError";
}

class NoCache implements CachePort {
  async getMany(): Promise<ReadonlyMap<string, CachedAnswer>> {
    return new Map();
  }
  async setMany(): Promise<void> {}
}

type MasterRef = Ref<string, { window: string }>;

/** A master loader that needs a window (a context attribute), answering `master@window`. */
function setup(behave: { load?: () => void; price?: () => number } = {}) {
  const calls: { key: string; window: string }[][] = [];
  const g = hopgraph<unknown, string, object>().entities({
    master: entity({ key: z.string(), carries: { window: z.string() }, context: ["window"] }),
  });
  const common = {
    version: 1,
    keyedBy: "master",
    needs: ["window"],
    connectors: { allOf: ["db"] },
    batch: { by: "partition" },
    keep: (): Retention => "day",
    partial: "keep",
    load: async (refs: readonly MasterRef[]): Promise<Envelope<string, string>> => {
      calls.push(refs.map((r) => ({ key: r.key, window: r.window })));
      behave.load?.();
      const values = refs.map((r) => [r.key, `${r.key}@${r.window}`] as const);
      return { values, absent: [], unknown: [], cut: [], billedBytes: 0, errors: [] };
    },
  } as const;
  g.loader({ ...common, id: "free" });
  g.loader({
    ...common,
    id: "metered",
    cost: { metered: { auto: 10, approve: 100 } },
    price: async () => behave.price?.() ?? 0,
  });
  const def = g.graph();
  const refs = new RefStore(def.entities);
  const reads = new Reads({
    entities: def.entities,
    refs,
    ctx: {},
    restriction: "r",
    prices: new Map(),
    now: Date.now,
    readable: () => true,
    cache: new NoCache(),
    limits: new Limits({}),
    health: healthOf(undefined),
    approvals: new Approvals({}, new NoCache()),
    stop: new Stop(undefined, () => 0),
    gates: new Gates(),
    show: showKeys(def.entities, (_e, k) => k),
    fatal: (error) => error instanceof QuotaError,
    retryable: () => false,
    strict: false,
    tracer: { startSpan: () => quiet },
    span: quiet,
    reach: everything,
  });
  const loader = (id: string) => {
    const l = def.loaders.get(id);
    if (!l) throw new Error(id);
    return l;
  };
  const at = (master: string, window: string) => refs.intern("master", master, { window });
  return { reads, loader, at, calls };
}

const quiet: Span = {
  setAttribute: () => undefined,
  addEvent: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

/** A step's lane at the start of the run. */
const lane = () => new Lane("node", 0);

describe("Reads: calls", () => {
  it("one key with two need values: two loader keys in separate calls, each answered for its ref", async () => {
    const { reads, loader, at, calls } = setup();
    const a = at("TRK-0042", "w1");
    const b = at("TRK-0042", "w2");
    const c = at("TRK-0077", "w1");
    const read = await reads.read(lane(), "step", loader("free"), [a, b, c]);

    expect(calls).toEqual([
      [
        { key: "TRK-0042", window: "w1" },
        { key: "TRK-0077", window: "w1" },
      ],
      [{ key: "TRK-0042", window: "w2" }],
    ]);
    expect(read.answers.get(a.id)).toMatchObject({ kind: "found", value: "TRK-0042@w1" });
    expect(read.answers.get(b.id)).toMatchObject({ kind: "found", value: "TRK-0042@w2" });
  });

  it("the same key and values asked twice is one loader key, read once", async () => {
    const { reads, loader, at, calls } = setup();
    const [first, again] = await Promise.all([
      reads.read(lane(), "one", loader("free"), [at("TRK-0042", "w1")]),
      reads.read(lane(), "two", loader("free"), [at("TRK-0042", "w1")]),
    ]);
    expect(calls).toHaveLength(1);
    expect(again.cached).toBe(1);
    expect(first.answers).toEqual(again.answers);
  });
});

describe("Reads: failures", () => {
  it("a load that throws fails its keys and keeps the error's class only", async () => {
    const { reads, loader, at } = setup({
      load: () => {
        throw new TypeError("connection to db.internal:3306 refused for TRK-0042");
      },
    });
    const ref = at("TRK-0042", "w1");
    const read = await reads.read(lane(), "step", loader("free"), [ref]);
    expect(read.answers.get(ref.id)).toEqual({ kind: "unknown", reason: { reason: "failed" } });
    expect(read.errors).toEqual([{ code: "TypeError", keys: 1 }]);
  });

  it("a thrown error's own code is kept with its class; a code or a name that is not an identifier is not", async () => {
    const thrown: unknown[] = [
      Object.assign(new Error("read ECONNRESET 10.0.0.7"), { code: "ECONNRESET" }),
      Object.assign(new TypeError("bad"), { code: 1205 }),
      Object.assign(new RangeError("bad"), { code: "value TRK-0042 is out of range" }),
      Object.assign(new Error("bad"), { name: "failed for TRK-0042" }),
      "a string thrown",
    ];
    const kept = [];
    for (const error of thrown) {
      const { reads, loader, at } = setup({
        load: () => {
          throw error;
        },
      });
      kept.push(
        ...(await reads.read(lane(), "step", loader("free"), [at("TRK-0042", "w1")])).errors,
      );
    }
    expect(kept).toEqual([
      { code: "ECONNRESET", class: "Error", keys: 1 },
      { code: "1205", class: "TypeError", keys: 1 },
      { code: "RangeError", keys: 1 },
      { code: "Error", keys: 1 },
      { code: "thrown", keys: 1 },
    ]);
  });

  it("a load that refuses a grown cost, or throws what the application calls fatal, fails the run: the read's keys fail, the error is held for it", async () => {
    const grown = setup({
      load: () => {
        throw new CostChangedError("g", 1, 2);
      },
    });
    const ref = grown.at("A", "w");
    const read = await grown.reads.read(lane(), "s", grown.loader("free"), [ref]);
    expect(read.answers.get(ref.id)).toEqual({ kind: "unknown", reason: { reason: "failed" } });
    expect(grown.reads.failure()?.error).toBeInstanceOf(CostChangedError);
    const spent = setup({
      price: () => {
        throw new QuotaError("quota spent");
      },
    });
    await spent.reads.read(lane(), "s", spent.loader("metered"), [spent.at("A", "w")]);
    expect(spent.reads.failure()?.error).toBeInstanceOf(QuotaError);
  });

  it("a dry run that fails otherwise fails the keys it priced; nothing is loaded", async () => {
    const { reads, loader, at, calls } = setup({
      price: () => {
        throw new Error("dry run refused");
      },
    });
    const ref = at("TRK-0042", "w1");
    const read = await reads.read(lane(), "step", loader("metered"), [ref]);
    expect(read.answers.get(ref.id)).toEqual({ kind: "unknown", reason: { reason: "failed" } });
    expect(read.errors).toEqual([{ code: "Error", keys: 1 }]);
    expect(calls).toEqual([]);
  });

  it("a price at the auto cap runs ungated, with the price as budget", async () => {
    const { reads, loader, at } = setup({ price: () => 10 });
    const ref = at("TRK-0042", "w1");
    const read = await reads.read(lane(), "step", loader("metered"), [ref]);
    expect(read.answers.get(ref.id)?.kind).toBe("found");
  });
});
