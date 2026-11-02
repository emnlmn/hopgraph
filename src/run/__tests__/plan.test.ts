import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Envelope, entity, hopgraph, type Retention } from "../../core/index.ts";
import { plan } from "../plan.ts";

type Meta = { label: string };
const m = (label: string) => ({ meta: { label } });
const never = async (): Promise<Envelope<string, { to: string }>> => {
  throw new Error("plans read nothing");
};
const free = {
  version: 1,
  batch: { by: "partition" },
  keep: (): Retention => "day",
  partial: "keep",
  connectors: { allOf: ["db"] },
  load: never,
} as const;

/** track › master › studio, master › studio two ways, and ways back to track: enough to plan. */
function graph() {
  const track = entity({ key: z.string() });
  const master = entity({ key: z.string() });
  const studio = entity({ key: z.string() });
  const g = hopgraph<object, Meta>().entities({ track, master, studio });
  const recordings = g.loader({ ...free, id: "recordings", keyedBy: "track" });
  const mastering = g.loader({ ...free, id: "mastering", keyedBy: "master" });
  const archive = g.loader({ ...free, id: "archive", keyedBy: "master" });
  const origin = g.loader({ ...free, id: "origin", keyedBy: "studio" });
  const toTarget = (_ref: unknown, v: { to: string }) => [{ to: v.to }];
  const mastered = g.relation("track", "master", "mastered", {
    cardinality: "1:N",
    strategies: (s) => [s(recordings, { project: toTarget })],
  });
  const masteredAt = g.relation("master", "studio", "masteredAt", {
    cardinality: "N:1",
    strategies: (s) => [s(mastering, { project: toTarget })],
  });
  const archivedAt = g.relation("master", "studio", "archivedAt", {
    cardinality: "N:1",
    strategies: (s) => [s(archive, { project: toTarget })],
  });
  const firstTrack = g.relation("studio", "track", "first", {
    cardinality: "1:1",
    strategies: (s) => [s(origin, { project: toTarget })],
  });
  const back = g.relation("master", "track", "back", {
    cardinality: "N:1",
    strategies: (s) => [s(archive, { project: toTarget })],
  });
  const spec = { temporal: "current", rows: "one", raw: { to: m("To") } } as const;
  const studioInfo = g.provider("studioInfo", { ...spec, loader: origin, project: (v) => [v] });
  const firstStudio = g.provider("firstStudio", { ...spec, loader: origin, project: (v) => [v] });
  const trackInfo = g.provider("trackInfo", { ...spec, loader: recordings, project: (v) => [v] });
  const masterInfo = g.provider("masterInfo", { ...spec, loader: mastering, project: (v) => [v] });
  // through `mastered` twice: its one step would wait for itself
  return {
    def: g.graph(
      g.route("track", studioInfo, g.path(mastered, masteredAt)),
      g.route("master", studioInfo, g.path(masteredAt)),
      g.route(
        "track",
        firstStudio,
        g.union(g.path(mastered, masteredAt), g.path(mastered, archivedAt)),
      ),
      g.route("studio", trackInfo, g.path(firstTrack)),
      g.route("master", trackInfo, g.path(masteredAt, firstTrack)),
      g.route("track", masterInfo, g.path(mastered, back, mastered)),
    ),
    mastered,
    masteredAt,
    archivedAt,
    back,
  };
}

describe("plan", () => {
  it("one node per step for the whole run: a relation two bases reach at different depths is one", () => {
    const { def, masteredAt } = graph();
    const { nodes } = plan(def, ["track", "master"], ["studioInfo"]);
    expect(nodes.map((n) => n.id).sort()).toEqual(
      [
        "base:track",
        "base:master",
        "track › master:mastered",
        masteredAt.id,
        "provider:studioInfo",
      ].sort(),
    );
    expect(nodes.find((n) => n.id === masteredAt.id)?.feeds).toEqual([
      "track › master:mastered",
      "base:master",
    ]);
  });

  it("routes that order two relations both ways are refused before anything runs, naming the cycle", () => {
    const { def, mastered, back } = graph();
    expect(() => plan(def, ["track"], ["masterInfo"])).toThrow(
      `cycle ("${mastered.id}", then "${back.id}", then "${mastered.id}")`,
    );
  });

  it("refuses what it cannot run: no route, an unknown provider or base", () => {
    const { def } = graph();
    expect(() => plan(def, ["studio"], ["studioInfo"])).toThrow('no route "studio" › "studioInfo"');
    expect(() => plan(def, ["track"], ["nope"])).toThrow('no provider "nope"');
    expect(() => plan(def, ["statement"], ["studioInfo"])).toThrow('"statement" is not an entity');
  });

  it("each refusal is a DefinitionError whose code says what was refused", () => {
    const { def } = graph();
    const refused = (bases: string[], providers: string[], code: string) =>
      expect(() => plan(def, bases, providers)).toThrow(
        expect.objectContaining({ name: "DefinitionError", code }),
      );
    refused(["studio"], ["studioInfo"], "HG_NO_ROUTE");
    refused(["track"], ["nope"], "HG_UNKNOWN_PROVIDER");
    refused(["statement"], ["studioInfo"], "HG_UNKNOWN_ENTITY");
    refused(["track"], ["masterInfo"], "HG_CYCLE");
  });
});
