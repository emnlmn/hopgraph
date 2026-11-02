// The stop of a run read directly (run/stop.ts) and the slots of a connector (run/limits.ts): the
// cases a run cannot be made to reach by itself. Time is a fake clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AbortedError } from "../../core/index.ts";
import { Stop, sleep } from "../stop.ts";

describe("stop", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a deadline timer that fires after the caller aborted changes nothing: the signal keeps the caller's reason", () => {
    const caller = new AbortController();
    const reason = new Error("caller gave up");
    const stop = new Stop(Date.now() + 1_000, Date.now, caller.signal);
    caller.abort(reason);
    expect(stop.signal.reason).toBe(reason);

    vi.advanceTimersByTime(1_000);
    expect(stop.signal.reason).toBe(reason);
    expect(stop.signal.reason).not.toBeInstanceOf(AbortedError);
    stop.close();
  });

  it("a wait on a signal already aborted ends false at once, with no timer set", async () => {
    const aborted = new AbortController();
    aborted.abort();
    expect(await sleep(1_000, aborted.signal)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
