// A playlist read from a music catalog, across three in-memory sources: the tracks table, the
// artists table and a label service that is switched off in this deployment. One run answers, for a
// list of track ids, the track itself, its performer's profile and its performer's label, each with
// an outcome that says whether the value was found, searched and absent, or not read and why.
//
// Run it (Node 22.18 or later, which runs TypeScript by stripping its types):
//
//   npm run build && node examples/playlist.ts
//
// examples/playlist.test.ts runs it on every `npm test`, so it cannot fall behind the library.

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  absent,
  type CachePort,
  createRunner,
  entity,
  envelope,
  found,
  hopgraph,
  memoryCache,
  type RunResult,
  type Schema,
  type Tracer,
} from "hopgraph";

// ---------------------------------------------------------------- the sources

interface TrackRow {
  readonly artist: string;
  readonly plays: number;
}
interface ArtistRow {
  readonly name: string;
  readonly country: string;
}

const TRACKS = new Map<string, TrackRow>([
  ["t1", { artist: "a1", plays: 120 }],
  ["t2", { artist: "a2", plays: 40 }],
  ["t3", { artist: "a1", plays: 75 }],
  ["t4", { artist: "a9", plays: 10 }], // a performer the artists table does not know
]);
const ARTISTS = new Map<string, ArtistRow>([
  ["a1", { name: "Mira Volk", country: "IT" }],
  ["a2", { name: "Ode Ferris", country: "FR" }],
]);

/** Every call a source received, in order: what batching did. */
export const calls: { readonly source: string; readonly keys: readonly string[] }[] = [];

/** Found when the table has the key, absent when it does not. */
function lookup<V>(
  source: string,
  table: ReadonlyMap<string, V>,
  refs: readonly { readonly key: string }[],
) {
  calls.push({ source, keys: refs.map((r) => r.key) });
  return envelope(
    refs.map((r) => {
      const row = table.get(r.key);
      return [r.key, row ? found(row) : absent()];
    }),
  );
}

// ---------------------------------------------------------------- the graph

// A key schema is any Standard Schema (Zod, or another validator's): the library only carries its
// type.
// This one avoids a dependency.
const text: Schema<string> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (v) => (typeof v === "string" ? { value: v } : { issues: [{ message: "a string" }] }),
  },
};

/** What every field must say about itself; opaque to the library. */
type Meta = { readonly label: string };
const label = (name: string) => ({ meta: { label: name } });

// no `Ctx`: the runs of this graph carry none, so a call leaves it out
const g = hopgraph<Meta, "db" | "labelApi">().entities({
  track: entity({ key: text }),
  artist: entity({ key: text }),
});

const tracks = g.loader({
  id: "tracks",
  // no `version`: it is 1, part of every cache key; bump it when the value changes shape or meaning
  keyedBy: "track",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },
  // no `keep`: a found track is kept for a day, an absent one briefly
  load: async (refs) => lookup("tracks", TRACKS, refs),
});

const artists = g.loader({
  id: "artists",
  keyedBy: "artist",
  connectors: { allOf: ["db"] },
  // two keys per statement, to show the batches in `calls`
  batch: { by: "keys", max: 2 },
  load: async (refs) => lookup("artists", ARTISTS, refs),
});

const labels = g.loader({
  id: "labels",
  keyedBy: "artist",
  connectors: { allOf: ["labelApi"] },
  batch: { by: "one", concurrency: 4 },
  keep: () => "brief",
  load: async (refs) => lookup("labels", new Map([["a1", { name: "Hollowreed Records" }]]), refs),
});

const performer = g.relation("track", "artist", "performer", {
  cardinality: "N:1",
  strategies: (s) => [s(tracks, { project: (_ref, row) => [{ to: row.artist }] })],
});

const trackSummary = g.provider("trackSummary", {
  loader: tracks,
  temporal: "historical",
  rows: "one",
  project: (row) => [{ plays: row.plays }],
  raw: { plays: label("Plays") },
  derived: (d) => ({ hit: d(["plays"], ({ plays }) => plays >= 100, label("Hit")) }),
});

const artistProfile = g.provider("artistProfile", {
  loader: artists,
  temporal: "current",
  rows: "one",
  project: (row) => [{ name: row.name, country: row.country }],
  raw: { name: label("Name"), country: label("Country") },
});

const labelName = g.provider("labelName", {
  loader: labels,
  temporal: "current",
  rows: "one",
  project: (row) => [{ name: row.name }],
  raw: { name: label("Label") },
});

export const graph = g.graph(
  g.route("track", trackSummary),
  g.route("track", artistProfile, g.path(performer)),
  g.route("track", labelName, g.path(performer)),
);

// ---------------------------------------------------------------- a read

/**
 * Five tracks read by their keys, over a cache of its own unless one is given, reported to
 * `tracer` when one is (examples/otel.ts, examples/metrics.ts). A process makes its runner once,
 * at startup; this one makes it here so that each test gives it its own cache and tracer.
 */
export function example(
  o: { readonly tracer?: Tracer; readonly cache?: CachePort } = {},
): Promise<RunResult<readonly [typeof trackSummary, typeof artistProfile, typeof labelName]>> {
  const runner = createRunner(graph, {
    cache: o.cache ?? memoryCache(),
    ...(o.tracer ? { tracer: o.tracer } : {}),
    // the label service is switched off in this deployment: its fields are unknown, never empty
    readable: (connector) => (connector === "labelApi" ? "disabled" : true),
    limits: { db: 4 },
    digest: (_entity, keyId) => createHash("sha256").update(keyId).digest("hex").slice(0, 12),
  });
  // providers as declared, so rows are typed (a field picker passes ids: ["trackSummary", …])
  return runner.read(
    "track",
    ["t1", "t2", "t3", "t4", "t5"],
    [trackSummary, artistProfile, labelName],
  );
}

async function main(): Promise<void> {
  const result = await example();
  for (const [row, answer] of result.rows) {
    console.log(row);
    for (const [provider, p] of Object.entries(answer.providers)) {
      const fields = p.rows.map((r) => JSON.stringify(r.fields));
      const why = p.unknown.map((u) => (u.reason === "unread" ? `unread: ${u.why}` : u.reason));
      console.log(
        `  ${provider.padEnd(16)} ${[p.outcome.padEnd(8), ...fields, ...why].join(" ").trimEnd()}`,
      );
    }
  }
  console.log("\nsource calls");
  for (const c of calls) console.log(`  ${c.source.padEnd(10)} ${c.keys.join(", ")}`);
  console.log("\ntrace");
  for (const t of result.trace) {
    const unknown = Object.entries(t.unknown).map(([reason, n]) => `, unknown ${reason} ${n}`);
    console.log(
      `  ${t.step.padEnd(26)} ${t.loader.padEnd(10)} keys ${t.keysIn}, found ${t.found}, ` +
        `absent ${t.absent}${unknown.join("")}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
