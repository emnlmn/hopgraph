// When a load may start (run/limits.ts) and when the run stops (run/stop.ts): slots per connector
// that a waiter gives up when the run stops, and the one signal that the caller's abort, the
// deadline and a failure all end.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AbortedError } from "../../core/index.ts";
import { Limits, Semaphore } from "../limits.ts";
import { Stop } from "../stop.ts";

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));

/** The release of a slot that must be granted. */
async function granted(slot: Promise<(() => void) | undefined>): Promise<() => void> {
  const release = await slot;
  if (!release) throw new Error("expected a slot");
  return release;
}

/** Runs `n` tasks that each hold `take()` for a tick; returns the most held at once. */
async function peak(n: number, take: () => Promise<(() => void) | undefined>): Promise<number> {
  let now = 0;
  let max = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      const release = await granted(take());
      now += 1;
      max = Math.max(max, now);
      await tick();
      now -= 1;
      release();
    }),
  );
  return max;
}

describe("Semaphore", () => {
  it("lets no more than its size in at once, and all of them through", async () => {
    const slots = new Semaphore(2);
    expect(await peak(5, () => slots.acquire())).toBe(2);
  });

  it("a release called twice frees one slot only", async () => {
    const slots = new Semaphore(1);
    const release = await granted(slots.acquire());
    release();
    release();
    const a = await granted(slots.acquire());
    let second = false;
    void slots.acquire().then(() => {
      second = true;
    });
    await tick();
    expect(second).toBe(false);
    a();
  });

  it("a waiter whose signal aborts gives up and leaves the queue; the slot goes to the next", async () => {
    const slots = new Semaphore(1);
    const held = await granted(slots.acquire());
    const controller = new AbortController();
    const quitter = slots.acquire(controller.signal);
    const next = slots.acquire();
    controller.abort();
    expect(await quitter).toBeUndefined();
    held();
    expect(await next).toBeTypeOf("function");
    // an aborted signal gets no slot, even a free one
    expect(await new Semaphore(1).acquire(controller.signal)).toBeUndefined();
  });
});

describe("Limits", () => {
  it("a load holds every connector it reads: two loaders on one connector share its limit", async () => {
    const limits = new Limits({ db: 2, wh: 5 });
    expect(await peak(6, () => limits.hold(["db", "wh"]))).toBe(2);
  });

  it("a connector given no limit does not bound its loads", async () => {
    const limits = new Limits({});
    expect(await peak(4, () => limits.hold(["api"]))).toBe(4);
  });

  it("a loader's own bound holds alongside its connector's", async () => {
    const limits = new Limits({ db: 8 });
    const own = new Semaphore(3);
    expect(await peak(6, () => limits.hold(["db"], own))).toBe(3);
  });

  it("a hold given up while waiting for one slot gives back the slots it took", async () => {
    const limits = new Limits({ db: 1, wh: 1 });
    const wh = await granted(limits.hold(["wh"]));
    const controller = new AbortController();
    const both = limits.hold(["db", "wh"], undefined, controller.signal);
    await tick();
    controller.abort();
    expect(await both).toBeUndefined();
    // db was taken first, then given back
    const db = await granted(limits.hold(["db"]));
    db();
    wh();
  });
});

describe("Stop", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops strictly after its instant by the clock, never without one, and at once when halted", () => {
    let now = 100;
    const at = new Stop(100, () => now);
    expect(at.stopped()).toBe(false);
    now = 101;
    expect(at.stopped()).toBe(true);
    expect(at.signal.reason).toEqual(new AbortedError("deadline"));
    at.close();
    const none = new Stop(undefined, () => now);
    expect(none.stopped()).toBe(false);
    const failure = new Error("boom");
    none.halt(failure);
    expect(none.stopped()).toBe(true);
    expect(none.signal.reason).toMatchObject({ code: "HG_ABORTED", why: "failed", cause: failure });
  });

  it("its timer aborts the signal at the deadline; the run's work goes on and is not refused", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = new Stop(1_000, () => 0);
    const pending = new Promise<string>(() => undefined);
    const waited = stop.within(pending);
    const work = stop.race(Promise.resolve("answered"));
    await vi.advanceTimersByTimeAsync(999);
    expect(stop.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stop.signal.aborted).toBe(true);
    expect(await waited).toEqual({ done: false });
    expect(await work).toBe("answered");
    stop.close();
  });

  it("close clears the timer: a run that ended never aborts later", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const stop = new Stop(1_000, () => 0);
    stop.close();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(stop.signal.aborted).toBe(false);
  });

  it("the caller's abort aborts the signal with its reason and refuses the work, even past the deadline", async () => {
    let now = 0;
    const caller = new AbortController();
    const stop = new Stop(10, () => now, caller.signal);
    const work = stop.race(new Promise<never>(() => undefined));
    now = 11;
    expect(stop.stopped()).toBe(true);
    const reason = new Error("the viewer left");
    caller.abort(reason);
    await expect(work).rejects.toBe(reason);
    // what the loads saw first stays: the deadline
    expect(stop.signal.reason).toMatchObject({ why: "deadline" });
    stop.close();
  });

  it("an already aborted caller refuses at once; a failure refuses with what failed", async () => {
    const reason = new Error("gone");
    const aborted = new Stop(undefined, () => 0, AbortSignal.abort(reason));
    expect(aborted.signal.reason).toBe(reason);
    await expect(aborted.race(Promise.resolve(1))).rejects.toBe(reason);

    const failing = new Stop(undefined, () => 0);
    const work = failing.race(new Promise<never>(() => undefined));
    const failure = new Error("quota");
    failing.halt(failure);
    await expect(work).rejects.toBe(failure);
  });

  it("within: the work's value, its error, or late; what it does after is dropped", async () => {
    const stop = new Stop(undefined, () => 0);
    expect(await stop.within(Promise.resolve(3))).toEqual({ done: true, value: 3 });
    await expect(stop.within(Promise.reject(new Error("x")))).rejects.toThrow("x");
    let fail: (e: unknown) => void = () => undefined;
    const late = stop.within(new Promise((_, reject) => (fail = reject)));
    stop.halt(new Error("stop"));
    expect(await late).toEqual({ done: false });
    // a rejection after the stop surfaces nowhere (the test would fail on an unhandled one)
    fail(new Error("after"));
    expect(await stop.within(Promise.reject(new Error("already")))).toEqual({ done: false });
  });
});
