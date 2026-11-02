// Relation combinators (DESIGN.md §3.3, §3.4): fallback runs strategy n + 1 only on the refs
// strategy n did not find, union runs every strategy on every ref; absent only when every strategy
// that applies ran to the end uncut and found nothing; past a strategy it could not read, or one
// that read under a cut and found nothing, a fallback goes on and keeps its reason or its cut, so
// nothing read through the next one is absent; a found value that projects to no link counts as
// absent within the strategy's coverage; a cut travels to the provider result.

import { describe, expect, it } from "vitest";
import type { Coverage } from "../../core/index.ts";
import { run } from "../index.ts";
import {
  type Behaviour,
  chains,
  fake,
  free,
  link,
  m,
  newGraph,
  options,
  providerOf,
  refs,
  refsOf,
  rowsOf,
  stepsOf,
} from "./support.ts";

type Artists = { readonly artist: string }[];

const CREDITS: Coverage = { label: "credits, 6 months", days: 183 };
const LEDGER: Coverage = { label: "ledger, since 2020", from: "2020-01-01" };

/** t1 credits only · t2 ledger only · t3 neither · t4 credits failed · t5 ledger failed
 *  · t6 credits found an empty list · t8 both find a1 · t9 credits failed, ledger found
 *  · t10 credits found, cut */
const creditsTable: Behaviour<Artists> = {
  found: {
    t1: [{ artist: "a1" }],
    t6: [],
    t8: [{ artist: "a1" }],
    t10: [{ artist: "a1" }],
  },
  unknown: { t4: { reason: "failed" }, t9: { reason: "failed" } },
  cut: { t10: { kind: "cap", limit: 50 } },
};
const ledgerTable: Behaviour<Artists> = {
  found: { t2: [{ artist: "a2" }], t8: [{ artist: "a1" }], t9: [{ artist: "a2" }] },
  unknown: { t5: { reason: "failed" } },
};

function build(
  combine: "fallback" | "union",
  b: {
    credits?: Behaviour<Artists>;
    ledger?: Behaviour<Artists>;
    cardinality?: "1:1" | "1:N" | "N:1" | "N:N";
  } = {},
) {
  const f = {
    credits: fake<Artists>(b.credits ?? creditsTable),
    ledger: fake<Artists>(b.ledger ?? ledgerTable),
    profiles: fake<{ name: string }>({
      found: { a1: { name: "Mira Volk" }, a2: { name: "Ode Ferris" } },
    }),
  };
  const g = newGraph();
  const creditsL = g.loader({
    ...free,
    id: "credits",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.credits.load,
  });
  const ledgerL = g.loader({
    ...free,
    id: "ledger",
    keyedBy: "track",
    connectors: { allOf: ["wh"] },
    load: f.ledger.load,
  });
  const profilesL = g.loader({
    ...free,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.profiles.load,
  });
  const performer = g.relation("track", "artist", "performer", {
    cardinality: b.cardinality ?? "N:N",
    combine,
    strategies: (s) => [
      s(creditsL, {
        coverage: CREDITS,
        project: (_ref, v) => v.map((x) => ({ to: x.artist })),
      }),
      s(ledgerL, { coverage: LEDGER, project: (_ref, v) => v.map((x) => ({ to: x.artist })) }),
    ],
  });
  const profile = g.provider("profile", {
    loader: profilesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });
  return { graph: g.graph(g.route("track", profile, g.path(performer))), f, performer };
}

describe("run: fallback of strategies", () => {
  it("strategy 2 runs only on the refs strategy 1 did not find (absent, unknown, or no link)", async () => {
    const { graph, f } = build("fallback");
    await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3", "t4", "t5", "t6"), providers: ["profile"] }),
    );

    expect(f.credits.loaded()).toEqual(["t1", "t2", "t3", "t4", "t5", "t6"]);
    expect(f.ledger.loaded()).toEqual(["t2", "t3", "t4", "t5", "t6"]);
  });

  it("found if any strategy found; absent with every strategy's coverage only when all ran and found nothing", async () => {
    const { graph } = build("fallback");
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3", "t6"), providers: ["profile"] }),
    );

    expect(providerOf(result, "t1", "profile").outcome).toBe("found");
    expect(refsOf(providerOf(result, "t1", "profile"))).toEqual(["a1"]);
    expect(refsOf(providerOf(result, "t2", "profile"))).toEqual(["a2"]);
    for (const row of ["t3", "t6"]) {
      const p = providerOf(result, row, "profile");
      expect(p.outcome).toBe("absent");
      expect(p.rows).toEqual([]);
      expect(p.unknown).toEqual([]);
      expect(p.coverage).toHaveLength(2);
      expect(p.coverage).toEqual(expect.arrayContaining([CREDITS, LEDGER]));
    }
  });

  it("unknown when a strategy could not read, even if the other found nothing", async () => {
    const { graph } = build("fallback");
    const result = await run(
      graph,
      options({ refs: refs("track", "t4", "t5"), providers: ["profile"] }),
    );

    for (const row of ["t4", "t5"]) {
      const p = providerOf(result, row, "profile");
      expect(p.outcome).toBe("unknown");
      expect(p.rows).toEqual([]);
      expect(p.unknown).toEqual([{ reason: "failed" }]);
    }
  });

  it("row steps: one per strategy that ran, with its outcome, coverage and number of links", async () => {
    const { graph, performer } = build("fallback");
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t3", "t4", "t6"), providers: ["profile"] }),
    );

    expect(stepsOf(result, "t1", performer.id, "credits")).toMatchObject([
      { step: performer.id, loader: "credits", ref: "t1", outcome: "found", links: 1 },
    ]);
    expect(stepsOf(result, "t1", performer.id, "ledger")).toEqual([]);
    expect(stepsOf(result, "t3", performer.id, "credits")).toMatchObject([
      { ref: "t3", outcome: "absent", coverage: CREDITS },
    ]);
    expect(stepsOf(result, "t3", performer.id, "ledger")).toMatchObject([
      { ref: "t3", outcome: "absent", coverage: LEDGER },
    ]);
    expect(stepsOf(result, "t4", performer.id, "credits")).toMatchObject([
      { ref: "t4", outcome: "unknown", reason: { reason: "failed" } },
    ]);
    // a found value that projects to no link counts as absent within the strategy's coverage
    expect(stepsOf(result, "t6", performer.id, "credits")).toMatchObject([
      { ref: "t6", outcome: "absent", coverage: CREDITS, links: 0 },
    ]);
  });

  it("past a strategy it could not read, what the next one finds stands, that strategy's reason beside it", async () => {
    const { graph, f } = build("fallback");
    const result = await run(graph, options({ refs: refs("track", "t9"), providers: ["profile"] }));

    const p = providerOf(result, "t9", "profile");
    expect(f.ledger.loaded()).toEqual(["t9"]);
    expect(p.outcome).toBe("found");
    expect(refsOf(p)).toEqual(["a2"]);
    expect(p.unknown).toEqual([{ reason: "failed" }]);
  });

  it("past a strategy it could not read, an absence the next one leads to is unknown, with that strategy's reason", async () => {
    const { graph } = build("fallback", {
      credits: creditsTable,
      // a3 has no profile
      ledger: { found: { t9: [{ artist: "a3" }], t11: [{ artist: "a3" }] } },
    });
    const result = await run(
      graph,
      options({ refs: refs("track", "t9", "t11"), providers: ["profile"] }),
    );

    // credits could not read t9: it might have led to an artist with a profile
    expect(providerOf(result, "t9", "profile")).toMatchObject({
      outcome: "unknown",
      rows: [],
      unknown: [{ reason: "failed" }],
    });
    // credits read t11 and found nothing: a3's absent profile is the answer
    expect(providerOf(result, "t11", "profile")).toMatchObject({
      outcome: "absent",
      unknown: [],
      cut: [],
    });
  });

  it("past a strategy that read under a cut and found nothing, what the next one finds stands, the cut beside it, and an absence it leads to is unknown", async () => {
    const { graph } = build("fallback", {
      credits: {
        found: { t7: [], t8: [] },
        cut: { t7: { kind: "days", days: 10 }, t8: { kind: "days", days: 10 } },
      },
      // a3 has no profile
      ledger: { found: { t7: [{ artist: "a1" }], t8: [{ artist: "a3" }] } },
    });
    const result = await run(
      graph,
      options({ refs: refs("track", "t7", "t8"), providers: ["profile"] }),
    );

    const found = providerOf(result, "t7", "profile");
    expect(found.outcome).toBe("found");
    expect(refsOf(found)).toEqual(["a1"]);
    expect(found.cut).toEqual([{ kind: "days", days: 10 }]);
    // credits read only ten days of t8: what it did not read might have led elsewhere
    expect(providerOf(result, "t8", "profile")).toMatchObject({
      outcome: "unknown",
      rows: [],
      unknown: [],
      cut: [{ kind: "days", days: 10 }],
    });
  });

  it("a cut strategy that found no link never makes the ref absent: unknown, with the cut listed", async () => {
    const { graph } = build("fallback", {
      credits: { found: { t7: [] }, cut: { t7: { kind: "days", days: 10 } } },
      ledger: {},
    });
    const result = await run(graph, options({ refs: refs("track", "t7"), providers: ["profile"] }));

    const p = providerOf(result, "t7", "profile");
    expect(p.outcome).toBe("unknown");
    expect(p.rows).toEqual([]);
    expect(p.cut).toEqual([{ kind: "days", days: 10 }]);
  });

  it("a cut on a found strategy travels to the row step, the provider result and its rows stay found", async () => {
    const { graph, performer } = build("fallback");
    const result = await run(
      graph,
      options({ refs: refs("track", "t10"), providers: ["profile"] }),
    );

    const p = providerOf(result, "t10", "profile");
    expect(p.outcome).toBe("found");
    expect(refsOf(p)).toEqual(["a1"]);
    expect(p.cut).toEqual([{ kind: "cap", limit: 50 }]);
    expect(stepsOf(result, "t10", performer.id, "credits")).toMatchObject([
      { outcome: "found", cuts: [{ kind: "cap", limit: 50 }] },
    ]);
  });
});

describe("run: coverage the load reports per key", () => {
  const LOOKED_BACK: Coverage = { label: "credits, escalated to 180 days", days: 180 };

  it("replaces the strategy's declared coverage for that key, on absent and on found", async () => {
    const { graph, performer } = build("fallback", {
      credits: {
        found: { t1: [{ artist: "a1" }] },
        coverage: { t1: LOOKED_BACK, t3: LOOKED_BACK },
      },
      ledger: {},
    });
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t3"), providers: ["profile"] }),
    );

    expect(stepsOf(result, "t1", performer.id, "credits")).toMatchObject([
      { outcome: "found", coverage: LOOKED_BACK },
    ]);
    expect(stepsOf(result, "t3", performer.id, "credits")).toMatchObject([
      { outcome: "absent", coverage: LOOKED_BACK },
    ]);
    const t3 = providerOf(result, "t3", "profile");
    expect(t3.outcome).toBe("absent");
    expect(t3.coverage).toHaveLength(2);
    expect(t3.coverage).toEqual(expect.arrayContaining([LOOKED_BACK, LEDGER]));
  });
});

describe("run: union of strategies", () => {
  it("every strategy runs on every ref", async () => {
    const { graph, f } = build("union");
    await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3", "t4", "t5"), providers: ["profile"] }),
    );

    expect(f.credits.loaded()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
    expect(f.ledger.loaded()).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });

  it("found if any found; absent only if all absent; unknown if any unknown and none found", async () => {
    const { graph } = build("union");
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t2", "t3", "t4", "t5"), providers: ["profile"] }),
    );

    expect(refsOf(providerOf(result, "t1", "profile"))).toEqual(["a1"]);
    expect(refsOf(providerOf(result, "t2", "profile"))).toEqual(["a2"]);
    const t3 = providerOf(result, "t3", "profile");
    expect(t3.outcome).toBe("absent");
    expect(t3.coverage).toHaveLength(2);
    expect(t3.coverage).toEqual(expect.arrayContaining([CREDITS, LEDGER]));
    for (const row of ["t4", "t5"]) {
      const p = providerOf(result, row, "profile");
      expect(p.outcome).toBe("unknown");
      expect(p.unknown).toEqual([{ reason: "failed" }]);
    }
  });

  it("two strategies linking to the same target give two chains, never one merged link", async () => {
    const { graph, f, performer } = build("union");
    const result = await run(graph, options({ refs: refs("track", "t8"), providers: ["profile"] }));

    expect(f.profiles.loaded()).toEqual(["a1"]);
    expect(rowsOf(providerOf(result, "t8", "profile"))).toEqual([
      {
        ref: "a1",
        index: 0,
        fields: { name: "Mira Volk" },
        lineage: chains(
          [link(performer.id, "credits", "t8", "a1")],
          [link(performer.id, "ledger", "t8", "a1")],
        ),
      },
    ]);
  });

  it("found through one strategy while the other could not read: found, the reason listed", async () => {
    const { graph } = build("union");
    const result = await run(graph, options({ refs: refs("track", "t9"), providers: ["profile"] }));

    const p = providerOf(result, "t9", "profile");
    expect(p.outcome).toBe("found");
    expect(refsOf(p)).toEqual(["a2"]);
    expect(p.unknown).toEqual([{ reason: "failed" }]);
  });
});

describe("run: cardinality", () => {
  /** t1 one performer · t2 one strategy finds two · t3 the strategies find one each, not the same
   *  · t4 both find a1 */
  const tables = {
    credits: {
      found: {
        t1: [{ artist: "a1" }],
        t2: [{ artist: "a1" }, { artist: "a2" }],
        t3: [{ artist: "a1" }],
        t4: [{ artist: "a1" }],
      },
    },
    ledger: { found: { t3: [{ artist: "a2" }], t4: [{ artist: "a1" }] } },
  };
  const all = refs("track", "t1", "t2", "t3", "t4");

  for (const cardinality of ["N:1", "1:1"] as const)
    it(`${cardinality}: two targets for one ref make it unknown, ambiguous, and neither is read through it`, async () => {
      const { graph, f, performer } = build("union", { ...tables, cardinality });
      const result = await run(graph, options({ refs: all, providers: ["profile"] }));

      for (const row of ["t2", "t3"]) {
        const p = providerOf(result, row, "profile");
        expect(p.outcome).toBe("unknown");
        expect(p.unknown).toEqual([{ reason: "ambiguous" }]);
        expect(p.rows).toEqual([]);
      }
      // a2 is reached only through ambiguous refs: never read
      expect(f.profiles.loaded()).toEqual(["a1"]);
      // the strategies' row steps still say what each found
      expect(stepsOf(result, "t2", performer.id, "credits")).toMatchObject([
        { outcome: "found", links: 2 },
      ]);
    });

  it("N:1: one target, or two links to the same one, is the answer", async () => {
    const { graph } = build("union", { ...tables, cardinality: "N:1" });
    const result = await run(graph, options({ refs: all, providers: ["profile"] }));

    expect(refsOf(providerOf(result, "t1", "profile"))).toEqual(["a1"]);
    expect(refsOf(providerOf(result, "t4", "profile"))).toEqual(["a1"]);
    expect(providerOf(result, "t4", "profile").outcome).toBe("found");
  });

  it("1:N and N:N take every target", async () => {
    for (const cardinality of ["1:N", "N:N"] as const) {
      const { graph } = build("union", { ...tables, cardinality });
      const result = await run(graph, options({ refs: all, providers: ["profile"] }));

      expect(refsOf(providerOf(result, "t2", "profile"))).toEqual(["a1", "a2"]);
      expect(refsOf(providerOf(result, "t3", "profile"))).toEqual(["a1", "a2"]);
    }
  });
});

describe("run: what a load may say", () => {
  it("a reason only the run gives, claimed by a load, is read as failed: a fallback goes on", async () => {
    const { graph, f, performer } = build("fallback", {
      // as plain JavaScript or a cast may give it: the types refuse it
      credits: { unknown: { t1: { reason: "awaiting_approval", bytes: 5 } as never } },
      ledger: { found: { t1: [{ artist: "a1" }] } },
    });
    const result = await run(graph, options({ refs: refs("track", "t1"), providers: ["profile"] }));

    expect(result.status).toBe("complete");
    expect(f.ledger.loaded()).toEqual(["t1"]);
    expect(stepsOf(result, "t1", performer.id, "credits")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(providerOf(result, "t1", "profile").outcome).toBe("found");
  });
});
