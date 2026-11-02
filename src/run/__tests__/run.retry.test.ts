// Retries (DESIGN.md §5.7; core `Retry`, run/types.ts `retryable`). A call that throws an error the
// run calls retryable is tried again as its loader's policy says, after an exponential backoff
// with full jitter that never ends past the deadline; never for a fatal error; a metered one only
// on what is left of its wave's budget. The trace counts the retries. Time is a fake clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DefinitionError, envelope, type Retry } from "../../core/index.ts";
import { createHealth, type RunOptions, run } from "../index.ts";
import { type Ctx, free, m, newGraph, options, refs, stepsOf, traceOf } from "./support.ts";

class Reset extends Error {
  override name = "Reset";
  readonly code = "ECONNRESET";
}
class Quota extends Error {
  override name = "Quota";
}

/** What one attempt does: answer, or throw this. */
type Step = "answer" | Error;

/**
 * A master's duration read by a loader that follows `script`, one step per attempt (the last step
 * repeats), and records the fake clock's time and the budget of each attempt. A metered loader is
 * priced by `price`, a script of its own.
 */
function build(p: {
  retry?: Retry;
  script: readonly Step[];
  metered?: { readonly price: readonly (number | Error)[] };
}) {
  const attempts: { at: number; maxBytes: number | undefined }[] = [];
  const priced: number[] = [];
  const next = <T>(script: readonly T[], n: number): T =>
    script[Math.min(n, script.length - 1)] as T;
  const g = newGraph();
  const common = {
    ...free,
    id: "durations",
    keyedBy: "master",
    connectors: { allOf: ["wh"] },
    ...(p.retry ? { retry: p.retry } : {}),
    load: async (
      keys: readonly { readonly key: string }[],
      _ctx: unknown,
      budget: { readonly maxBytes: number | undefined },
    ) => {
      const step = next(p.script, attempts.length);
      attempts.push({ at: Date.now(), maxBytes: budget.maxBytes });
      if (step !== "answer") throw step;
      return envelope(
        keys.map((r) => [r.key, { kind: "found", value: { minutes: 1 } }] as const),
        p.metered ? 10 : 0,
      );
    },
  } as const;
  const metered = p.metered;
  const durations = metered
    ? g.loader({
        ...common,
        cost: { metered: { auto: 100, approve: 1000 } },
        price: async () => {
          const step = next(metered.price, priced.length);
          priced.push(Date.now());
          if (step instanceof Error) throw step;
          return step;
        },
      })
    : g.loader(common);
  const start = Date.now();
  const ask = (over: Partial<RunOptions<Ctx>> = {}) =>
    run(
      g.graph(
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
      ),
      options({
        refs: refs("master", "m1"),
        providers: ["minutes"],
        clock: Date.now,
        retryable: (e) => e instanceof Reset,
        ...over,
      }),
    );
  /** when each attempt started, from the run's start */
  const times = () => attempts.map((a) => a.at - start);
  return { ask, attempts, priced, times };
}

/** Runs to the end, the fake clock moving as far as it must. */
async function settle<T>(running: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return running;
}

describe("run: retries", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a call that throws an error the run calls retryable is tried again after its wait, and the trace counts the retry", async () => {
    const { ask, times } = build({
      retry: { attempts: 3, initialMs: 100, jitter: "none" },
      script: [new Reset(), "answer"],
    });
    const running = ask();
    await vi.advanceTimersByTimeAsync(99);
    expect(times()).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(times()).toEqual([0, 100]);
    const result = await settle(running);

    const trace = traceOf(result, "provider:minutes");
    expect(trace).toMatchObject({ found: 1, retries: 1, errors: [] });
    expect(stepsOf(result, "m1", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
  });

  it("nothing is retried unless the run says which errors are retryable", async () => {
    const { ask, times } = build({ retry: { attempts: 3 }, script: [new Reset(), "answer"] });
    const result = await settle(ask({ retryable: undefined }));

    expect(times()).toEqual([0]);
    expect(traceOf(result, "provider:minutes")).toMatchObject({
      unknown: { failed: 1 },
      retries: 0,
      errors: [{ code: "ECONNRESET", class: "Reset", keys: 1 }],
    });
  });

  it("nothing is retried for a loader without a policy, nor for an error the run does not call retryable", async () => {
    const without = build({ script: [new Reset(), "answer"] });
    await settle(without.ask());
    expect(without.times()).toEqual([0]);

    const other = build({ retry: { attempts: 3 }, script: [new Error("bad request"), "answer"] });
    await settle(other.ask());
    expect(other.times()).toEqual([0]);
  });

  it("a fatal error is never retried: the run rejects with it", async () => {
    const { ask, times } = build({ retry: { attempts: 3 }, script: [new Quota(), "answer"] });
    const running = ask({ retryable: () => true, fatal: (e) => e instanceof Quota });
    const rejected = expect(running).rejects.toBeInstanceOf(Quota);
    await vi.runAllTimersAsync();
    await rejected;
    expect(times()).toEqual([0]);
  });

  it("`attempts` bounds the calls, the first included; the last failure is what the keys and the trace keep", async () => {
    const { ask, times } = build({
      retry: { attempts: 3, initialMs: 10, jitter: "none" },
      script: [new Reset()],
    });
    const result = await settle(ask());

    expect(times()).toEqual([0, 10, 30]);
    expect(traceOf(result, "provider:minutes")).toMatchObject({
      unknown: { failed: 1 },
      retries: 2,
      errors: [{ code: "ECONNRESET", class: "Reset", keys: 1 }],
    });
  });

  it("each wait's bound is the one before times the factor, up to maxMs", async () => {
    const { ask, times } = build({
      retry: { attempts: 5, initialMs: 100, factor: 3, maxMs: 500, jitter: "none" },
      script: [new Reset()],
    });
    await settle(ask());

    // waits of 100, 300, 500, 500
    expect(times()).toEqual([0, 100, 400, 900, 1400]);
  });

  it("with full jitter (the default) each wait is a random time up to its bound", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { ask, times } = build({ retry: { attempts: 3 }, script: [new Reset()] });
    await settle(ask());

    // bounds of 100 and 200 by default, half of each
    expect(times()).toEqual([0, 50, 150]);
  });

  it("a retry whose wait would end past the deadline is not tried: the keys stay failed", async () => {
    const { ask, times } = build({
      retry: { attempts: 5, initialMs: 100, jitter: "none" },
      script: [new Reset()],
    });
    const result = await settle(ask({ deadline: Date.now() + 350 }));

    // the third wait (400) would end at 700
    expect(times()).toEqual([0, 100, 300]);
    expect(stepsOf(result, "m1", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
  });

  it("a run aborted during a wait stops waiting: nothing is called again", async () => {
    const { ask, times } = build({
      retry: { attempts: 3, initialMs: 100, jitter: "none" },
      script: [new Reset()],
    });
    const caller = new AbortController();
    const running = ask({ signal: caller.signal });
    const rejected = expect(running).rejects.toBe("gone");
    await vi.advanceTimersByTimeAsync(50);
    caller.abort("gone");
    await rejected;
    await vi.runAllTimersAsync();
    expect(times()).toEqual([0]);
  });

  it("a retry is not tried into a circuit the failure opened: the call ends on its own error", async () => {
    const { ask, times } = build({
      retry: { attempts: 3, initialMs: 100, jitter: "none" },
      script: [new Reset()],
    });
    const health = createHealth({
      wh: { breaker: { failures: 1, windowMs: 60_000, coolDownMs: 60_000 } },
    });
    const result = await settle(ask({ health }));

    expect(times()).toEqual([0]);
    expect(stepsOf(result, "m1", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(stepsOf(result, "m1", "provider:minutes")[0]?.reason).not.toHaveProperty("why");
    expect(traceOf(result, "provider:minutes")).toMatchObject({
      retries: 0,
      errors: [{ code: "ECONNRESET", class: "Reset", keys: 1 }],
    });
  });

  it("a retry that cannot start before the deadline (its rate's token comes later) leaves the failure as it was", async () => {
    const { ask, times } = build({
      retry: { attempts: 2, initialMs: 100, jitter: "none" },
      script: [new Reset()],
    });
    const health = createHealth({ wh: { rate: { perSecond: 1, burst: 1 } } });
    const result = await settle(ask({ health, deadline: Date.now() + 500 }));

    expect(times()).toEqual([0]);
    expect(stepsOf(result, "m1", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(traceOf(result, "provider:minutes")).toMatchObject({
      retries: 0,
      errors: [{ code: "ECONNRESET", class: "Reset", keys: 1 }],
    });
  });

  it("a dry run that throws a retryable error is tried again too", async () => {
    const { ask, priced, times } = build({
      retry: { attempts: 2, initialMs: 10, jitter: "none" },
      script: ["answer"],
      metered: { price: [new Reset(), 30] },
    });
    const result = await settle(ask());

    expect(priced).toHaveLength(2);
    expect(times()).toHaveLength(1);
    expect(traceOf(result, "provider:minutes")).toMatchObject({ found: 1, retries: 1 });
  });

  it("a metered load is retried on what is left of its wave's budget: an error that says what it billed spends that much", async () => {
    const { ask, attempts } = build({
      retry: { attempts: 3, initialMs: 10, jitter: "none" },
      script: [Object.assign(new Reset(), { billedBytes: 4 }), "answer"],
      metered: { price: [30] },
    });
    const result = await settle(ask());

    expect(attempts.map((a) => a.maxBytes)).toEqual([30, 26]);
    expect(result.billedBytes).toBe(14);
    expect(traceOf(result, "provider:minutes")).toMatchObject({ found: 1, retries: 1 });
  });

  it("a metered load whose error does not say what it billed has spent its budget: it is not retried", async () => {
    const { ask, attempts } = build({
      retry: { attempts: 3, initialMs: 10, jitter: "none" },
      script: [new Reset(), "answer"],
      metered: { price: [30] },
    });
    const result = await settle(ask());

    expect(attempts.map((a) => a.maxBytes)).toEqual([30]);
    expect(traceOf(result, "provider:minutes")).toMatchObject({
      unknown: { failed: 1 },
      retries: 0,
    });
  });
});

describe("loader retry policy", () => {
  it("the builder refuses a policy that cannot be followed", () => {
    const declare = (retry: Retry) =>
      newGraph().loader({
        ...free,
        id: "x",
        keyedBy: "master",
        connectors: { allOf: ["db"] },
        retry,
        load: async () => envelope<string, never>([]),
      });
    for (const retry of [
      { attempts: 0 },
      { attempts: 1.5 },
      { attempts: 2, initialMs: -1 },
      { attempts: 2, maxMs: Number.POSITIVE_INFINITY },
      { attempts: 2, factor: 0.5 },
      { attempts: 2, jitter: "some" as "full" },
      { attempts: 2, initialMs: 3e9 },
      { attempts: 2, maxMs: 2 ** 31 },
    ])
      expect(() => declare(retry), JSON.stringify(retry)).toThrow(
        expect.objectContaining({ code: "HG_SPEC" }) as DefinitionError,
      );
    expect(() => declare({ attempts: 1 })).not.toThrow();
    expect(() =>
      declare({ attempts: 2, initialMs: 2 ** 31 - 1, maxMs: 2 ** 31 - 1 }),
    ).not.toThrow();
  });
});
