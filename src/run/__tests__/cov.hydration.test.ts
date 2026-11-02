// Hydration (run/hydration.ts): a key asked again by a step of a later wave, and a need on an
// entity that has no hydrator.

import { describe, expect, it } from "vitest";
import { run } from "../index.ts";
import type { BaseRef } from "../types.ts";
import { fake, free, m, newGraph, options, providerOf, stepsOf } from "./support.ts";

type Header = { readonly releasedAt: string; readonly catalog: string };

/**
 * `now` reads track t1 through a provider that needs its release date and catalog; `later` reads
 * the same track again, reached through an artist (two loads before it), so one wave behind.
 */
function build(withHydrator: boolean, known = true) {
  const header = fake<Header>(
    known ? { found: { t1: { releasedAt: "2026-10-15", catalog: "it" } } } : {},
  );
  const artists = fake<{ artist: string }[]>({ found: { t1: [{ artist: "a1" }] } });
  const recent = fake<{ track: string; releasedAt: string }[]>({
    found: { a1: [{ track: "t1", releasedAt: "2026-09-01" }] },
  });
  const windowed = fake<{ n: number }>({ found: { t1: { n: 1 } } });
  const g = newGraph();
  const headerL = g.loader({
    ...free,
    id: "trackHeader",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: header.load,
  });
  if (withHydrator)
    g.hydrator("track", headerL, (v) => ({ releasedAt: v.releasedAt, catalog: v.catalog }));
  const artistsL = g.loader({
    ...free,
    id: "trackArtists",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: artists.load,
  });
  const recentL = g.loader({
    ...free,
    id: "recentTracks",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: recent.load,
  });
  const windowedOf = (id: string) =>
    g.loader({
      ...free,
      id,
      keyedBy: "track",
      needs: ["releasedAt", "catalog"],
      connectors: { allOf: ["wh"] },
      load: windowed.load,
    });
  const providerOver = (id: string) =>
    g.provider(id, {
      loader: windowedOf(`${id}Window`),
      temporal: "historical",
      rows: "one",
      project: (v) => [{ n: v.n }],
      raw: { n: m("N") },
    });
  const now = providerOver("now");
  const later = providerOver("later");
  const by = g.relation("track", "artist", "by", {
    cardinality: "1:N",
    strategies: (s) => [s(artistsL, { project: (_ref, v) => v.map((x) => ({ to: x.artist })) })],
  });
  const recentRel = g.relation("artist", "track", "recent", {
    cardinality: "1:N",
    strategies: (s) => [
      s(recentL, {
        project: (_ref, v) =>
          v.map((x) => ({ to: x.track, carries: { releasedAt: x.releasedAt } })),
      }),
    ],
  });
  const graph = g.graph(
    g.route("track", now, g.itself("track")),
    g.route("track", later, g.path(by, recentRel)),
  );
  return { graph, header, windowed };
}

const T1: BaseRef[] = [{ row: "t1", entity: "track", key: "t1" }];

describe("hydration", () => {
  it("a key hydrated for one step is read once, though a step of a later wave lacks it again", async () => {
    const { graph, header, windowed } = build(true);
    const result = await run(graph, options({ refs: T1, providers: ["now", "later"] }));

    expect(header.loaded()).toEqual(["t1"]);
    expect(stepsOf(result, "t1", "hydrate:track")).toMatchObject([
      { loader: "trackHeader", ref: "t1", outcome: "found" },
    ]);
    expect(windowed.calls.length).toBeGreaterThan(0);
    expect(providerOf(result, "t1", "now").rows.map((r) => r.fields)).toEqual([{ n: 1 }]);
    expect(providerOf(result, "t1", "later").rows.map((r) => r.fields)).toEqual([{ n: 1 }]);
  });

  it("a key the hydrator does not know stays unmet for every step that needs it, read once", async () => {
    const { graph, header, windowed } = build(true, false);
    const result = await run(graph, options({ refs: T1, providers: ["now", "later"] }));

    expect(header.loaded()).toEqual(["t1"]);
    expect(windowed.calls).toEqual([]);
    expect(providerOf(result, "t1", "now").rows).toEqual([]);
    expect(providerOf(result, "t1", "later").rows).toEqual([]);
  });

  it("an entity with a need and no hydrator leaves its refs unmet, and reads nothing for them", async () => {
    const { graph, header, windowed } = build(false);
    const result = await run(graph, options({ refs: T1, providers: ["now", "later"] }));

    expect(header.calls).toEqual([]);
    expect(windowed.calls).toEqual([]);
    expect(providerOf(result, "t1", "now").rows).toEqual([]);
    expect(JSON.stringify(result.rows.get("t1"))).toContain("unmet");
  });
});
