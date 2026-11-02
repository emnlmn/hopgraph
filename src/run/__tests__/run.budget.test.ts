// A metered wave's budget (DESIGN.md §5.3): the wave is priced and approved once, and every call
// of it draws from what is left of that budget, so the calls together never bill past it. The
// calls of a metered loader in one wave run one after another, each told what is left; a call that
// throws without saying what it billed is taken to have billed all it was given.

import { describe, expect, it } from "vitest";
import { run } from "../index.ts";
import { fake, free, Inflight, m, newGraph, options, refs, stepsOf, traceOf } from "./support.ts";

const METERED = { metered: { auto: 100, approve: 1000 } } as const;

/** A metered loader of masters that reads one key per call, and its provider. */
function build(load?: (keys: readonly string[], maxBytes: number | undefined) => void) {
  const f = fake<{ minutes: number }>({
    found: { m1: { minutes: 1 }, m2: { minutes: 2 }, m3: { minutes: 3 } },
    price: 30,
    billedBytes: 10,
  });
  const g = newGraph();
  const durations = g.loader({
    ...free,
    id: "durations",
    keyedBy: "master",
    connectors: { allOf: ["wh"] },
    batch: { by: "one", concurrency: 4 },
    cost: METERED,
    price: f.price,
    load: async (refs, ctx, budget) => {
      load?.(
        refs.map((r) => r.key),
        budget.maxBytes,
      );
      return f.load(refs, ctx, budget);
    },
  });
  const minutes = g.provider("minutes", {
    loader: durations,
    temporal: "current",
    rows: "one",
    project: (v) => [{ minutes: v.minutes }],
    raw: { minutes: m("Minutes") },
  });
  return { graph: g.graph(g.route("master", minutes, g.itself("master"))), f };
}

const masters = () => options({ refs: refs("master", "m1", "m2", "m3"), providers: ["minutes"] });

describe("run: a metered wave's budget", () => {
  it("its calls run one after another, each with what is left of the wave's price", async () => {
    const { graph, f } = build();
    const result = await run(graph, masters());

    expect(f.prices).toHaveLength(1);
    expect(f.calls.map((c) => c.budget.maxBytes)).toEqual([30, 20, 10]);
    expect(f.inflight.max).toBe(1);
    expect(result.billedBytes).toBe(30);
    expect(traceOf(result, "provider:minutes").found).toBe(3);
  });

  it("once its calls have billed the whole budget, the keys left are not loaded: unknown failed, HG_BUDGET_SPENT", async () => {
    const { graph, f } = build();
    f.is.billedBytes = 15;
    const result = await run(graph, masters());

    expect(f.calls.map((c) => c.budget.maxBytes)).toEqual([30, 15]);
    expect(result.billedBytes).toBe(30);
    const [skipped = ""] = ["m1", "m2", "m3"].filter((k) => !f.loaded().includes(k));
    expect(stepsOf(result, skipped, "provider:minutes")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(traceOf(result, "provider:minutes").errors).toEqual([
      { code: "HG_BUDGET_SPENT", keys: 1 },
    ]);
  });

  it("a call that throws without saying what it billed spends what was left: nothing more is called", async () => {
    let first = true;
    const { graph, f } = build(() => {
      if (!first) return;
      first = false;
      throw new Error("lost the job's answer");
    });
    const result = await run(graph, masters());

    expect(f.calls).toEqual([]);
    expect(result.billedBytes).toBe(0);
    const trace = traceOf(result, "provider:minutes");
    expect(trace.unknown).toEqual({ failed: 3 });
    expect(trace.errors).toEqual([
      { code: "Error", keys: 1 },
      { code: "HG_BUDGET_SPENT", keys: 2 },
    ]);
  });

  it("a thrown error that says what its source billed (billedBytes) spends that much, and the trace counts it", async () => {
    let first = true;
    const { graph, f } = build(() => {
      if (!first) return;
      first = false;
      throw Object.assign(new Error("statement timeout"), { billedBytes: 4 });
    });
    const result = await run(graph, masters());

    expect(f.calls.map((c) => c.budget.maxBytes)).toEqual([26, 16]);
    expect(result.billedBytes).toBe(24);
    expect(traceOf(result, "provider:minutes").found).toBe(2);
  });

  it("an envelope's bill that is not a number of bytes from 0 is charged as all the call was told", async () => {
    for (const bill of [Number.NaN, -1000, Number.POSITIVE_INFINITY]) {
      const { graph, f } = build();
      f.is.billedBytes = bill;
      const result = await run(graph, masters());

      expect(
        f.calls.map((c) => c.budget.maxBytes),
        String(bill),
      ).toEqual([30]);
      expect(result.billedBytes, String(bill)).toBe(0);
      expect(traceOf(result, "provider:minutes").errors, String(bill)).toEqual([
        { code: "HG_BUDGET_SPENT", keys: 2 },
      ]);
    }
  });

  it("a wave priced at nothing runs every call, each with a budget of nothing", async () => {
    const { graph, f } = build();
    Object.assign(f.is, { price: 0, billedBytes: 0 });
    const result = await run(graph, masters());

    expect(f.calls.map((c) => c.budget.maxBytes)).toEqual([0, 0, 0]);
    expect(traceOf(result, "provider:minutes").found).toBe(3);
  });

  it("a free loader's calls still run side by side, with no budget", async () => {
    const shared = new Inflight();
    const f = fake<{ minutes: number }>({ found: { m1: { minutes: 1 }, m2: { minutes: 2 } } });
    f.is.trackers = [shared];
    const g = newGraph();
    const durations = g.loader({
      ...free,
      id: "durations",
      keyedBy: "master",
      connectors: { allOf: ["db"] },
      batch: { by: "one", concurrency: 4 },
      load: f.load,
    });
    await run(
      g.graph(
        g.route(
          "master",
          g.provider("minutes", {
            loader: durations,
            temporal: "current",
            rows: "one",
            project: (v) => [{ minutes: v.minutes }],
            raw: { minutes: m("Minutes") },
          }),
          g.itself("master"),
        ),
      ),
      options({ refs: refs("master", "m1", "m2"), providers: ["minutes"] }),
    );

    expect(shared.max).toBe(2);
    expect(f.calls.map((c) => c.budget.maxBytes)).toEqual([undefined, undefined]);
  });
});
