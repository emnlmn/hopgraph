// The connectors' health (DESIGN.md §5.7; run/health.ts). A circuit breaker per connector: after N
// calls threw within a window it opens for a cool-down, its loaders are not called and their keys
// are unknown failed, the connector open; then one probe goes through. A rate limit per connector:
// a token bucket of a burst and a rate. Both live in one object made by `createHealth` and given
// to every run, so they outlive a run. Time is a fake clock.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DefinitionError, envelope } from "../../core/index.ts";
import { type ConnectorHealth, createHealth, type Health, type RunOptions, run } from "../index.ts";
import { type Ctx, free, m, newGraph, options, refs, stepsOf, traceOf } from "./support.ts";

class Down extends Error {
  override name = "Down";
}
class Quota extends Error {
  override name = "Quota";
}

/**
 * Masters' durations read one key per call over the `wh` connector (or `connectors`), by a loader
 * whose source is up or down as `source.down` says, answers after `source.ms`, never answers when
 * `source.hang`, and throws what the run calls fatal when `source.fatal`; it records when each call
 * started. With `metered`, a dry run over the same connectors precedes every load.
 */
function build(
  p: {
    metered?: boolean;
    concurrency?: number;
    connectors?: readonly ["wh" | "db", ...("wh" | "db")[]];
  } = {},
) {
  const source = { down: false, ms: 0, hang: false, fatal: false };
  const started: { at: number; key: string }[] = [];
  const priced: number[] = [];
  const g = newGraph();
  const common = {
    ...free,
    id: "durations",
    keyedBy: "master",
    connectors: { allOf: p.connectors ?? (["wh"] as const) },
    batch: { by: "one", concurrency: p.concurrency ?? 8 },
    load: async (keys: readonly { readonly key: string }[]) => {
      for (const k of keys) started.push({ at: Date.now(), key: k.key });
      if (source.hang) await new Promise(() => undefined);
      if (source.ms > 0) await new Promise((resolve) => setTimeout(resolve, source.ms));
      if (source.fatal) throw new Quota();
      if (source.down) throw new Down();
      return envelope(keys.map((r) => [r.key, { kind: "found", value: { minutes: 1 } }] as const));
    },
  } as const;
  const durations = p.metered
    ? g.loader({
        ...common,
        cost: { metered: { auto: 100, approve: 1000 } },
        price: async () => {
          priced.push(Date.now());
          if (source.down) throw new Down();
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
  const t0 = Date.now();
  const ask = (health: Health, keys: string[], over: Partial<RunOptions<Ctx>> = {}) =>
    run(
      graph,
      options({
        refs: refs("master", ...keys),
        providers: ["minutes"],
        health,
        clock: Date.now,
        fatal: (e) => e instanceof Quota,
        ...over,
      }),
    );
  /** when each call started, from the test's start */
  const times = () => started.map((s) => s.at - t0);
  return { ask, source, started, priced, times };
}

const BREAKER: ConnectorHealth = { breaker: { failures: 2, windowMs: 1_000, coolDownMs: 5_000 } };

/** Runs to the end, the fake clock moving as far as it must. */
async function settle<T>(running: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return running;
}

describe("run: circuit breakers", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("after N calls threw within the window the connector opens: later runs do not call it, and their keys are unknown failed, the connector open", async () => {
    const health = createHealth({ wh: BREAKER });
    const { ask, source, started } = build();
    source.down = true;
    await settle(ask(health, ["m1", "m2"]));
    expect(started).toHaveLength(2);
    expect(health.state("wh")).toBe("open");

    source.down = false;
    const result = await settle(ask(health, ["m3"]));
    expect(started).toHaveLength(2);
    expect(stepsOf(result, "m3", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed", why: "open", connectors: ["wh"] } },
    ]);
    expect(traceOf(result, "provider:minutes").errors).toEqual([
      { code: "HG_CIRCUIT_OPEN", keys: 1 },
    ]);
  });

  it("failures further apart than the window do not open it, and a connector without a breaker never opens", async () => {
    const health = createHealth({ wh: BREAKER });
    const { ask, source, started } = build();
    source.down = true;
    await settle(ask(health, ["m1"]));
    vi.advanceTimersByTime(1_000);
    await settle(ask(health, ["m2"]));
    expect(health.state("wh")).toBe("closed");
    await settle(ask(health, ["m3"]));
    expect(health.state("wh")).toBe("open");
    expect(started).toHaveLength(3);

    const none = createHealth({});
    const other = build();
    other.source.down = true;
    await settle(other.ask(none, ["m1", "m2", "m3"]));
    expect(none.state("wh")).toBe("closed");
  });

  it("after the cool-down one probe goes through while the others are refused; its answer closes the circuit", async () => {
    const health = createHealth({ wh: BREAKER });
    const { ask, source, started } = build();
    source.down = true;
    await settle(ask(health, ["m1", "m2"]));
    vi.advanceTimersByTime(4_999);
    expect(health.state("wh")).toBe("open");
    vi.advanceTimersByTime(1);
    expect(health.state("wh")).toBe("half-open");

    Object.assign(source, { down: false, ms: 50 });
    const result = await settle(ask(health, ["m3", "m4"]));
    expect(started.map((s) => s.key)).toEqual(["m1", "m2", "m3"]);
    expect(stepsOf(result, "m3", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
    expect(stepsOf(result, "m4", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed", why: "open" } },
    ]);
    expect(health.state("wh")).toBe("closed");

    await settle(ask(health, ["m4"]));
    expect(started.map((s) => s.key)).toEqual(["m1", "m2", "m3", "m4"]);
  });

  it("a probe that throws opens the circuit for another cool-down", async () => {
    const health = createHealth({ wh: BREAKER });
    const { ask, source, started } = build();
    source.down = true;
    await settle(ask(health, ["m1", "m2"]));
    vi.advanceTimersByTime(5_000);
    await settle(ask(health, ["m3"]));
    expect(started).toHaveLength(3);
    expect(health.state("wh")).toBe("open");
    vi.advanceTimersByTime(4_999);
    expect(health.state("wh")).toBe("open");
  });

  it("a probe the run stopped waiting for says nothing: the circuit stays half-open for the next call", async () => {
    const health = createHealth({ wh: BREAKER });
    const { ask, source, started } = build();
    source.down = true;
    await settle(ask(health, ["m1", "m2"]));
    vi.advanceTimersByTime(5_000);

    Object.assign(source, { down: true, ms: 500 });
    const late = await settle(ask(health, ["m3"], { deadline: Date.now() + 100 }));
    expect(stepsOf(late, "m3", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "deadline" } },
    ]);
    expect(health.state("wh")).toBe("half-open");

    Object.assign(source, { down: false, ms: 0 });
    await settle(ask(health, ["m4"]));
    expect(started.map((s) => s.key)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(health.state("wh")).toBe("closed");
  });

  it("a dry run is not called on an open connector, and a dry run that throws counts as a failure", async () => {
    const health = createHealth({ wh: BREAKER });
    const { ask, source, priced, started } = build({ metered: true });
    source.down = true;
    await settle(ask(health, ["m1"]));
    await settle(ask(health, ["m2"]));
    expect(priced).toHaveLength(2);
    expect(health.state("wh")).toBe("open");

    const result = await settle(ask(health, ["m3"]));
    expect(priced).toHaveLength(2);
    expect(started).toEqual([]);
    expect(traceOf(result, "provider:minutes")).toMatchObject({
      unknown: { failed: 1 },
      errors: [{ code: "HG_CIRCUIT_OPEN", keys: 1 }],
    });
  });
});

describe("run: circuit breakers, edges", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A health whose wh circuit is half-open: one failure opened it a cool-down ago. */
  async function halfOpen(over: ConnectorHealth = {}) {
    const health = createHealth({ wh: { ...BREAKER, ...over } });
    const built = build();
    built.source.down = true;
    await settle(built.ask(health, ["m1", "m2"]));
    vi.advanceTimersByTime(5_000);
    expect(health.state("wh")).toBe("half-open");
    built.source.down = false;
    return { health, ...built };
  }

  it("a call that waited for a token is refused if the circuit opened meanwhile, and gives the token back", async () => {
    const health = createHealth({
      wh: {
        breaker: { failures: 1, windowMs: 60_000, coolDownMs: 60_000 },
        rate: { perSecond: 20, burst: 1 },
      },
    });
    const { ask, source, started } = build();
    source.down = true;
    const result = await settle(ask(health, ["m1", "m2", "m3", "m4"]));

    expect(started.map((s) => s.key)).toEqual(["m1"]);
    expect(health.state("wh")).toBe("open");
    for (const k of ["m2", "m3", "m4"])
      expect(stepsOf(result, k, "provider:minutes")).toMatchObject([
        { outcome: "unknown", reason: { reason: "failed", why: "open", connectors: ["wh"] } },
      ]);
  });

  it("a probe that has not ended within a cool-down is given up: the next call probes, and its answer closes the circuit", async () => {
    const { health, ask, source, started } = await halfOpen();
    source.hang = true;
    void ask(health, ["m3"]);
    await vi.advanceTimersByTimeAsync(4_999);
    source.hang = false;
    const refused = await settle(ask(health, ["m4"]));
    expect(stepsOf(refused, "m4", "provider:minutes")).toMatchObject([
      { reason: { reason: "failed", why: "open" } },
    ]);

    vi.advanceTimersByTime(1);
    const probed = await settle(ask(health, ["m5"]));
    expect(started.map((s) => s.key)).toEqual(["m1", "m2", "m3", "m5"]);
    expect(stepsOf(probed, "m5", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
    expect(health.state("wh")).toBe("closed");
  });

  it("a probe that throws what the run calls fatal opens the circuit again", async () => {
    const { health, ask, source } = await halfOpen();
    source.fatal = true;
    const failed = ask(health, ["m3"]);
    const rejected = expect(failed).rejects.toBeInstanceOf(Quota);
    await vi.runAllTimersAsync();
    await rejected;
    expect(health.state("wh")).toBe("open");
  });

  it("a probe whose run its caller aborts says nothing: the next call probes", async () => {
    const { health, ask, source, started } = await halfOpen();
    source.ms = 100;
    const caller = new AbortController();
    const aborted = ask(health, ["m3"], { signal: caller.signal });
    const rejected = expect(aborted).rejects.toBe("gone");
    await vi.advanceTimersByTimeAsync(10);
    caller.abort("gone");
    await rejected;
    expect(health.state("wh")).toBe("half-open");

    source.ms = 0;
    await settle(ask(health, ["m4"]));
    expect(started.map((s) => s.key)).toEqual(["m1", "m2", "m3", "m4"]);
    expect(health.state("wh")).toBe("closed");
  });

  it("a loader on several connectors is refused when one of their circuits is open, and names it", async () => {
    const health = createHealth({ wh: BREAKER });
    const wh = build();
    wh.source.down = true;
    await settle(wh.ask(health, ["m1", "m2"]));

    const both = build({ connectors: ["db", "wh"] });
    const result = await settle(both.ask(health, ["m3"]));
    expect(both.started).toEqual([]);
    expect(stepsOf(result, "m3", "provider:minutes")).toMatchObject([
      { reason: { reason: "failed", why: "open", connectors: ["wh"] } },
    ]);
  });

  it("a call refused by one open circuit gives back the probe another half-open circuit let through", async () => {
    const health = createHealth({ wh: BREAKER, db: BREAKER });
    const db = build({ connectors: ["db"] });
    db.source.down = true;
    await settle(db.ask(health, ["m1", "m2"]));
    vi.advanceTimersByTime(5_000);
    const wh = build();
    wh.source.down = true;
    await settle(wh.ask(health, ["m3", "m4"]));
    expect([health.state("db"), health.state("wh")]).toEqual(["half-open", "open"]);

    const both = build({ connectors: ["db", "wh"] });
    const refused = await settle(both.ask(health, ["m5"]));
    expect(both.started).toEqual([]);
    expect(stepsOf(refused, "m5", "provider:minutes")).toMatchObject([
      { reason: { reason: "failed", why: "open", connectors: ["wh"] } },
    ]);

    // db's probe was not spent on the refused call: the next call on db alone is it
    db.source.down = false;
    const probed = await settle(db.ask(health, ["m6"]));
    expect(stepsOf(probed, "m6", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
    expect(health.state("db")).toBe("closed");
  });
});

describe("run: rate limits", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls on a connector start no faster than its rate, after a burst", async () => {
    const health = createHealth({ wh: { rate: { perSecond: 10, burst: 2 } } });
    const { ask, times } = build();
    await settle(ask(health, ["m1", "m2", "m3", "m4", "m5"]));

    expect(times()).toEqual([0, 0, 100, 200, 300]);
  });

  it("the bucket is shared by the runs given the same health, and refills while idle", async () => {
    const health = createHealth({ wh: { rate: { perSecond: 10, burst: 2 } } });
    const { ask, times } = build();
    await settle(Promise.all([ask(health, ["m1", "m2"]), ask(health, ["m3", "m4"])]));
    expect(times()).toEqual([0, 0, 100, 200]);

    vi.advanceTimersByTime(1_000);
    await settle(ask(health, ["m5", "m6"]));
    expect(times().slice(4)).toEqual([1_200, 1_200]);
  });

  it("a call waiting for a token gives up at the deadline: its keys are unknown deadline, its token given back", async () => {
    const health = createHealth({ wh: { rate: { perSecond: 1, burst: 1 } } });
    const { ask, times } = build();
    const result = await settle(ask(health, ["m1", "m2"], { deadline: Date.now() + 500 }));

    expect(times()).toEqual([0]);
    const late = ["m1", "m2"].flatMap((k) => stepsOf(result, k, "provider:minutes"));
    expect(late.filter((s) => s.outcome === "unknown")).toMatchObject([
      { reason: { reason: "deadline" } },
    ]);
    // a second after the start the bucket has refilled m1's token and holds m2's, given back: m3
    // starts at once (had m2 kept its token, m3 would wait another second)
    vi.advanceTimersByTime(500);
    await settle(ask(health, ["m3"]));
    expect(times()).toEqual([0, 1_000]);
  });
});

describe("run: rate limits, a line", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls that leave the line take nobody's turn: the others start one rate step apart, in the order they asked", async () => {
    const health = createHealth({ wh: { rate: { perSecond: 10, burst: 1 } } });
    const { ask, started } = build({ concurrency: 16 });
    const caller = new AbortController();
    const a = ask(health, ["a1", "a2", "a3", "a4", "a5"], { signal: caller.signal });
    a.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(1);
    const b = ask(health, ["b1", "b2", "b3"]);
    await vi.advanceTimersByTimeAsync(10);
    caller.abort("gone");
    await vi.advanceTimersByTimeAsync(10);
    const c = ask(health, ["c1", "c2", "c3"]);
    await settle(Promise.all([b, c]));

    const t0 = started[0]?.at ?? 0;
    expect(started.map((s) => [s.key, s.at - t0])).toEqual([
      ["a1", 0],
      ["b1", 100],
      ["b2", 200],
      ["b3", 300],
      ["c1", 400],
      ["c2", 500],
      ["c3", 600],
    ]);
  });

  it("a call whose token came when its run had stopped gives it back", async () => {
    const health = createHealth({ wh: { rate: { perSecond: 1, burst: 1 } } });
    const { ask, times } = build();
    const t0 = Date.now();
    // the run's own clock passes its deadline at 1 s, its timer only much later
    const clock = () => (Date.now() - t0 < 1_000 ? t0 : t0 + 2e9);
    const late = await settle(ask(health, ["m1", "m2"], { clock, deadline: t0 + 1e9 }));
    expect(times()).toEqual([0]);
    expect(
      ["m1", "m2"].flatMap((k) => stepsOf(late, k, "provider:minutes")).map((s) => s.outcome),
    ).toContain("unknown");

    await settle(ask(health, ["m3"]));
    expect(times()).toEqual([0, 1_000]);
  });
});

describe("createHealth", () => {
  it("refuses a breaker or a rate that cannot be followed", () => {
    for (const spec of [
      { breaker: { failures: 0, windowMs: 1, coolDownMs: 1 } },
      { breaker: { failures: 1, windowMs: 0, coolDownMs: 1 } },
      { breaker: { failures: 1, windowMs: 1, coolDownMs: -1 } },
      { rate: { perSecond: 0, burst: 1 } },
      { rate: { perSecond: 1, burst: 0.5 } },
    ])
      expect(() => createHealth({ wh: spec }), JSON.stringify(spec)).toThrow(
        expect.objectContaining({ code: "HG_SPEC" }) as DefinitionError,
      );
  });

  it("a run refuses a health it was not made by createHealth, before it holds a timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setImmediate", "Date"] });
    try {
      const { ask } = build();
      const deadline = Date.now() + 3_600_000;
      await expect(ask({ state: () => "closed" }, ["m1"], { deadline })).rejects.toMatchObject({
        code: "HG_SPEC",
      });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
