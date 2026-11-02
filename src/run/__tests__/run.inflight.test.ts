// Single-flight across runs (DESIGN.md §5.7; run/flights.ts). Two runs given the same
// `createInflight` object that ask the same loader key at once (the same cache entry) load it once:
// the second waits for the first's answer. Only what the cache would keep is shared; a run that
// stops while it waits waits no more, and the load goes on for the others.

import { describe, expect, it } from "vitest";
import { type Envelope, envelope, type Retention } from "../../core/index.ts";
import { createInflight, type Inflight, type RunOptions, run } from "../index.ts";
import {
  type Ctx,
  free,
  MemoryCache,
  m,
  newGraph,
  options,
  refs,
  stepsOf,
  traceOf,
} from "./support.ts";

/** A call the test answers when it wants: with the durations, or by throwing (`fatal`: what the
 *  run calls fatal). */
interface Pending {
  readonly keys: readonly string[];
  readonly answer: () => void;
  readonly fail: (fatal?: boolean) => void;
}

class Quota extends Error {
  override name = "Quota";
}

/**
 * Masters' durations read by a loader whose every call waits for the test to answer it; `keep` its
 * retention; `metered`, priced at a byte a key under an auto cap of 100, one key a call.
 */
function build(p: { keep?: Retention; metered?: boolean } = {}) {
  const calls: Pending[] = [];
  const prices: string[][] = [];
  const g = newGraph();
  const common = {
    ...free,
    id: "durations",
    keyedBy: "master",
    connectors: { allOf: ["wh"] },
    ...(p.keep ? { keep: () => p.keep as Retention } : {}),
    load: (keys: readonly { readonly key: string }[]) =>
      new Promise<Envelope<string, { minutes: number }>>((resolve, reject) => {
        calls.push({
          keys: keys.map((k) => k.key),
          answer: () =>
            resolve(
              envelope(
                keys.map((k) => [k.key, { kind: "found", value: { minutes: 1 } }] as const),
                p.metered ? keys.length : 0,
              ),
            ),
          fail: (fatal) => reject(fatal ? new Quota() : new Error("down")),
        });
      }),
  } as const;
  const durations = p.metered
    ? g.loader({
        ...common,
        batch: { by: "one", concurrency: 1 },
        cost: { metered: { auto: 100, approve: 1000 } },
        price: async (keys) => {
          prices.push(keys.map((k) => k.key));
          return keys.length;
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
  const ask = (
    inflight: Inflight | undefined,
    keys: string[],
    over: Partial<RunOptions<Ctx>> = {},
  ) =>
    run(
      graph,
      options({
        refs: refs("master", ...keys),
        providers: ["minutes"],
        cache: new MemoryCache(),
        fatal: (e) => e instanceof Quota,
        ...(inflight ? { inflight } : {}),
        ...over,
      }),
    );
  return { ask, calls, prices };
}

const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Lets the runs go on until `done` holds. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i++) await turn();
  if (!done()) throw new Error("never happened");
  for (let i = 0; i < 5; i++) await turn();
}

describe("run: single-flight across runs", () => {
  it("two runs that ask the same loader key at once load it once: the second waits for the first's answer", async () => {
    const inflight = createInflight();
    const { ask, calls } = build();
    const first = ask(inflight, ["m1"]);
    await until(() => calls.length === 1);
    expect(inflight.size).toBe(1);
    const second = ask(inflight, ["m1", "m2"]);
    await until(() => true);
    // the second run waits for m1, then loads only what nobody loaded, in one admission
    expect(calls).toHaveLength(1);
    calls[0]?.answer();
    await until(() => calls.length === 2);
    expect(calls.map((c) => c.keys)).toEqual([["m1"], ["m2"]]);
    calls[1]?.answer();
    const [a, b] = await Promise.all([first, second]);

    expect(stepsOf(a, "m1", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
    expect(stepsOf(b, "m1", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
    expect(traceOf(b, "provider:minutes")).toMatchObject({ keysIn: 2, cached: 1, found: 2 });
    expect(inflight.size).toBe(0);
  });

  it("without the same inflight object, or for another restriction, each run loads the key itself", async () => {
    const { ask, calls } = build();
    const shared = createInflight();
    const runs = [
      ask(undefined, ["m1"]),
      ask(createInflight(), ["m1"]),
      ask(shared, ["m1"]),
      ask(shared, ["m1"], { restriction: "another viewer" }),
    ];
    await until(() => calls.length === 4);
    for (const c of calls) c.answer();
    await Promise.all(runs);
    expect(calls).toHaveLength(4);
  });

  it("only a found or an absent answer is shared: a run whose key's load failed reads it itself", async () => {
    const inflight = createInflight();
    const { ask, calls } = build();
    const first = ask(inflight, ["m1"]);
    await until(() => calls.length === 1);
    const second = ask(inflight, ["m1"]);
    await until(() => inflight.size === 1);
    calls[0]?.fail();
    await until(() => calls.length === 2);
    calls[1]?.answer();

    const [a, b] = await Promise.all([first, second]);
    expect(stepsOf(a, "m1", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(stepsOf(b, "m1", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
  });

  it("a run aborted while it waits stops waiting at once; the load goes on for the others", async () => {
    const inflight = createInflight();
    const { ask, calls } = build();
    const first = ask(inflight, ["m1"]);
    await until(() => calls.length === 1);
    const caller = new AbortController();
    const aborted = ask(inflight, ["m1"], { signal: caller.signal });
    const third = ask(inflight, ["m1"]);
    await until(() => true);
    caller.abort("gone");
    await expect(aborted).rejects.toBe("gone");

    calls[0]?.answer();
    const [a, c] = await Promise.all([first, third]);
    expect(calls).toHaveLength(1);
    expect(stepsOf(a, "m1", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
    expect(stepsOf(c, "m1", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
  });

  it("a run whose deadline passes while it waits answers then, the key unknown deadline; the load goes on", async () => {
    const inflight = createInflight();
    const { ask, calls } = build();
    const first = ask(inflight, ["m1"]);
    await until(() => calls.length === 1);
    const late = await ask(inflight, ["m1"], { clock: Date.now, deadline: Date.now() + 20 });
    expect(stepsOf(late, "m1", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "deadline" } },
    ]);

    calls[0]?.answer();
    expect(stepsOf(await first, "m1", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
    expect(calls).toHaveLength(1);
  });

  it("a run whose own load stops (its deadline) leaves the key to the run that waited, which reads it itself", async () => {
    const inflight = createInflight();
    const { ask, calls } = build();
    const clock = { now: Date.now() };
    const first = ask(inflight, ["m1"], { clock: () => clock.now, deadline: clock.now + 1_000 });
    await until(() => calls.length === 1);
    const second = ask(inflight, ["m1"]);
    await until(() => true);
    // the first run's clock passes its deadline: its load is aborted, nothing landed to share
    clock.now += 5_000;
    calls[0]?.answer();
    await until(() => calls.length === 2);
    calls[1]?.answer();

    const [a, b] = await Promise.all([first, second]);
    expect(stepsOf(a, "m1", "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "deadline" } },
    ]);
    expect(stepsOf(b, "m1", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
  });

  it("an answer the cache would not keep (retention none) is not shared: the run that waited reads the key itself", async () => {
    const inflight = createInflight();
    const { ask, calls } = build({ keep: "none" });
    const first = ask(inflight, ["m1"]);
    await until(() => calls.length === 1);
    const second = ask(inflight, ["m1"]);
    await until(() => inflight.size === 1);
    calls[0]?.answer();
    await until(() => calls.length === 2);
    calls[1]?.answer();

    const [, b] = await Promise.all([first, second]);
    expect(calls).toHaveLength(2);
    expect(traceOf(b, "provider:minutes")).toMatchObject({ cached: 0, found: 1 });
  });

  it("a run whose own load fails it, or whose caller aborts it, leaves the key to the run that waited", async () => {
    for (const how of ["fatal", "aborted"] as const) {
      const inflight = createInflight();
      const { ask, calls } = build();
      const caller = new AbortController();
      const first = ask(inflight, ["m1"], { signal: caller.signal });
      first.catch(() => undefined);
      await until(() => calls.length === 1);
      const second = ask(inflight, ["m1"]);
      await until(() => true);
      if (how === "fatal") calls[0]?.fail(true);
      else caller.abort("gone");
      await until(() => calls.length === 2);
      calls[1]?.answer();

      expect(stepsOf(await second, "m1", "provider:minutes"), how).toMatchObject([
        { outcome: "found" },
      ]);
      expect(inflight.size, how).toBe(0);
    }
  });

  it("every key of a metered wave is in flight once the wave is admitted: a run waits for one whose call has not come yet", async () => {
    const inflight = createInflight();
    const { ask, calls, prices } = build({ metered: true });
    const first = ask(inflight, ["m1", "m2"]);
    await until(() => calls.length === 1);
    // the first run's calls take turns: m2's has not started, and the second run waits for it
    const second = ask(inflight, ["m2"]);
    await until(() => true);
    calls[0]?.answer();
    await until(() => calls.length === 2);
    calls[1]?.answer();

    const [, b] = await Promise.all([first, second]);
    expect(prices).toHaveLength(1);
    expect(calls.map((c) => c.keys)).toEqual([["m1"], ["m2"]]);
    expect(stepsOf(b, "m2", "provider:minutes")).toMatchObject([{ outcome: "found" }]);
    expect(b.billedBytes).toBe(0);
  });

  it("a merged read is shared like any other: the run that waited narrows it itself", async () => {
    const reads: string[][] = [];
    const pending: (() => void)[] = [];
    const g = newGraph();
    const history = g.loader({
      ...free,
      id: "history",
      keyedBy: "track",
      needs: ["releasedAt"],
      connectors: { allOf: ["db"] },
      merge: {
        needs: (refs) => ({ releasedAt: refs.map((r) => r.releasedAt).sort()[0] ?? "" }),
        narrow: (value: { days: string[] }, ref) => {
          const days = value.days.filter((d) => d >= ref.releasedAt);
          return days.length > 0 ? { days } : undefined;
        },
        empty: { days: [] },
      },
      load: (refs) =>
        new Promise<Envelope<string, { days: string[] }>>((resolve) => {
          reads.push(refs.map((r) => `${r.key}@${r.releasedAt}`));
          const days = ["2026-01-05", "2026-02-05"];
          pending.push(() =>
            resolve(
              envelope(refs.map((r) => [r.key, { kind: "found", value: { days } }] as const)),
            ),
          );
        }),
    });
    const rows = [
      { row: "r1", entity: "track", key: "t1", carries: { releasedAt: "2026-01-01" } },
      { row: "r2", entity: "track", key: "t1", carries: { releasedAt: "2026-02-01" } },
    ];
    const inflight = createInflight();
    const graph = g.graph(
      g.route(
        "track",
        g.provider("days", {
          loader: history,
          temporal: "historical",
          rows: "many",
          project: (v: { days: string[] }) => v.days.map((day) => ({ day })),
          raw: { day: m("Day") },
        }),
        g.itself("track"),
      ),
    );
    const ask = () =>
      run(graph, options({ refs: rows, providers: ["days"], cache: new MemoryCache(), inflight }));
    const first = ask();
    await until(() => pending.length === 1);
    const second = ask();
    await until(() => true);
    pending[0]?.();

    const [, b] = await Promise.all([first, second]);
    expect(reads).toEqual([["t1@2026-01-01"]]);
    expect(b.rows.get("r1")?.providers.days?.rows).toHaveLength(2);
    expect(b.rows.get("r2")?.providers.days?.rows).toHaveLength(1);
  });

  it("a run refuses an inflight it was not made by createInflight", async () => {
    const { ask } = build();
    await expect(ask({ size: 0 }, ["m1"])).rejects.toMatchObject({ code: "HG_SPEC" });
    await expect(
      ask(undefined, ["m1"], { inflight: null as unknown as Inflight }),
    ).rejects.toMatchObject({ code: "HG_SPEC" });
  });
});
