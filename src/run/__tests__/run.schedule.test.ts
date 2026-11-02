// Scheduling (DESIGN.md §5.2): a loader's job starts as soon as nothing behind it can still add
// keys to it, so a step behind a fast read goes on while an unrelated slow read runs, however deep
// it goes. Reads of one loader in one wave still share one job, the fast one waiting for the slow
// one that can add keys to it (run.waves.test.ts).

import { describe, expect, it, vi } from "vitest";
import { run } from "../index.ts";
import {
  type Fake,
  fake,
  free,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  traceOf,
} from "./support.ts";

type Links = { readonly to: readonly string[] };
type Named = { readonly name: string };

/** From a track, a fast chain of three reads (its artist, the artist's region, the region's
 *  name) and, beside it, a slow read of the track's masters, then their durations. */
function build() {
  const f = {
    performer: fake<Links>({ found: { t1: { to: ["a1"] } }, delayMs: 1 }),
    home: fake<Links>({ found: { a1: { to: ["r1"] } }, delayMs: 1 }),
    names: fake<Named>({ found: { r1: { name: "North" } }, delayMs: 1 }),
    masters: fake<Links>({ found: { t1: { to: ["m1"] } }, delayMs: 60 }),
    durations: fake<Named>({ found: { m1: { name: "vinyl" } }, delayMs: 1 }),
  };
  const g = newGraph();
  const on = { ...free, connectors: { allOf: ["db"] } } as const;
  const toLinks = (_ref: unknown, v: Links) => v.to.map((to) => ({ to }));
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    strategies: (s) => [
      s(g.loader({ ...on, id: "performer", keyedBy: "track", load: f.performer.load }), {
        project: toLinks,
      }),
    ],
  });
  const home = g.relation("artist", "region", "home", {
    cardinality: "N:1",
    strategies: (s) => [
      s(g.loader({ ...on, id: "home", keyedBy: "artist", load: f.home.load }), {
        project: toLinks,
      }),
    ],
  });
  const mastered = g.relation("track", "master", "mastered", {
    cardinality: "1:N",
    strategies: (s) => [
      s(g.loader({ ...on, id: "masters", keyedBy: "track", load: f.masters.load }), {
        project: toLinks,
      }),
    ],
  });
  const spec = {
    temporal: "current",
    rows: "one",
    project: (v: Named) => [{ name: v.name }],
    raw: { name: m("Name") },
  } as const;
  const names = g.loader({ ...on, id: "names", keyedBy: "region", load: f.names.load });
  const durations = g.loader({ ...on, id: "durations", keyedBy: "master", load: f.durations.load });
  return {
    graph: g.graph(
      g.route("track", g.provider("region", { ...spec, loader: names }), g.path(performer, home)),
      g.route("track", g.provider("master", { ...spec, loader: durations }), g.path(mastered)),
    ),
    f,
  };
}

/** Whether `slow` was loading when `f` was called, for each of `f`'s calls; `then` runs after. */
function whileLoading<V, W>(f: Fake<V>, slow: Fake<W>, then?: () => void): boolean[] {
  const seen: boolean[] = [];
  f.is.onLoad = () => {
    seen.push(slow.inflight.now > 0);
    then?.();
  };
  return seen;
}

describe("run: scheduling", () => {
  it("a step behind a fast read goes on while an unrelated slow read runs, however deep", async () => {
    const { graph, f } = build();
    // the masters answer once the region's last read has started, not after a delay the fast
    // chain could overrun on a busy machine. A scheduler that held the chain behind the masters
    // would never start that read: the masters then answer after a second, and the test fails
    let release!: () => void;
    f.masters.is.until = new Promise<void>((resolve) => {
      release = resolve;
    });
    const stuck = setTimeout(() => release(), 1000);
    const home = whileLoading(f.home, f.masters);
    const names = whileLoading(f.names, f.masters, () => release());
    const durations = whileLoading(f.durations, f.masters);
    const result = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: ["region", "master"] }),
    ).finally(() => clearTimeout(stuck));

    // the region's second and third reads ran while the masters were still being read; the
    // masters' durations, after them
    expect(home).toEqual([true]);
    expect(names).toEqual([true]);
    expect(durations).toEqual([false]);
    expect(providerOf(result, "t1", "region").rows.map((r) => r.fields)).toEqual([
      { name: "North" },
    ]);
    expect(providerOf(result, "t1", "master").rows.map((r) => r.fields)).toEqual([
      { name: "vinyl" },
    ]);
  });

  it("a key two waves ask is read once, by the earlier wave, even when the later one asked first", async () => {
    const f = {
      performer: fake<Links>({ found: { t1: { to: ["a1"] } }, delayMs: 1 }),
      home: fake<Links>({ found: { a1: { to: ["r9"] } }, delayMs: 1 }),
      studio: fake<Links>({ found: { t1: { to: ["r9"] } }, delayMs: 40 }),
      names: fake<Named>({ found: { r9: { name: "North" } }, delayMs: 1 }),
    };
    const g = newGraph();
    const on = { ...free, connectors: { allOf: ["db"] } } as const;
    const toLinks = (_ref: unknown, v: Links) => v.to.map((to) => ({ to }));
    const performer = g.relation("track", "artist", "performer", {
      cardinality: "N:1",
      strategies: (s) => [
        s(g.loader({ ...on, id: "performer", keyedBy: "track", load: f.performer.load }), {
          project: toLinks,
        }),
      ],
    });
    const home = g.relation("artist", "region", "home", {
      cardinality: "N:1",
      strategies: (s) => [
        s(g.loader({ ...on, id: "home", keyedBy: "artist", load: f.home.load }), {
          project: toLinks,
        }),
      ],
    });
    const released = g.relation("track", "region", "released", {
      cardinality: "N:1",
      strategies: (s) => [
        s(g.loader({ ...on, id: "studio", keyedBy: "track", load: f.studio.load }), {
          project: toLinks,
        }),
      ],
    });
    const names = g.loader({ ...on, id: "names", keyedBy: "region", load: f.names.load });
    const spec = {
      loader: names,
      temporal: "current",
      rows: "one",
      project: (v: Named) => [{ name: v.name }],
      raw: { name: m("Name") },
    } as const;
    // r9 is asked in wave 3 by the fast way, then in wave 2 by the slow one
    const result = await run(
      g.graph(
        g.route("track", g.provider("home", spec), g.path(performer, home)),
        g.route("track", g.provider("released", spec), g.path(released)),
      ),
      options({ refs: refs("track", "t1"), providers: ["home", "released"] }),
    );

    expect(f.names.calls.map((c) => c.keys)).toEqual([["r9"]]);
    expect(traceOf(result, "provider:released")).toMatchObject({ keysIn: 1, cached: 0 });
    expect(traceOf(result, "provider:home")).toMatchObject({ keysIn: 1, cached: 1 });
    expect(providerOf(result, "t1", "home").outcome).toBe("found");
    expect(providerOf(result, "t1", "released").outcome).toBe("found");
  });

  it("a run that answered leaves no scheduling behind it: nothing pending keeps its state alive", async () => {
    const { graph } = build();
    const schedule = globalThis.setImmediate;
    let pending = 0;
    vi.spyOn(globalThis, "setImmediate").mockImplementation(((next: () => void) => {
      pending += 1;
      return schedule(() => {
        pending -= 1;
        next();
      });
    }) as typeof setImmediate);

    await run(graph, options({ refs: refs("track", "t1"), providers: ["region", "master"] }));
    expect(pending).toBe(0);
  });
});
