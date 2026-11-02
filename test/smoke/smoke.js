// Imports the build and runs one small graph through it: the check that `dist/` loads and works on
// a runtime the tests do not run on (Deno, Bun) as on Node. Plain JavaScript and no imports but
// the build, so every runtime runs it as it is:
//
//   node test/smoke/smoke.js    deno run test/smoke/smoke.js    bun test/smoke/smoke.js

import { checkGraph, createRunner, entity, envelope, hopgraph, run } from "../../dist/index.js";

const text = {
  "~standard": { version: 1, vendor: "smoke", validate: (value) => ({ value }) },
};

const g = hopgraph().entities({
  track: entity({ key: text }),
  artist: entity({ key: text, personal: true }),
});
const common = {
  version: 1,
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 10 },
  keep: () => "day",
  partial: "keep",
};
const tracks = g.loader({
  ...common,
  id: "tracks",
  keyedBy: "track",
  load: async (refs) =>
    envelope(
      refs.map((r) => [
        r.key,
        r.key === "t1" ? { kind: "found", value: { artist: "a1" } } : { kind: "absent" },
      ]),
    ),
});
const artists = g.loader({
  ...common,
  id: "artists",
  keyedBy: "artist",
  load: async (refs) =>
    envelope(refs.map((r) => [r.key, { kind: "found", value: { name: "Mira Volk" } }])),
});
const performer = g.relation("track", "artist", "performer", {
  cardinality: "N:1",
  strategies: (s) => [s(tracks, { project: (_ref, t) => [{ to: t.artist }] })],
});
const profile = g.provider("profile", {
  loader: artists,
  temporal: "current",
  rows: "one",
  project: (a) => [a],
  raw: { name: { meta: { label: "Name" } } },
});

const fail = (message) => {
  throw new Error(`smoke: ${message}`);
};
const graph = g.graph(g.route("track", profile, g.path(performer)));
const check = checkGraph(graph, { bases: ["track"] });
if (check.problems.length > 0) fail(`graph problems: ${check.problems.join("; ")}`);

const result = await run(graph, {
  refs: [
    { row: "r1", entity: "track", key: "t1" },
    { row: "r2", entity: "track", key: "t2" },
  ],
  providers: ["profile"],
  ctx: {},
  restriction: "",
  readable: () => true,
  cache: { getMany: async () => new Map(), setMany: async () => undefined },
  limits: { db: 2 },
  digest: (entity, keyId) => `${entity}#${keyId.length}`,
});

const found = result.rows.get("r1")?.providers.profile;
const absent = result.rows.get("r2")?.providers.profile;
if (found?.outcome !== "found" || found.rows[0]?.fields.name !== "Mira Volk")
  fail("r1 is not Mira Volk");
if (found.rows[0]?.ref !== "artist#2") fail("a personal key is not shown as its digest");
if (absent?.outcome !== "absent") fail("r2 is not absent");

// the same read through a runner: the env once, then a read by key with the defaults
const runner = createRunner(graph, { digest: (entity, keyId) => `${entity}#${keyId.length}` });
const read = await runner.read("track", ["t1", "t2"], ["profile"], { ctx: {} });
if (read.rows.get("t1")?.providers.profile.rows[0]?.fields.name !== "Mira Volk")
  fail("t1 is not Mira Volk");
if (read.rows.get("t2")?.providers.profile.outcome !== "absent") fail("t2 is not absent");
const runtime = typeof Deno !== "undefined" ? "Deno" : typeof Bun !== "undefined" ? "Bun" : "Node";
console.log(`smoke: the build runs on ${runtime}`);
