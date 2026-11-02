// The calls of a run (run/calls.ts): the retry that gets no verdict because the run's clock passed
// the deadline while it waited, and how a retry is told in the trace. Time is a fake clock for the
// timers and a hand-moved one for the run's own, so the deadline passes without any timer firing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { envelope, type Retry } from "../../core/index.ts";
import { type RunOptions, run } from "../index.ts";
import {
  type Ctx,
  free,
  m,
  NOW,
  newGraph,
  options,
  providerOf,
  recorder,
  refs,
  stepsOf,
  traceOf,
} from "./support.ts";

class Down extends Error {
  override name = "Down";
}

/** A master's duration: each attempt of its load (and of its dry run, when `metered`) runs `onLoad`
 *  (`onPrice`) and throws `Down` while `fails` says so; `limits` bounds the connector's slots. */
function build(p: {
  retry?: Retry;
  metered?: boolean;
  onLoad?: (call: number) => void;
  onPrice?: (call: number) => void;
  failLoads?: number;
  failPrices?: number;
}) {
  const clock = { now: NOW };
  const loads: string[][] = [];
  let priced = 0;
  const g = newGraph();
  const common = {
    ...free,
    id: "durations",
    keyedBy: "master",
    connectors: { allOf: ["wh"] },
    batch: { by: "one", concurrency: 8 },
    ...(p.retry ? { retry: p.retry } : {}),
    load: async (keys: readonly { readonly key: string }[]) => {
      loads.push(keys.map((k) => k.key));
      p.onLoad?.(loads.length);
      if (loads.length <= (p.failLoads ?? 0)) throw new Down();
      return envelope(
        keys.map((r) => [r.key, { kind: "found", value: { minutes: 1 } }] as const),
        p.metered ? 10 : 0,
      );
    },
  } as const;
  const durations = p.metered
    ? g.loader({
        ...common,
        cost: { metered: { auto: 100, approve: 1000 } },
        price: async () => {
          priced += 1;
          p.onPrice?.(priced);
          if (priced <= (p.failPrices ?? 0)) throw new Down();
          return 0;
        },
      })
    : g.loader(common);
  const graph = g.graph(
    g.route(
      "master",
      g.provider("minutes", {
        loader: durations,
        temporal: "current",
        rows: "one",
        project: (v: { minutes: number }) => [{ minutes: v.minutes }],
        raw: { minutes: m("Minutes") },
      }),
      g.itself("master"),
    ),
  );
  const ask = (keys: string[], over: Partial<RunOptions<Ctx>> = {}) =>
    run(
      graph,
      options({
        refs: refs("master", ...keys),
        providers: ["minutes"],
        clock: () => clock.now,
        retryable: (e) => e instanceof Down,
        ...over,
      }),
    );
  return { ask, clock, loads, priced: () => priced };
}

describe("run: calls", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a retry after an error with no code of its own says its class as the code, and no class", async () => {
    const { ask } = build({ retry: { attempts: 2, initialMs: 1, jitter: "none" }, failLoads: 1 });
    const { tracer, spans } = recorder();
    const running = ask(["m1"], { tracer });
    await vi.runAllTimersAsync();
    await running;

    const [load] = spans.filter((s) => s.name === "hopgraph.load");
    expect(load?.events).toEqual([
      {
        name: "hopgraph.retry",
        attributes: { "hopgraph.attempt": 2, "hopgraph.error.code": "Down" },
      },
    ]);
  });

  it("a retry that finds the deadline passed on the run's clock after its wait is not made: the failure stands, not a deadline", async () => {
    const { ask, clock, loads } = build({
      retry: { attempts: 3, initialMs: 10, jitter: "none" },
      failLoads: 1,
      onLoad: () => {
        // the deadline passes on the run's clock while the retry waits, no timer fires
        setTimeout(() => {
          clock.now = NOW + 1_001;
        }, 5);
      },
    });
    const running = ask(["m1"], { deadline: NOW + 1_000 });
    await vi.advanceTimersByTimeAsync(20);
    const result = await running;

    expect(loads).toEqual([["m1"]]);
    expect(stepsOf(result, "m1", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(traceOf(result, "provider:minutes")).toMatchObject({
      retries: 0,
      errors: [{ code: "Down", keys: 1 }],
    });
  });

  it("a dry run retried after the deadline passed on the run's clock is not made again: the failure stands, nothing is loaded", async () => {
    const { ask, clock, loads, priced } = build({
      metered: true,
      retry: { attempts: 3, initialMs: 10, jitter: "none" },
      failPrices: 1,
      onPrice: () => {
        setTimeout(() => {
          clock.now = NOW + 1_001;
        }, 5);
      },
    });
    const running = ask(["m1"], { deadline: NOW + 1_000 });
    await vi.advanceTimersByTimeAsync(20);
    const result = await running;

    expect(priced()).toBe(1);
    expect(loads).toEqual([]);
    expect(providerOf(result, "m1", "minutes").unknown).toHaveLength(1);
    expect(traceOf(result, "provider:minutes")).toMatchObject({ retries: 0 });
  });

  it("a load that gets its connector slot after the deadline passed on the run's clock does not start", async () => {
    const { ask, clock, loads } = build({
      onLoad: () => {
        clock.now = NOW + 1_001;
      },
    });
    const running = ask(["m1", "m2"], { deadline: NOW + 1_000, limits: { db: 8, wh: 1, api: 8 } });
    await vi.advanceTimersByTimeAsync(10);
    const result = await running;

    expect(loads).toHaveLength(1);
    for (const row of ["m1", "m2"])
      expect(providerOf(result, row, "minutes").unknown).toEqual([{ reason: "deadline" }]);
  });
});
