// The deadline and cancellation (DESIGN.md §5.3; run/types.ts `deadline`, `signal`). Past the
// deadline nothing starts, the loads running are aborted and not waited for, and the run answers:
// what finished stands, the rest is unknown `deadline`. Aborted by its caller, the run rejects at
// once with the signal's reason. Failed, it aborts what runs. The tests drive time with fake timers
// and loaders that honour their signal or ignore it.

import { afterEach, describe, expect, it, vi } from "vitest";
import { type Envelope, envelope } from "../../core/index.ts";
import { type RunOptions, run } from "../index.ts";
import {
  type Ctx,
  fake,
  free,
  MemoryCache,
  m,
  NOW,
  newGraph,
  options,
  providerOf,
  refs,
  stepsOf,
} from "./support.ts";

function build() {
  const clock = { now: NOW };
  const f = {
    plays: fake<{ plays: number }>({ found: { t1: { plays: 10 } } }),
    recordings: fake<{ master: string }[]>({ found: { t1: [{ master: "m1" }, { master: "m2" }] } }),
    masterInfo: fake<{ minutes: number }>({ found: { m1: { minutes: 1 }, m2: { minutes: 2 } } }),
  };
  const g = newGraph();
  const playsL = g.loader({
    ...free,
    id: "trackPlays",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.plays.load,
  });
  const recordingsL = g.loader({
    ...free,
    id: "recordings",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.recordings.load,
  });
  const masterInfoL = g.loader({
    ...free,
    id: "masterInfo",
    keyedBy: "master",
    connectors: { allOf: ["db"] },
    load: f.masterInfo.load,
  });
  const mastered = g.relation("track", "master", "mastered", {
    cardinality: "1:N",
    strategies: (s) => [s(recordingsL, { project: (_ref, v) => v.map((x) => ({ to: x.master })) })],
  });
  const plays = g.provider("plays", {
    loader: playsL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ plays: v.plays }],
    raw: { plays: m("Plays") },
  });
  const masterInfo = g.provider("masterInfo", {
    loader: masterInfoL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ minutes: v.minutes }],
    raw: { minutes: m("Minutes") },
  });
  return {
    graph: g.graph(
      g.route("track", plays, g.itself("track")),
      g.route("track", masterInfo, g.path(mastered)),
    ),
    f,
    clock,
    mastered,
  };
}

describe("run: deadline", () => {
  it("a deadline already past: no step starts and every requested provider is unknown deadline", async () => {
    const { graph, f } = build();
    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["plays", "masterInfo"],
        deadline: NOW - 1,
      }),
    );

    expect(f.plays.calls).toEqual([]);
    expect(f.recordings.calls).toEqual([]);
    expect(f.masterInfo.calls).toEqual([]);
    for (const id of ["plays", "masterInfo"]) {
      const p = providerOf(result, "t1", id);
      expect(p.outcome, id).toBe("unknown");
      expect(p.rows, id).toEqual([]);
      expect(p.unknown, id).toEqual([{ reason: "deadline" }]);
    }
  });

  it("a deadline the clock passes while a load runs: its answer comes late and is dropped, nothing after starts, nothing is kept", async () => {
    const { graph, f, clock, mastered } = build();
    f.recordings.is.onLoad = () => {
      clock.now = NOW + 5_000;
    };
    const cache = new MemoryCache();
    const result = await run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["masterInfo"],
        deadline: NOW + 1_000,
        clock: () => clock.now,
        cache,
      }),
    );

    expect(f.recordings.loaded()).toEqual(["t1"]);
    expect(f.masterInfo.calls).toEqual([]);
    expect(stepsOf(result, "t1", mastered.id)).toMatchObject([
      { ref: "t1", outcome: "unknown", reason: { reason: "deadline" } },
    ]);
    const p = providerOf(result, "t1", "masterInfo");
    expect(p.outcome).toBe("unknown");
    expect(p.unknown).toEqual([{ reason: "deadline" }]);
    expect(cache.sets).toEqual([]);

    // what came late was not kept: the next run reads it again
    await run(graph, options({ refs: refs("track", "t1"), providers: ["masterInfo"], cache }));
    expect(f.recordings.calls).toHaveLength(2);
    expect(f.masterInfo.loaded()).toEqual(["m1", "m2"]);
  });
});

/** How a cancellable fake load behaves: when it answers (fake milliseconds), and whether it stops
 *  when its signal aborts (rejecting with the signal's reason, as `fetch` does). */
interface Pace {
  readonly ms: number;
  readonly honours: boolean;
  /** throws this when it would answer */
  readonly throws?: unknown;
}

/** A load over a table that records the signal of each call and resolves `started` per call. */
function paced<V>(table: Readonly<Record<string, V>>, pace: Pace) {
  const signals: AbortSignal[] = [];
  let started: () => void = () => undefined;
  const start = new Promise<void>((resolve) => (started = resolve));
  const load = (
    keys: readonly { readonly key: string }[],
    _ctx: unknown,
    _budget: unknown,
    signal: AbortSignal,
  ) => {
    signals.push(signal);
    started();
    return new Promise<Envelope<string, V>>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pace.throws) return reject(pace.throws);
        resolve(
          envelope(keys.map((r) => [r.key, { kind: "found", value: table[r.key] as V }] as const)),
        );
      }, pace.ms);
      if (pace.honours)
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        });
    });
  };
  return { load, signals, start };
}

/** A track's plays (one loader) and its masters' durations (through its recordings): each load paced. */
function cancellable(p: { plays: Pace; recordings: Pace; limit?: number; meteredPrice?: Pace }) {
  const plays = paced({ t1: { plays: 10 } }, p.plays);
  const recordings = paced({ t1: [{ master: "m1" }] }, p.recordings);
  const durations = paced({ m1: { minutes: 1 } }, { ms: 1, honours: true });
  const priced: AbortSignal[] = [];
  const g = newGraph();
  const playsL = g.loader({
    ...free,
    id: "trackPlays",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: plays.load,
  });
  const recordingsL = p.meteredPrice
    ? g.loader({
        ...free,
        id: "recordings",
        keyedBy: "track",
        connectors: { allOf: ["db"] },
        cost: { metered: { auto: 1e9, approve: 1e11 } },
        price: (_refs, _ctx, signal) => {
          priced.push(signal);
          return new Promise<number>((resolve) => setTimeout(() => resolve(1), p.meteredPrice?.ms));
        },
        load: recordings.load,
      })
    : g.loader({
        ...free,
        id: "recordings",
        keyedBy: "track",
        connectors: { allOf: ["db"] },
        load: recordings.load,
      });
  const durationsL = g.loader({
    ...free,
    id: "durations",
    keyedBy: "master",
    connectors: { allOf: ["db"] },
    load: durations.load,
  });
  const mastered = g.relation("track", "master", "mastered", {
    cardinality: "1:N",
    strategies: (s) => [
      s(recordingsL, {
        project: (_ref, v: { master: string }[]) => v.map((x) => ({ to: x.master })),
      }),
    ],
  });
  const cache = new MemoryCache();
  const graph = g.graph(
    g.route(
      "track",
      g.provider("plays", {
        loader: playsL,
        temporal: "historical",
        rows: "one",
        project: (v: { plays: number }) => [{ plays: v.plays }],
        raw: { plays: m("Plays") },
      }),
      g.itself("track"),
    ),
    g.route(
      "track",
      g.provider("durations", {
        loader: durationsL,
        temporal: "historical",
        rows: "one",
        project: (v: { minutes: number }) => [{ minutes: v.minutes }],
        raw: { minutes: m("Minutes") },
      }),
      g.path(mastered),
    ),
  );
  const ask = (over: Partial<RunOptions<Ctx>> = {}) =>
    run(
      graph,
      options({
        refs: refs("track", "t1"),
        providers: ["plays", "durations"],
        cache,
        limits: { db: p.limit ?? 8 },
        ...over,
      }),
    );
  return { ask, cache, plays, recordings, durations, priced, mastered };
}

describe("run: cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const fakeTime = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("at the deadline the loads running are aborted and not waited for: what finished stands and is kept, the rest is unknown deadline", async () => {
    fakeTime();
    const c = cancellable({
      plays: { ms: 500, honours: true },
      // ignores its signal and would answer in an hour
      recordings: { ms: 3_600_000, honours: false },
    });
    const pending = c.ask({ deadline: NOW + 1_000 });
    await Promise.all([c.plays.start, c.recordings.start]);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(providerOf(result, "t1", "plays").outcome).toBe("found");
    expect(c.plays.signals.map((s) => s.aborted)).toEqual([true]);
    expect(c.recordings.signals[0]?.reason).toMatchObject({ code: "HG_ABORTED", why: "deadline" });
    expect(stepsOf(result, "t1", c.mastered.id)).toMatchObject([
      { outcome: "unknown", reason: { reason: "deadline" } },
    ]);
    expect(providerOf(result, "t1", "durations").unknown).toEqual([{ reason: "deadline" }]);
    expect(c.durations.signals).toEqual([]);
    expect(c.cache.sets.map((s) => s.answer)).toEqual([{ kind: "found", value: { plays: 10 } }]);
  });

  it("a load that stops on its signal at the deadline is unknown deadline, never failed", async () => {
    fakeTime();
    const c = cancellable({
      plays: { ms: 3_600_000, honours: true },
      recordings: { ms: 3_600_000, honours: true },
    });
    const pending = c.ask({ deadline: NOW + 1_000 });
    await Promise.all([c.plays.start, c.recordings.start]);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(providerOf(result, "t1", "plays").unknown).toEqual([{ reason: "deadline" }]);
    expect(stepsOf(result, "t1", c.mastered.id)).toMatchObject([
      { outcome: "unknown", reason: { reason: "deadline" } },
    ]);
    expect(result.trace.flatMap((t) => t.errors)).toEqual([]);
  });

  it("a load waiting for a connector slot at the deadline gives up: the run answers", async () => {
    fakeTime();
    // one slot on db: one load holds it and ignores its signal, the other waits for it
    const c = cancellable({
      plays: { ms: 3_600_000, honours: false },
      recordings: { ms: 3_600_000, honours: false },
      limit: 1,
    });
    const pending = c.ask({ deadline: NOW + 1_000 });
    await Promise.race([c.plays.start, c.recordings.start]);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(c.plays.signals.length + c.recordings.signals.length).toBe(1);
    expect(providerOf(result, "t1", "plays").unknown).toEqual([{ reason: "deadline" }]);
    expect(providerOf(result, "t1", "durations").unknown).toEqual([{ reason: "deadline" }]);
  });

  it("a dry run running at the deadline is aborted and not waited for: nothing is loaded, no gate", async () => {
    fakeTime();
    const c = cancellable({
      plays: { ms: 1, honours: true },
      recordings: { ms: 1, honours: true },
      meteredPrice: { ms: 3_600_000, honours: false },
    });
    const pending = c.ask({ deadline: NOW + 1_000 });
    await c.plays.start;
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(c.priced.map((s) => s.aborted)).toEqual([true]);
    expect(c.recordings.signals).toEqual([]);
    expect(result.gates).toEqual([]);
    expect(providerOf(result, "t1", "durations").unknown).toEqual([{ reason: "deadline" }]);
  });

  it("aborted by its caller, the run rejects at once with the signal's reason; the loads see it, nothing after starts", async () => {
    const c = cancellable({
      plays: { ms: 3_600_000, honours: true },
      recordings: { ms: 3_600_000, honours: false },
    });
    const caller = new AbortController();
    const pending = c.ask({ signal: caller.signal });
    await Promise.all([c.plays.start, c.recordings.start]);
    const reason = new Error("the viewer left");
    caller.abort(reason);

    await expect(pending).rejects.toBe(reason);
    expect([...c.plays.signals, ...c.recordings.signals].map((s) => s.reason)).toEqual([
      reason,
      reason,
    ]);
    expect(c.durations.signals).toEqual([]);
    expect(c.cache.sets).toEqual([]);
  });

  it("a signal aborted before the run: it rejects with its reason, a DOMException when none, reading nothing", async () => {
    const c = cancellable({
      plays: { ms: 1, honours: true },
      recordings: { ms: 1, honours: true },
    });
    const reason = new Error("too late");
    await expect(c.ask({ signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    const controller = new AbortController();
    controller.abort();
    await expect(c.ask({ signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(c.plays.signals).toEqual([]);
    expect(c.cache.gets).toEqual([]);
  });

  it("a run that fails aborts the loads still running, saying it failed and why", async () => {
    const quota = Object.assign(new Error("quota spent"), { name: "QuotaError" });
    const c = cancellable({
      plays: { ms: 3_600_000, honours: false },
      recordings: { ms: 5, honours: true, throws: quota },
    });
    const pending = c.ask({ fatal: (e) => e === quota });
    await expect(pending).rejects.toBe(quota);
    expect(c.plays.signals[0]?.reason).toMatchObject({
      code: "HG_ABORTED",
      why: "failed",
      cause: quota,
    });
  });
});
