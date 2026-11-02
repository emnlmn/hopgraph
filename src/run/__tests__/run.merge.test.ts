// Merged reads (core `LoaderInput.merge`, DESIGN.md §3.1): refs of one key whose needs differ are
// priced and read in one call with the merged needs, each keeping what `narrow` selects for its
// own; a ref left with nothing is absent; a cut read leaves every ref cut, never absent.

import { describe, expect, it } from "vitest";
import { type Answer, type Envelope, envelope } from "../../core/index.ts";
import { run } from "../index.ts";
import { free, m, newGraph, options, providerOf, refs } from "./support.ts";

type Masters = { readonly masters: readonly { readonly id: string; readonly at: string }[] };

const MASTERS = [
  { id: "m1", at: "2026-09-15" },
  { id: "m2", at: "2026-05-01" },
];
/** each artist reaches track t1, released on a different day */
const RELEASED: Readonly<Record<string, string>> = {
  a1: "2026-09-01",
  a2: "2026-10-01",
  a3: "2026-03-03",
};

/** `answers`: the merged read is found (the default), absent, or its call throws. */
function build(
  opts: { readonly cut?: boolean; readonly answers?: "found" | "absent" | "throws" } = {},
) {
  const calls: { key: string; releasedAt: string }[][] = [];
  const priced: { key: string; releasedAt: string }[][] = [];
  const g = newGraph();
  const recentL = g.loader({
    ...free,
    id: "recentTracks",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: async (rs): Promise<Envelope<string, { track: string; releasedAt: string }[]>> =>
      envelope(
        rs.map((r) => [
          r.key,
          { kind: "found", value: [{ track: "t1", releasedAt: RELEASED[r.key] ?? "" }] },
        ]),
      ),
  });
  const windowedL = g.loader({
    ...free,
    id: "windowed",
    keyedBy: "track",
    needs: ["releasedAt"],
    connectors: { allOf: ["wh"] },
    cost: { metered: { auto: 1e12, approve: 1e12 } },
    price: async (rs) => {
      priced.push(rs.map((r) => ({ key: r.key, releasedAt: r.releasedAt })));
      return 1e9;
    },
    load: async (rs): Promise<Envelope<string, Masters>> => {
      calls.push(rs.map((r) => ({ key: r.key, releasedAt: r.releasedAt })));
      if (opts.answers === "throws") throw new Error("warehouse down");
      if (opts.answers === "absent") return envelope(rs.map((r) => [r.key, { kind: "absent" }]));
      return envelope(
        rs.map((r): readonly [string, Answer<Masters>] => [
          r.key,
          {
            kind: "found",
            value: { masters: MASTERS.filter((p) => p.at >= r.releasedAt) },
            ...(opts.cut ? { cuts: [{ kind: "cap", limit: 2 }] } : {}),
          },
        ]),
      );
    },
    merge: {
      needs: (rs: readonly { readonly releasedAt: string }[]) => ({
        releasedAt: rs.map((r) => r.releasedAt).sort()[0] ?? "",
      }),
      narrow: (v: Masters, r: { readonly releasedAt: string }) => {
        const masters = v.masters.filter((p) => p.at >= r.releasedAt);
        return masters.length > 0 ? { masters } : undefined;
      },
      empty: { masters: [] },
    },
  });
  const recent = g.relation("artist", "track", "recent", {
    cardinality: "1:N",
    strategies: (s) => [
      s(recentL, {
        project: (_ref, v) =>
          v.map((x) => ({ to: x.track, carries: { releasedAt: x.releasedAt } })),
      }),
    ],
  });
  const trackMasters = g.provider("trackMasters", {
    loader: windowedL,
    temporal: "historical",
    rows: "many",
    project: (v) => v.masters.map((p) => ({ id: p.id })),
    raw: { id: m("Master") },
  });
  return { graph: g.graph(g.route("artist", trackMasters, g.path(recent))), calls, priced };
}

const ids = (result: Awaited<ReturnType<typeof run>>, row: string) =>
  providerOf(result, row, "trackMasters")
    .rows.map((r) => String(r.fields.id))
    .sort();

describe("run: merged reads", () => {
  it("one key with three need values is one dry run and one call with the merged needs; each ref keeps its own part, nothing left is absent", async () => {
    const { graph, calls, priced } = build();
    const result = await run(
      graph,
      options({ refs: refs("artist", "a1", "a2", "a3"), providers: ["trackMasters"] }),
    );

    // apart, three dry runs over the same data: three times the price of one read
    expect(priced).toEqual([[{ key: "t1", releasedAt: "2026-03-03" }]]);
    expect(calls).toEqual([[{ key: "t1", releasedAt: "2026-03-03" }]]);
    expect(ids(result, "a1")).toEqual(["m1"]);
    expect(ids(result, "a3")).toEqual(["m1", "m2"]);
    expect(providerOf(result, "a2", "trackMasters").outcome).toBe("absent");
  });

  it("a cut read leaves every ref cut: one with nothing left is not absent", async () => {
    const { graph } = build({ cut: true });
    const result = await run(
      graph,
      options({ refs: refs("artist", "a1", "a2"), providers: ["trackMasters"] }),
    );

    expect(ids(result, "a1")).toEqual(["m1"]);
    const a2 = providerOf(result, "a2", "trackMasters");
    expect(a2.outcome).not.toBe("absent");
    expect(a2.rows).toEqual([]);
    expect(a2.cut).toEqual([{ kind: "cap", limit: 2 }]);
  });

  it.each([
    ["absent", "absent", []],
    ["throws", "unknown", [{ reason: "failed" }]],
  ] as const)(
    "a merged read that is %s leaves every ref %s, each as it is",
    async (answers, outcome, unknown) => {
      const { graph, calls } = build({ answers });
      const result = await run(
        graph,
        options({ refs: refs("artist", "a1", "a2"), providers: ["trackMasters"] }),
      );

      expect(calls).toHaveLength(1);
      for (const row of ["a1", "a2"]) {
        const p = providerOf(result, row, "trackMasters");
        expect([p.outcome, p.rows, p.unknown]).toEqual([outcome, [], unknown]);
      }
    },
  );
});
