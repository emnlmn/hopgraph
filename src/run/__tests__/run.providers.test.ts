// Providers and attribution (DESIGN.md §3.5, §5.5; run/types.ts ProviderResult, ProviderRow): rows
// per key with raw and derived fields, given to every base row that reaches the key along its own
// chains (deduplicated per base row), and an outcome per base row: found, absent within the
// coverage searched, or unknown with the reasons, also listed on a found result.

import { describe, expect, expectTypeOf, it } from "vitest";
import { type Coverage, DefinitionError } from "../../core/index.ts";
import { run } from "../index.ts";
import type { BaseRef } from "../types.ts";
import {
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

type Listener = { readonly market: string; readonly streams: number; readonly user: number };

const LINEUP: Coverage = { label: "lineup, 6 months", days: 183 };

function build() {
  const f = {
    lineup: fake<{ artist: string }[]>({
      found: {
        t1: [{ artist: "a1" }],
        t2: [{ artist: "a1" }],
        t5: [{ artist: "a2" }],
        t6: [{ artist: "a3" }],
        t7: [{ artist: "a4" }],
        t8: [{ artist: "a5" }],
        t9: [{ artist: "a1" }, { artist: "a4" }],
      },
      unknown: { t4: { reason: "failed" } },
    }),
    listeners: fake<Listener[]>({
      found: {
        a1: [
          { market: "a", streams: 1, user: 12_000 },
          { market: "b", streams: 20, user: 5 },
        ],
        a2: [],
        a5: [{ market: "z", streams: 1, user: 1 }],
      },
      unknown: { a4: { reason: "failed" } },
      cut: {
        a5: [
          { kind: "truncated", limit: 100 },
          { kind: "days", days: 7 },
        ],
      },
    }),
  };
  const g = newGraph();
  const lineupL = g.loader({
    ...free,
    id: "lineup",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.lineup.load,
  });
  const listenersL = g.loader({
    ...free,
    id: "listeners",
    keyedBy: "artist",
    connectors: { allOf: ["wh"] },
    load: f.listeners.load,
  });
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:N",
    strategies: (s) => [
      s(lineupL, { coverage: LINEUP, project: (_ref, v) => v.map((x) => ({ to: x.artist })) }),
    ],
  });
  const listeners = g.provider("listeners", {
    loader: listenersL,
    temporal: "historical",
    rows: "many",
    project: (v) => v.map((p) => ({ market: p.market, streams: p.streams, user: p.user })),
    raw: { market: m("Market"), streams: m("Streams"), user: m("User") },
    derived: (d) => ({
      channel: d(["user"], ({ user }) => (user >= 10_000 ? "radio" : "web"), m("Channel")),
      hit: d(["streams"], ({ streams }) => streams >= 10, m("Hit")),
    }),
  });
  const performerCount = g.provider("performerCount", {
    loader: lineupL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ performers: v.length }],
    raw: { performers: m("Performers") },
  });
  return {
    graph: g.graph(
      g.route("track", listeners, g.path(performer)),
      g.route("track", performerCount, g.itself("track")),
    ),
    f,
    performer,
    listeners,
    performerCount,
  };
}

const A1_ROWS = [
  { market: "a", streams: 1, user: 12_000, channel: "radio", hit: false },
  { market: "b", streams: 20, user: 5, channel: "web", hit: true },
];

describe("run: providers", () => {
  it("rows per key, with raw fields and the derived ones computed from them, each with its index and chain", async () => {
    const { graph, performer } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: ["listeners"] }),
    );

    const chain = [link(performer.id, "lineup", "t1", "a1")];
    expect(rowsOf(providerOf(result, "t1", "listeners"))).toEqual([
      { ref: "a1", index: 0, fields: A1_ROWS[0], lineage: [chain] },
      { ref: "a1", index: 1, fields: A1_ROWS[1], lineage: [chain] },
    ]);
  });

  it("two base rows sharing a key both get the rows, each with the chain once", async () => {
    const { graph, f, performer } = build();
    const both: BaseRef[] = [
      { row: "r1", entity: "track", key: "t1" },
      { row: "r2", entity: "track", key: "t1" },
    ];
    const result = await run(graph, options({ refs: both, providers: ["listeners"] }));

    expect(f.lineup.loaded()).toEqual(["t1"]);
    expect(f.listeners.loaded()).toEqual(["a1"]);
    for (const row of ["r1", "r2"]) {
      const rows = rowsOf(providerOf(result, row, "listeners"));
      expect(rows.map((r) => r.fields)).toEqual(A1_ROWS);
      for (const r of rows) expect(r.lineage).toEqual([[link(performer.id, "lineup", "t1", "a1")]]);
    }
  });

  it("base rows of different keys reaching one provider key: read once, each row gets it along its own chain", async () => {
    const { graph, f, performer } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t1", "t2"), providers: ["listeners"] }),
    );

    expect(f.listeners.loaded()).toEqual(["a1"]);
    for (const row of ["t1", "t2"]) {
      const rows = rowsOf(providerOf(result, row, "listeners"));
      expect(rows).toHaveLength(2);
      for (const r of rows) expect(r.lineage).toEqual([[link(performer.id, "lineup", row, "a1")]]);
    }
  });

  it("absent within the coverage of the step that found nothing; unknown with the reason of the step that could not read", async () => {
    const { graph } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t3", "t4", "t6", "t7"), providers: ["listeners"] }),
    );

    expect(providerOf(result, "t3", "listeners")).toEqual({
      rows: [],
      outcome: "absent",
      unknown: [],
      cut: [],
      coverage: [LINEUP],
    });
    expect(providerOf(result, "t4", "listeners")).toEqual({
      rows: [],
      outcome: "unknown",
      unknown: [{ reason: "failed" }],
      cut: [],
      coverage: [],
    });
    // the relation found a3, the provider's source has nothing for it
    const t6 = providerOf(result, "t6", "listeners");
    expect(t6.outcome).toBe("absent");
    expect(t6.rows).toEqual([]);
    expect(t6.unknown).toEqual([]);
    // the relation found a4, the provider's source could not read it
    const t7 = providerOf(result, "t7", "listeners");
    expect(t7.outcome).toBe("unknown");
    expect(t7.unknown).toEqual([{ reason: "failed" }]);
    expect(stepsOf(result, "t7", "provider:listeners")).toMatchObject([
      { loader: "listeners", ref: "a4", outcome: "unknown", reason: { reason: "failed" } },
    ]);
  });

  it("a provider value that projects to no row is absent", async () => {
    const { graph } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t5"), providers: ["listeners"] }),
    );

    const p = providerOf(result, "t5", "listeners");
    expect(p.outcome).toBe("absent");
    expect(p.rows).toEqual([]);
  });

  it("every cut at the provider's own source is listed on the result and on the row step", async () => {
    const { graph } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t8"), providers: ["listeners"] }),
    );

    const p = providerOf(result, "t8", "listeners");
    expect(p.outcome).toBe("found");
    expect(p.cut).toEqual([
      { kind: "truncated", limit: 100 },
      { kind: "days", days: 7 },
    ]);
    expect(stepsOf(result, "t8", "provider:listeners")).toMatchObject([
      {
        ref: "a5",
        outcome: "found",
        cuts: [
          { kind: "truncated", limit: 100 },
          { kind: "days", days: 7 },
        ],
      },
    ]);
  });

  it("found through one key while another could not be read: found, the reason listed", async () => {
    const { graph } = build();
    const result = await run(
      graph,
      options({ refs: refs("track", "t9"), providers: ["listeners"] }),
    );

    const p = providerOf(result, "t9", "listeners");
    expect(p.outcome).toBe("found");
    expect(refsOf(p)).toEqual(["a1"]);
    expect(p.unknown).toEqual([{ reason: "failed" }]);
  });

  it("a provider asked as itself types its rows by its fields, raw and derived; asked by id, it reads the same", async () => {
    const { graph, listeners } = build();
    const typed = await run(graph, options({ refs: refs("track", "t1"), providers: [listeners] }));
    const byId = await run(graph, options({ refs: refs("track", "t1"), providers: ["listeners"] }));

    const p = typed.rows.get("t1")?.providers.listeners;
    expect(p?.rows).toEqual(byId.rows.get("t1")?.providers.listeners?.rows);
    const fields = p?.rows[0]?.fields;
    expect(fields?.channel).toBe("radio");
    if (fields) {
      expectTypeOf(fields.market).toEqualTypeOf<string>();
      expectTypeOf(fields.streams).toEqualTypeOf<number>();
      expectTypeOf(fields.hit).toEqualTypeOf<boolean>();
      // @ts-expect-error: no field "price" on listeners
      expect(fields.price).toBeUndefined();
    }
    expectTypeOf(byId.rows.get("t1")?.providers.listeners?.rows[0]?.fields).toEqualTypeOf<
      Readonly<Record<string, unknown>> | undefined
    >();
  });

  it("a provider whose rows are declared as an interface types its fields as a type alias would", async () => {
    interface Line {
      readonly title: string;
      readonly plays: number;
    }
    const g = newGraph();
    const f = fake<readonly Line[]>({ found: { t1: [{ title: "a", plays: 2 }] } });
    const loader = g.loader({
      ...free,
      id: "lines",
      keyedBy: "track",
      connectors: { allOf: ["db"] },
      load: f.load,
    });
    const lines = g.provider("lines", {
      loader,
      temporal: "historical",
      rows: "many",
      project: (v) => v,
      raw: { title: m("Title"), plays: m("Plays") },
    });
    const result = await run(
      g.graph(g.route("track", lines, g.itself("track"))),
      options({ refs: refs("track", "t1"), providers: [lines] }),
    );

    const fields = result.rows.get("t1")?.providers.lines.rows[0]?.fields;
    expect(fields).toEqual({ title: "a", plays: 2 });
    expectTypeOf(fields).toEqualTypeOf<
      { readonly title: string; readonly plays: number } | undefined
    >();
  });

  it("a provider declared on another graph is refused before anything is read", async () => {
    const { graph, f } = build();
    const other = build();
    const error = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: [other.listeners] }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(DefinitionError);
    expect((error as DefinitionError).code).toBe("HG_FOREIGN");
    expect(f.lineup.calls).toEqual([]);
  });

  it("a provider that may be one of several, or asked in an array, may be missing from the types", async () => {
    const { graph, listeners, performerCount } = build();
    const either = (pickListeners: boolean) => (pickListeners ? listeners : performerCount);
    const one = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: [either(false)] }),
    );
    const row = one.rows.get("t1");
    if (!row) throw new Error("no row");
    expectTypeOf(row.providers.listeners).toBeNullable();
    expectTypeOf(row.providers.performerCount).toBeNullable();
    // @ts-expect-error: listeners may not have been asked
    expect(() => row.providers.listeners.rows).toThrow(TypeError);
    expect(row.providers.performerCount?.rows[0]?.fields.performers).toBe(1);

    const asked: (typeof listeners | typeof performerCount)[] = [performerCount];
    const listed = await run(graph, options({ refs: refs("track", "t1"), providers: asked }));
    expectTypeOf(listed.rows.get("t1")?.providers.listeners).toBeNullable();
    expect(listed.rows.get("t1")?.providers.listeners).toBeUndefined();

    const both = await run(
      graph,
      options({ refs: refs("track", "t1"), providers: [listeners, performerCount] }),
    );
    const sure = both.rows.get("t1");
    if (sure) {
      expectTypeOf(sure.providers.listeners).not.toBeNullable();
      expectTypeOf(sure.providers.performerCount.rows[0]?.fields.performers).toEqualTypeOf<
        number | undefined
      >();
    }
  });
});
