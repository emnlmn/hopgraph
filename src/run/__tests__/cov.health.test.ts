// The connectors' health read directly (run/health.ts): the cases of a circuit and a rate that a
// run does not reach by itself (a verdict told twice, a probe given up on and replaced, a retry
// asking a half-open circuit, a token asked with a signal already aborted). Time is a fake clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Entry, healthOf } from "../health.ts";
import { createHealth } from "../index.ts";

const BREAKER = { breaker: { failures: 1, windowMs: 1_000, coolDownMs: 5_000 } } as const;

/** The entry as a call let through; a refusal fails the test. */
function passed(entry: Entry): Extract<Entry, { kind: "pass" }> {
  if (entry.kind !== "pass") throw new Error("expected the call to pass");
  return entry;
}

/** A health whose `wh` circuit is open since now. */
function tripped() {
  const health = healthOf(createHealth({ wh: BREAKER }));
  passed(health.enter(["wh"])).end(false);
  return health;
}

describe("health: circuits", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("the verdict of a call told twice counts once: a probe that answered closes the circuit, and a later 'threw' does not reopen it", () => {
    const health = tripped();
    vi.advanceTimersByTime(5_000);
    const probe = passed(health.enter(["wh"]));
    expect(probe.probe).toBe(true);
    probe.end(true);
    probe.end(false);
    expect(health.state("wh")).toBe("closed");
  });

  it("a probe given up on after a cool-down is replaced by another, and the first one's late verdict says nothing", () => {
    const health = tripped();
    vi.advanceTimersByTime(5_000);
    const first = passed(health.enter(["wh"]));
    // the first probe hangs for a whole cool-down: a second call is let through as the probe
    vi.advanceTimersByTime(5_000);
    const second = passed(health.enter(["wh"]));
    expect(second.probe).toBe(true);

    first.end(false);
    expect(health.state("wh")).toBe("half-open");
    // the second probe is still the one running: the circuit stays shut to a third call
    expect(health.enter(["wh"])).toEqual({ kind: "open", connectors: ["wh"] });

    second.end(true);
    expect(health.state("wh")).toBe("closed");
  });

  it("a retry is tried into a half-open circuit only while no probe is running", () => {
    const health = tripped();
    expect(health.refuses(["wh"])).toBe(true);
    vi.advanceTimersByTime(5_000);
    expect(health.state("wh")).toBe("half-open");
    expect(health.refuses(["wh"])).toBe(false);

    const probe = passed(health.enter(["wh"]));
    expect(health.refuses(["wh"])).toBe(true);
    probe.end(true);
    expect(health.refuses(["wh"])).toBe(false);
  });
});

describe("health: rates", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a call whose signal is already aborted gets no token when none is free, and takes none from the line", async () => {
    const health = healthOf(createHealth({ wh: { rate: { perSecond: 1, burst: 1 } } }));
    const never = new AbortController().signal;
    expect(await health.take(["wh"], never)).toBeDefined();

    const aborted = new AbortController();
    aborted.abort();
    expect(await health.take(["wh"], aborted.signal)).toBeUndefined();

    // the next token goes to the next live call, one second later
    const next = health.take(["wh"], never);
    let got = false;
    void next.then(() => {
      got = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(got).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(got).toBe(true);
  });
});
