// Decided with test/regressions/fallback-open-circuit.test.ts: a fallback goes on past a strategy
// that did not read the whole of a key, and keeps what that strategy met beside what the next one
// finds. Here a track's artist comes from `recent`, which reads ten days and reports the cut,
// else from `archive`. For t1, `recent` read its ten days and found no artist, and `archive`
// found a2, who has no profile. The run said the profile was absent, though the days `recent` did
// not read might have named a1, who has one. Absent only when everything was read uncut (DESIGN.md
// §3.3): the profile is unknown, the cut listed; and a profile `archive` leads to is found, the cut
// listed beside it. Fixed with the rule: a fallback keeps the cuts of the strategies it went past.

import { entity, envelope, found, hopgraph, run, type Schema } from "hopgraph";
import { expect, it } from "vitest";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "found", validate: (value) => ({ value: value as string }) },
};

const TEN_DAYS = { kind: "days", days: 10 } as const;

/** t1's profile, `archive` leading to `archiveFinds`: a1 has a profile, a2 none. */
function ask(archiveFinds: "a1" | "a2") {
  const g = hopgraph<undefined, { readonly label: string }>().entities({
    track: entity({ key: text }),
    artist: entity({ key: text }),
  });
  const common = {
    batch: { by: "partition" },
    connectors: { allOf: ["db"] },
    keep: () => "none" as const,
  } as const;
  const recent = g.loader({
    ...common,
    id: "recent",
    keyedBy: "track",
    load: async (refs) =>
      envelope(refs.map((r) => [r.key, found<{ to?: string }>({}, { cuts: [TEN_DAYS] })])),
  });
  const archive = g.loader({
    ...common,
    id: "archive",
    keyedBy: "track",
    load: async (refs) => envelope(refs.map((r) => [r.key, found({ to: archiveFinds })])),
  });
  const profiles = g.loader({
    ...common,
    id: "profiles",
    keyedBy: "artist",
    load: async (refs) =>
      envelope(
        refs.map((r) =>
          r.key === "a1"
            ? ([r.key, found({ name: "Mira Volk" })] as const)
            : ([r.key, { kind: "absent" }] as const),
        ),
      ),
  });
  const to = (_ref: unknown, v: { to?: string }) => (v.to ? [{ to: v.to }] : []);
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    combine: "fallback",
    strategies: (s) => [s(recent, { project: to }), s(archive, { project: to })],
  });
  const profile = g.provider("profile", {
    loader: profiles,
    temporal: "current",
    rows: "one",
    project: (v) => [v],
    raw: { name: { meta: { label: "Name" } } },
  });
  const graph = g.graph(g.route("track", profile, g.path(performer)));
  return run(graph, { refs: [{ row: "r1", entity: "track", key: "t1" }], providers: [profile] });
}

it("a fallback past a strategy cut short never makes absent what the rest of it might have found", async () => {
  const result = await ask("a2");
  expect(result.rows.get("r1")?.providers.profile).toMatchObject({
    outcome: "unknown",
    rows: [],
    unknown: [],
    cut: [TEN_DAYS],
  });
});

it("what a fallback finds past a strategy cut short stands, the cut beside it", async () => {
  const result = await ask("a1");
  const profile = result.rows.get("r1")?.providers.profile;
  expect(profile?.outcome).toBe("found");
  expect(profile?.rows.map((r) => r.fields)).toEqual([{ name: "Mira Volk" }]);
  expect(profile?.cut).toEqual([TEN_DAYS]);
});
