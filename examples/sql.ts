// A row store read the way a relational database is: by statements of up to N keys, each key with
// its own window, and a per-key cap inside the statement. The question: for a list of playlist
// pitches, the tracks their artist released in the 30 days before the pitch was sent, at most
// three per pitch, newest first.
//
// What it shows:
// - `batch: { by: "keys", max }`: the keys of one wave are cut into statements of `max` keys, in key
//   order.
// - a need: the window depends on the pitch that reached the artist (`pitchedAt`, a context
//   attribute the link carries), so two pitches of one artist read two windows. One key read with
//   two windows is two loader keys, in separate statements: an envelope tells keys apart by key.
// - a per-key cap inside the statement (`ROW_NUMBER() OVER (PARTITION BY ...) <= 3`), reported as a
//   `cap` cut: a pitch whose artist has more tracks is found, but cut, and a consumer can say so.
// - a failed statement: its keys are unknown, `failed`, with its code in the trace; the other
//   statement's keys stand (`partial: "keep"`, the default).
// - `oneOf` connectors: the loader reads a primary or a replica, whichever this deployment may.
//
// The "database" is a table in memory and a function that runs the one statement this loader
// sends; the statement's text is printed so the shape of the real query is plain.
//
//   npm run build && node examples/sql.ts

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  absent,
  createRunner,
  entity,
  envelope,
  found,
  hopgraph,
  memoryCache,
  type RunResult,
  type Schema,
  unknown,
} from "hopgraph";

// ---------------------------------------------------------------- the database

interface TrackRow {
  readonly id: string;
  readonly artist: string;
  readonly releasedAt: string;
  readonly plays: number;
}

const TRACKS: readonly TrackRow[] = [
  { id: "t1", artist: "a1", releasedAt: "2026-10-02", plays: 40 },
  { id: "t2", artist: "a1", releasedAt: "2026-10-09", plays: 15 },
  { id: "t3", artist: "a1", releasedAt: "2026-10-20", plays: 99 },
  { id: "t4", artist: "a1", releasedAt: "2026-10-25", plays: 12 },
  { id: "t5", artist: "a2", releasedAt: "2026-06-01", plays: 70 },
  { id: "t6", artist: "a3", releasedAt: "2026-10-28", plays: 33 },
];

const PITCHES = new Map([
  ["p1", { artist: "a1", pitchedAt: "2026-10-30" }],
  ["p2", { artist: "a1", pitchedAt: "2026-10-12" }],
  ["p3", { artist: "a2", pitchedAt: "2026-10-30" }],
  ["p4", { artist: "a3", pitchedAt: "2026-10-30" }],
]);

/** A statement that fails, as a driver would report it: by code, for the trace. */
class DriverError extends Error {
  override name = "DriverError";
  readonly code: string;
  constructor(code: string) {
    super(`statement failed (${code})`);
    this.code = code;
  }
}

/** Every statement sent, in order: what batching did. */
export const statements: string[] = [];

/** Artists whose statement fails, to show a failed statement. */
export const broken = new Set<string>();

const RECENT_TRACKS = `
  SELECT artist, window_end, id, released_at, plays FROM (
    SELECT t.*, w.window_end,
           ROW_NUMBER() OVER (PARTITION BY w.artist, w.window_end ORDER BY t.released_at DESC) AS n
    FROM tracks t JOIN UNNEST(:windows) w ON t.artist = w.artist
    WHERE t.released_at > w.window_start AND t.released_at <= w.window_end
  ) WHERE n <= :cap`;

/** Runs RECENT_TRACKS over the table: the rows of each window, newest first, at most `cap + 1` so
 *  that the caller can tell a window that had more. */
function recentTracks(
  windows: readonly { readonly artist: string; readonly start: string; readonly end: string }[],
  cap: number,
): Map<string, TrackRow[]> {
  statements.push(
    `${RECENT_TRACKS.trim().split("\n")[0]} … -- ${windows.map((w) => `${w.artist}@${w.end}`).join(", ")}`,
  );
  if (windows.some((w) => broken.has(w.artist))) throw new DriverError("57014");
  const out = new Map<string, TrackRow[]>();
  for (const w of windows) {
    const rows = TRACKS.filter(
      (t) => t.artist === w.artist && t.releasedAt > w.start && t.releasedAt <= w.end,
    ).sort((a, b) => (a.releasedAt < b.releasedAt ? 1 : -1));
    out.set(`${w.artist}@${w.end}`, rows.slice(0, cap + 1));
  }
  return out;
}

const minusDays = (iso: string, days: number) =>
  new Date(Date.parse(iso) - days * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- the graph

const text: Schema<string> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (v) => (typeof v === "string" ? { value: v } : { issues: [{ message: "a string" }] }),
  },
};

const CAP = 3;

const g = hopgraph<{ readonly label: string }, "primary" | "replica">().entities({
  pitch: entity({ key: text }),
  // `pitchedAt` only comes with the link from a pitch: no hydrator gives it
  artist: entity({ key: text, carries: { pitchedAt: text }, context: ["pitchedAt"] }),
});

const pitches = g.loader({
  id: "pitches",
  keyedBy: "pitch",
  connectors: { oneOf: ["primary", "replica"] },
  batch: { by: "keys", max: 500 },
  load: async (refs) =>
    envelope(
      refs.map((r) => {
        const pitch = PITCHES.get(r.key);
        return [r.key, pitch ? found(pitch) : absent()];
      }),
    ),
});

const recent = g.loader({
  id: "recentTracks",
  keyedBy: "artist",
  needs: ["pitchedAt"],
  connectors: { oneOf: ["primary", "replica"] },
  // two windows per statement, to show the batches
  batch: { by: "keys", max: 2 },
  load: async (refs) => {
    const windows = refs.map((r) => ({
      artist: r.key,
      start: minusDays(r.pitchedAt, 30),
      end: r.pitchedAt,
    }));
    let rows: Map<string, TrackRow[]>;
    try {
      rows = recentTracks(windows, CAP);
    } catch (error) {
      // a failed statement: every key of it is unknown, and its code goes to the trace
      const code = error instanceof DriverError ? error.code : "unknown";
      return envelope(
        refs.map((r) => [r.key, unknown({ reason: "failed" })]),
        0,
        [{ code, keys: refs.length }],
      );
    }
    return envelope(
      refs.map((r) => {
        const all = rows.get(`${r.key}@${r.pitchedAt}`) ?? [];
        // the statement read one more than the cap: when it is there, the window had more
        const cuts = all.length > CAP ? [{ kind: "cap", limit: CAP } as const] : [];
        return [
          r.key,
          all.length > 0
            ? found(all.slice(0, CAP), { cuts })
            : absent({ label: "30 days before", days: 30 }),
        ];
      }),
    );
  },
});

const about = g.relation("pitch", "artist", "about", {
  cardinality: "N:1",
  strategies: (s) => [
    s(pitches, {
      project: (_ref, p) => [{ to: p.artist, carries: { pitchedAt: p.pitchedAt } }],
    }),
  ],
});

const tracksBefore = g.provider("tracksBefore", {
  loader: recent,
  temporal: "historical",
  rows: "many",
  project: (rows) => rows.map((t) => ({ track: t.id, releasedAt: t.releasedAt, plays: t.plays })),
  raw: {
    track: { meta: { label: "Track" } },
    releasedAt: { meta: { label: "Released" } },
    plays: { meta: { label: "Plays" } },
  },
});

export const graph = g.graph(g.route("pitch", tracksBefore, g.path(about)));

// ---------------------------------------------------------------- a run

/** Every pitch, read by its key. A process makes its runner once, at startup; this one makes it
 *  here so that each test starts from an empty cache. */
export function example(): Promise<RunResult<readonly [typeof tracksBefore]>> {
  const runner = createRunner(graph, {
    cache: memoryCache(),
    // this deployment reads the replica only
    readable: (connector) => (connector === "replica" ? true : "not_configured"),
    limits: { replica: 4 },
    digest: (_entity, keyId) => createHash("sha256").update(keyId).digest("hex").slice(0, 12),
  });
  return runner.read("pitch", [...PITCHES.keys()], [tracksBefore]);
}

async function main(): Promise<void> {
  broken.add("a3");
  const result = await example();
  for (const [pitch, row] of result.rows) {
    const p = row.providers.tracksBefore;
    const tracks = p.rows.map((r) => `${r.fields.track} ${r.fields.releasedAt} ${r.fields.plays}`);
    const notes = [
      ...p.cut.map((c) => (c.kind === "cap" ? `first ${c.limit} only` : c.kind)),
      ...p.unknown.map((u) => `not read: ${u.reason}`),
      ...p.coverage.map((c) => `searched ${c.label}`),
    ];
    console.log(`${pitch}  ${p.outcome.padEnd(8)} ${[...tracks, ...notes].join(" · ")}`);
  }
  console.log("\nstatements");
  for (const s of statements) console.log(`  ${s}`);
  const trace = result.trace.find((t) => t.loader === "recentTracks");
  console.log(`\nrecentTracks failures: ${JSON.stringify(trace?.errors)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
