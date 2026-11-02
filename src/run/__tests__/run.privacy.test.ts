// Privacy (DESIGN.md §6; run/types.ts `digest`): a key of a personal entity appears in the result
// only as `digest(entity, keyId)`: in row steps, provider rows' refs and lineage; never as itself,
// anywhere. Keys of entities that are not personal stay as their id.

import { describe, expect, it } from "vitest";
import { run } from "../index.ts";
import {
  digest,
  dump,
  fake,
  free,
  link,
  m,
  newGraph,
  options,
  providerOf,
  rowOf,
  rowsOf,
  stepsOf,
} from "./support.ts";

const ANNA = "anna@example.com";
const BOB = "bob@example.com";

function build() {
  const f = {
    header: fake<{ email: string }>({ found: { t1: { email: ANNA }, t2: { email: BOB } } }),
    owner: fake<{ artist: string }>({
      found: { [ANNA]: { artist: "a1" } },
      unknown: { [BOB]: { reason: "failed" } },
    }),
    bounces: fake<{ bounced: boolean }>({ found: { [ANNA]: { bounced: false } } }),
    profiles: fake<{ name: string }>({ found: { a1: { name: "Mira Volk" } } }),
  };
  const g = newGraph();
  const headerL = g.loader({
    ...free,
    id: "trackHeader",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.header.load,
  });
  const ownerL = g.loader({
    ...free,
    id: "emailOwner",
    keyedBy: "email",
    connectors: { allOf: ["db"] },
    load: f.owner.load,
  });
  const bouncesL = g.loader({
    ...free,
    id: "bounces",
    keyedBy: "email",
    connectors: { allOf: ["api"] },
    load: f.bounces.load,
  });
  const profilesL = g.loader({
    ...free,
    id: "profiles",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.profiles.load,
  });
  const contact = g.relation("track", "email", "contact", {
    cardinality: "N:1",
    strategies: (s) => [s(headerL, { project: (_ref, v) => [{ to: v.email }] })],
  });
  const registered = g.relation("email", "artist", "registered", {
    cardinality: "N:1",
    strategies: (s) => [s(ownerL, { project: (_ref, v) => [{ to: v.artist }] })],
  });
  const bounces = g.provider("bounces", {
    loader: bouncesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ bounced: v.bounced }],
    raw: { bounced: m("Bounced") },
  });
  const profile = g.provider("profile", {
    loader: profilesL,
    temporal: "current",
    rows: "one",
    project: (v) => [{ name: v.name }],
    raw: { name: m("Name") },
  });
  return {
    graph: g.graph(
      g.route("track", bounces, g.path(contact)),
      g.route("track", profile, g.path(contact, registered)),
      g.route("email", bounces, g.itself("email")),
    ),
    f,
    contact,
    registered,
  };
}

describe("run: personal keys", () => {
  it("a personal key shows only as its digest in row steps, rows and lineage; other keys as their id", async () => {
    const { graph, contact, registered } = build();
    const digests: [string, string][] = [];
    const result = await run(
      graph,
      options({
        refs: [
          { row: "r1", entity: "track", key: "t1" },
          { row: "r2", entity: "track", key: "t2" },
        ],
        providers: ["bounces", "profile"],
        digest: (entity, keyId) => {
          digests.push([entity, keyId]);
          return digest(entity, keyId);
        },
      }),
    );

    const anna = digest("email", ANNA);
    const bob = digest("email", BOB);
    expect(digests.map(([, k]) => k)).toContain(ANNA);

    expect(rowsOf(providerOf(result, "r1", "profile"))).toEqual([
      {
        ref: "a1",
        index: 0,
        fields: { name: "Mira Volk" },
        lineage: [
          [
            link(contact.id, "trackHeader", "t1", anna),
            link(registered.id, "emailOwner", anna, "a1"),
          ],
        ],
      },
    ]);
    expect(rowsOf(providerOf(result, "r1", "bounces"))).toEqual([
      {
        ref: anna,
        index: 0,
        fields: { bounced: false },
        lineage: [[link(contact.id, "trackHeader", "t1", anna)]],
      },
    ]);
    expect(stepsOf(result, "r1", registered.id)).toMatchObject([
      { loader: "emailOwner", ref: anna, outcome: "found" },
    ]);
    expect(stepsOf(result, "r1", "provider:bounces")).toMatchObject([
      { loader: "bounces", ref: anna, outcome: "found" },
    ]);
    expect(stepsOf(result, "r2", registered.id)).toMatchObject([
      { loader: "emailOwner", ref: bob, outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(stepsOf(result, "r1", contact.id)).toMatchObject([{ ref: "t1", outcome: "found" }]);

    const text = dump(result);
    expect(text).not.toContain(ANNA);
    expect(text).not.toContain(BOB);
  });

  it("a base row whose entity is personal: its own key is a digest too", async () => {
    const { graph } = build();
    const result = await run(
      graph,
      options({ refs: [{ row: "e1", entity: "email", key: ANNA }], providers: ["bounces"] }),
    );

    const anna = digest("email", ANNA);
    expect(rowsOf(providerOf(result, "e1", "bounces"))).toEqual([
      { ref: anna, index: 0, fields: { bounced: false }, lineage: [[]] },
    ]);
    expect(rowOf(result, "e1").steps.map((s) => s.ref)).toEqual([anna]);
    expect(dump(result)).not.toContain(ANNA);
  });
});
