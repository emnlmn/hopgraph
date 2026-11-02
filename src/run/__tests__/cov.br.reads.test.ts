// Edges of the reads layer on its own: what a waiting step offers that is not taken, a failure that
// holds back the jobs of later waves and waits for the jobs of its own, a later wave's failure that
// comes after an earlier one, and the guard on the reads' own bookkeeping.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type Envelope,
  entity,
  HopgraphError,
  hopgraph,
  type Ref,
  type Retention,
} from "../../core/index.ts";
import { Approvals, Gates } from "../gates.ts";
import { healthOf } from "../health.ts";
import { Limits } from "../limits.ts";
import { kept, Reads } from "../reads.ts";
import { RefStore, showKeys } from "../refs.ts";
import { everything, Lane, type Reach } from "../schedule.ts";
import { Stop } from "../stop.ts";
import type { CachedAnswer, CachePort, Span, Tracer } from "../types.ts";

class QuotaError extends Error {
  override name = "QuotaError";
}

class NoCache implements CachePort {
  async getMany(): Promise<ReadonlyMap<string, CachedAnswer>> {
    return new Map();
  }
  async setMany(): Promise<void> {}
}

const quiet: Span = {
  setAttribute: () => undefined,
  addEvent: () => undefined,
  recordError: () => undefined,
  end: () => undefined,
};

type MasterRef = Ref<string, { window?: string; region?: string }>;

/** What a loader's load does before it answers each key `key@window`. */
type Behave = (refs: readonly MasterRef[]) => Promise<void> | void;

/**
 * Loaders `a`, `b`, `c` that need a window (a context attribute), and `r` that also needs a region
 * (an attribute a hydration would give). Each records the keys of its calls.
 */
function setup(
  behave: Partial<Record<"a" | "b" | "c" | "r", Behave>> = {},
  reach = everything,
  tracer: Tracer = { startSpan: () => quiet },
) {
  const calls: Record<string, string[][]> = { a: [], b: [], c: [], r: [] };
  const g = hopgraph<object, unknown>().entities({
    master: entity({
      key: z.string(),
      carries: { window: z.string(), region: z.string() },
      context: ["window"],
    }),
  });
  for (const id of ["a", "b", "c", "r"] as const)
    g.loader({
      id,
      version: 1,
      keyedBy: "master",
      needs: id === "r" ? ["window", "region"] : ["window"],
      connectors: { allOf: ["db"] },
      batch: { by: "partition" },
      keep: (): Retention => "day",
      partial: "keep",
      load: async (refs: readonly MasterRef[]): Promise<Envelope<string, string>> => {
        calls[id]?.push(refs.map((r) => r.key));
        await behave[id]?.(refs);
        const values = refs.map((r) => [r.key, `${r.key}@${r.window}`] as const);
        return { values, absent: [], unknown: [], cut: [], billedBytes: 0, errors: [] };
      },
    });
  const def = g.graph();
  const refs = new RefStore(def.entities);
  const stop = new Stop(undefined, () => 0);
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
    stop,
    gates: new Gates(),
    show: showKeys(def.entities, (_e, k) => k),
    fatal: (error) => error instanceof QuotaError,
    retryable: () => false,
    strict: false,
    tracer,
    span: quiet,
    reach,
  });
  const loader = (id: string) => {
    const l = def.loaders.get(id);
    if (!l) throw new Error(id);
    return l;
  };
  const at = (master: string, given: { window?: string; region?: string } = { window: "w" }) =>
    refs.intern("master", master, given);
  return { reads, loader, at, calls, stop };
}

/** A promise settled from outside. */
function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets the reads' scheduler run its pending turns. */
const turns = async (n = 5) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
};

/** Each node reads only the loader its id ends with. */
const own: Reach = (node, loader) => node.endsWith(loader);

describe("Reads: offers not taken", () => {
  it("a ref that lacks a need its hydration gives, or a context value, is not offered; a ref with every need is", async () => {
    const { reads, loader, at, calls } = setup();
    const r = loader("r");
    const whole = at("WHOLE", { window: "w", region: "eu" });
    const unhydrated = at("UNHYDRATED", { window: "w" });
    const contextless = at("CONTEXTLESS", { region: "eu" });
    reads.anticipate("waiting", "s-wait", r, [whole, unhydrated, contextless], r.needs, 0);
    await reads.read(new Lane("later", 1), "s-later", r, [
      at("ASKED", { window: "w", region: "eu" }),
    ]);
    expect(calls.r).toEqual([["ASKED", "WHOLE"]]);
  });

  it("an offered key an earlier wave already answered is not loaded again", async () => {
    const { reads, loader, at, calls } = setup();
    const a = loader("a");
    await reads.read(new Lane("first", 0), "s1", a, [at("K")]);
    reads.anticipate("waiting", "s2", a, [at("K")], a.needs, 0);
    const later = await reads.read(new Lane("later", 1), "s3", a, [at("L")]);
    expect(calls.a).toEqual([["K"], ["L"]]);
    expect(later.loaded.size).toBe(1);
  });
});

describe("Reads: a failure and the waves around it", () => {
  it("a job of a later wave than the failure does not start: the run fails with the failure", async () => {
    const { reads, loader, at, calls, stop } = setup({
      a: () => {
        throw new QuotaError("quota spent");
      },
    });
    const failed = reads.read(new Lane("first", 0), "s1", loader("a"), [at("K")]);
    // a step already in wave 1 reads b in wave 2: behind the read of a, under the barrier
    void reads.read(new Lane("second", 1), "s2", loader("b"), [at("L")]);
    expect((await failed).answers.get(at("K").id)).toEqual({
      kind: "unknown",
      reason: { reason: "failed" },
    });
    await turns();
    expect(calls.b).toEqual([]);
    expect(reads.stats().jobs).toBe(1);
    expect(stop.stopped()).toBe(true);
    expect(reads.failure()?.error).toBeInstanceOf(QuotaError);
  });

  it("a job of the failed wave that has not started holds the failure back until it is done, and loads nothing", async () => {
    const slow = deferred();
    const { reads, loader, at, calls, stop } = setup(
      {
        a: () => slow.promise,
        b: () => {
          throw new QuotaError("quota spent");
        },
      },
      (node, l) => (node === "nA" ? l === "a" || l === "c" : node.endsWith(l)),
    );
    // c's job of wave 2 waits for nA, which may still read c
    const c = reads.read(new Lane("nc", 1), "s-c", loader("c"), [at("C")]);
    const a = reads.read(new Lane("nA", 0), "s-a", loader("a"), [at("A")]);
    const b = reads.read(new Lane("nb", 1), "s-b", loader("b"), [at("B")]);
    await b;
    await turns();
    expect(stop.stopped()).toBe(false);
    slow.resolve();
    expect((await a).answers.get(at("A").id)).toMatchObject({ kind: "found" });
    expect((await c).answers.get(at("C").id)).toEqual({
      kind: "unknown",
      reason: { reason: "failed" },
    });
    await turns();
    expect(calls.c).toEqual([]);
    expect(stop.stopped()).toBe(true);
    expect(reads.failure()?.error).toBeInstanceOf(QuotaError);
  });

  it("an error a later wave's job throws after an earlier wave failed does not replace that failure, even from a smaller step", async () => {
    const first = deferred();
    const second = deferred();
    // b's job span throws once it is told what the keys came to: its job throws, as step s0's
    const tracer: Tracer = {
      startSpan: (_name, attrs) =>
        attrs?.["hopgraph.loader"] === "b" && attrs["hopgraph.wave"] !== undefined
          ? {
              ...quiet,
              setAttribute: (name) => {
                if (name === "hopgraph.found") throw new QuotaError("tracer");
              },
            }
          : quiet,
    };
    const { reads, loader, at } = setup(
      { a: () => first.promise, b: () => second.promise },
      own,
      tracer,
    );
    const a = reads.read(new Lane("na", 0), "s9", loader("a"), [at("A")]);
    const b = reads.read(new Lane("nb", 1), "s0", loader("b"), [at("B")]);
    await turns();
    first.reject(new QuotaError("first"));
    await Promise.all([a, b]);
    await turns();
    expect(reads.failure()?.error).toMatchObject({ message: "first" });
  });
});

describe("kept", () => {
  it("gives back what the reads' bookkeeping holds, and refuses a missing one as the executor's bug", () => {
    expect(kept(0, "x")).toBe(0);
    expect(() => kept(undefined, "a job started that no read asks")).toThrow(
      new HopgraphError("HG_INTERNAL", "a job started that no read asks"),
    );
  });
});
