// Verification (DESIGN.md §3.3; core VerificationDef): a relation may end with a loader keyed by
// its target; its rule sees all the candidates of one ref at once, each with what the loader said
// about its target, and keeps or drops each; a candidate it cannot decide stays, marked ambiguous.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Coverage } from "../../core/index.ts";
import { run } from "../index.ts";
import { fake, free, m, newGraph, options, providerOf, refs, refsOf, stepsOf } from "./support.ts";

const IDS: Coverage = { label: "track ids, any age" };

function build() {
  const f = {
    ids: fake<{ artist: string; catalog: string }[]>({
      found: {
        t1: [
          { artist: "a1", catalog: "it" },
          { artist: "a2", catalog: "it" },
          { artist: "a3", catalog: "it" },
        ],
        t2: [{ artist: "a2", catalog: "it" }],
        t3: [{ artist: "a3", catalog: "it" }],
        t4: [
          { artist: "a1", catalog: "it" },
          { artist: "a9", catalog: "it" },
        ],
        t5: [{ artist: "a8", catalog: "it" }],
      },
    }),
    check: fake<{ catalog: string | null }>({
      found: { a1: { catalog: "it" }, a2: { catalog: "fr" }, a3: { catalog: null } },
      unknown: { a8: { reason: "failed" } },
    }),
    profiles: fake<{ name: string }>({
      found: { a1: { name: "Mira Volk" }, a2: { name: "Ode Ferris" }, a3: { name: "Kit Lune" } },
    }),
  };
  const decided: { to: string; state: string; value: unknown }[][] = [];
  const g = newGraph();
  const idsL = g.loader({
    ...free,
    id: "idLookup",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.ids.load,
  });
  const checkL = g.loader({
    ...free,
    id: "artistCheck",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.check.load,
  });
  const profilesL = g.loader({
    ...free,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.profiles.load,
  });
  const byId = g.relation("track", "artist", "byId", {
    cardinality: "N:N",
    link: z.object({ catalog: z.string() }),
    strategies: (s) => [
      s(idsL, {
        coverage: IDS,
        project: (_ref, v) => v.map((x) => ({ to: x.artist, attrs: { catalog: x.catalog } })),
      }),
    ],
    // a target read: keep when its catalog matches, drop when it differs, undecided when it has none;
    // a target the check does not know: dropped when a sibling matched, otherwise undecided
    verify: (v) =>
      v(checkL, (candidates) => {
        decided.push(candidates.map((c) => ({ to: c.link.to, state: c.state, value: c.value })));
        const matched = candidates.some((c) => c.value?.catalog === c.link.attrs.catalog);
        return candidates.map((c) => {
          if (c.state !== "found") return matched ? "drop" : "undecided";
          if (c.value?.catalog == null) return "undecided";
          return c.value.catalog === c.link.attrs.catalog ? "keep" : "drop";
        });
      }),
  });
  const profile = g.provider("profile", {
    loader: profilesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });
  return { graph: g.graph(g.route("track", profile, g.path(byId))), f, byId, decided };
}

describe("run: verification", () => {
  it("reads every candidate in one job; keep stays, drop goes and is never read further, undecided stays", async () => {
    const { graph, f } = build();
    const result = await run(graph, options({ refs: refs("track", "t1"), providers: ["profile"] }));

    expect(f.check.calls).toHaveLength(1);
    expect(f.check.loaded()).toEqual(["a1", "a2", "a3"]);
    expect(f.profiles.loaded()).toEqual(["a1", "a3"]);
    const p = providerOf(result, "t1", "profile");
    expect(p.outcome).toBe("found");
    expect(refsOf(p)).toEqual(["a1", "a3"]);
    expect(p.unknown).toEqual([{ reason: "ambiguous" }]);
  });

  it("row steps: the relation counts its links before verification; verify: marks the undecided candidate ambiguous", async () => {
    const { graph, byId } = build();
    const result = await run(graph, options({ refs: refs("track", "t1"), providers: ["profile"] }));

    expect(stepsOf(result, "t1", byId.id)).toMatchObject([
      { loader: "idLookup", ref: "t1", outcome: "found", links: 3 },
    ]);
    const verify = stepsOf(result, "t1", `verify:${byId.id}`, "artistCheck");
    expect(verify.find((s) => s.ref === "a1")).toMatchObject({ outcome: "found" });
    expect(verify.find((s) => s.ref === "a3")).toMatchObject({
      outcome: "unknown",
      reason: { reason: "ambiguous" },
    });
  });

  it("every candidate dropped: the relation found nothing, so the provider is absent", async () => {
    const { graph, f } = build();
    const result = await run(graph, options({ refs: refs("track", "t2"), providers: ["profile"] }));

    expect(f.profiles.calls).toEqual([]);
    const p = providerOf(result, "t2", "profile");
    expect(p.outcome).toBe("absent");
    expect(p.rows).toEqual([]);
    expect(p.unknown).toEqual([]);
  });

  it("only an undecided candidate: its rows are given, found, and the result says ambiguous", async () => {
    const { graph } = build();
    const result = await run(graph, options({ refs: refs("track", "t3"), providers: ["profile"] }));

    const p = providerOf(result, "t3", "profile");
    expect(p.outcome).toBe("found");
    expect(refsOf(p)).toEqual(["a3"]);
    expect(p.unknown).toEqual([{ reason: "ambiguous" }]);
  });

  it("the rule sees all the candidates of one ref at once, in order, with each target's state and value", async () => {
    const { graph, f, decided } = build();
    const result = await run(graph, options({ refs: refs("track", "t4"), providers: ["profile"] }));

    expect(decided).toEqual([
      [
        { to: "a1", state: "found", value: { catalog: "it" } },
        { to: "a9", state: "absent", value: undefined },
      ],
    ]);
    // a9 is unknown to the check and a1 matched: a9 is dropped, never read further
    expect(f.profiles.loaded()).toEqual(["a1"]);
    const p = providerOf(result, "t4", "profile");
    expect(refsOf(p)).toEqual(["a1"]);
    expect(p.unknown).toEqual([]);
  });

  it("a target the check could not read reaches the rule as unknown; left undecided, it stays, ambiguous", async () => {
    const { graph, f, decided } = build();
    const result = await run(graph, options({ refs: refs("track", "t5"), providers: ["profile"] }));

    expect(decided).toEqual([[{ to: "a8", state: "unknown", value: undefined }]]);
    expect(f.profiles.loaded()).toEqual(["a8"]);
    expect(providerOf(result, "t5", "profile").unknown).toContainEqual({ reason: "ambiguous" });
  });
});
