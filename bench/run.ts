// The executor's own cost: synthetic graphs over 10 to 100 000 base rows whose loaders answer at
// once, so what is measured is the executor (plan, waves, cache keys, batching, attribution) and
// nothing else. Per size it prints the run's time, its time per base row, the heap the result
// holds, and how many waves, calls and loaded keys the run took. Run it on the build:
//
//   npm run bench                      every size, every shape
//   npm run bench -- 1000 10000        some sizes only
//
// The graph is a music catalog's: a track row reaches its own summary, its performer's profile
// (four tracks per performer) and the city of the performer's home venue, found by a fallback of
// two strategies, the first of which knows half of the venues. Two caches: `cold` keeps nothing, so every key is loaded;
// `warm` holds every answer, so nothing is.

import {
  type Answer,
  type CachedAnswer,
  type CachePort,
  type Envelope,
  entity,
  envelope,
  hopgraph,
  type RunOptions,
  type RunResult,
  run,
  type Schema,
  type Span,
  type Tracer,
} from "hopgraph";
import { args, clearStatus, fixed, print, status } from "./table.ts";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "bench", validate: (value) => ({ value: value as string }) },
};

/** Every call of the run: the bench counts jobs and keys. */
const calls: number[] = [];

/** A loader that answers at once from a rule over the key. */
function instant<V>(answer: (key: string) => V | undefined) {
  return async (refs: readonly { readonly key: string }[]): Promise<Envelope<string, V>> => {
    calls.push(refs.length);
    return envelope(
      refs.map((r): [string, Answer<V>] => {
        const value = answer(r.key);
        return [r.key, value === undefined ? { kind: "absent" } : { kind: "found", value }];
      }),
    );
  };
}

const n = (key: string) => Number(key.slice(1));

function catalog() {
  const g = hopgraph<Record<string, never>, { readonly label: string }>().entities({
    track: entity({ key: text }),
    artist: entity({ key: text, personal: true }),
    venue: entity({ key: text }),
  });
  const common = {
    version: 1,
    connectors: { allOf: ["db"] },
    batch: { by: "keys", max: 500 },
    keep: () => "day" as const,
    partial: "keep",
  } as const;
  const tracks = g.loader({
    ...common,
    id: "tracks",
    keyedBy: "track",
    load: instant((k) => ({ artist: `a${Math.floor(n(k) / 4)}`, plays: n(k) % 97 })),
  });
  const artists = g.loader({
    ...common,
    id: "artists",
    keyedBy: "artist",
    load: instant((k) => ({ name: `name ${k}`, venue: `v${n(k)}` })),
  });
  const registry = g.loader({
    ...common,
    id: "registry",
    keyedBy: "artist",
    load: instant((k) => (n(k) % 2 === 0 ? { venue: `v${n(k)}` } : undefined)),
  });
  const venues = g.loader({
    ...common,
    id: "venues",
    keyedBy: "venue",
    load: instant((k) => ({ city: `city ${n(k) % 50}` })),
  });
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    strategies: (s) => [s(tracks, { project: (_ref, t) => [{ to: t.artist }] })],
  });
  const home = g.relation("artist", "venue", "home", {
    cardinality: "N:1",
    combine: "fallback",
    strategies: (s) => [
      s(registry, { project: (_ref, r) => [{ to: r.venue }] }),
      s(artists, { project: (_ref, a) => [{ to: a.venue }] }),
    ],
  });
  const m = (label: string) => ({ meta: { label } });
  const summary = g.provider("summary", {
    loader: tracks,
    temporal: "historical",
    rows: "one",
    project: (t) => [{ plays: t.plays }],
    raw: { plays: m("Plays") },
  });
  const profile = g.provider("profile", {
    loader: artists,
    temporal: "current",
    rows: "one",
    project: (a) => [{ name: a.name }],
    raw: { name: m("Name") },
  });
  const city = g.provider("city", {
    loader: venues,
    temporal: "current",
    rows: "one",
    project: (a) => [a],
    raw: { city: m("City") },
  });
  return g.graph(
    g.route("track", summary, g.itself("track")),
    g.route("track", profile, g.path(performer)),
    g.route("track", city, g.path(performer, home)),
  );
}

/** A cache that keeps nothing: every key is loaded. */
const cold: CachePort = { getMany: async () => new Map(), setMany: async () => undefined };

/** A cache that keeps everything, in memory. */
function memory(): CachePort {
  const store = new Map<string, CachedAnswer>();
  return {
    getMany: async (keys) => {
      const out = new Map<string, CachedAnswer>();
      for (const k of keys) {
        const hit = store.get(k);
        if (hit) out.set(k, hit);
      }
      return out;
    },
    setMany: async (entries) => {
      for (const e of entries) store.set(e.key, e.answer);
    },
  };
}

const graph = catalog();

function options(rows: number, cache: CachePort): RunOptions<Record<string, never>> {
  return {
    refs: Array.from({ length: rows }, (_, i) => ({ row: `r${i}`, entity: "track", key: `t${i}` })),
    providers: ["summary", "profile", "city"],
    ctx: {},
    restriction: "",
    readable: () => true,
    cache,
    limits: { db: 8 },
    digest: (entity, keyId) => `${entity}#${keyId.length}`,
  };
}

/** A tracer that keeps the latest wave a job started in, and nothing else. */
function wavesOf(): { readonly tracer: Tracer; readonly latest: () => number } {
  let latest = 0;
  const quiet: Span = {
    setAttribute: () => undefined,
    addEvent: () => undefined,
    recordError: () => undefined,
    end: () => undefined,
  };
  const tracer: Tracer = {
    startSpan: (name, attributes) => {
      if (name === "hopgraph.batch") latest = Math.max(latest, Number(attributes["hopgraph.wave"]));
      return quiet;
    },
  };
  return { tracer, latest: () => latest };
}

const gc = (globalThis as { gc?: () => void }).gc;
const heap = () => {
  gc?.();
  return process.memoryUsage().heapUsed;
};

interface Measure {
  readonly ms: number;
  readonly waves: number;
  readonly calls: number;
  readonly keys: number;
}

/** The median time of `repeat` runs, and what the last one took. */
async function measure(rows: number, cache: CachePort, repeat: number): Promise<Measure> {
  const times: number[] = [];
  let waves = 0;
  for (let i = 0; i < repeat; i++) {
    const opts = options(rows, cache);
    calls.length = 0;
    const traced = wavesOf();
    const started = performance.now();
    const result: RunResult = await run(graph, { ...opts, tracer: traced.tracer });
    times.push(performance.now() - started);
    waves = traced.latest();
    if (result.rows.size !== rows) throw new Error(`bench: ${result.rows.size} rows of ${rows}`);
  }
  times.sort((a, b) => a - b);
  return {
    ms: times[Math.floor(times.length / 2)] ?? 0,
    waves,
    calls: calls.length,
    keys: calls.reduce((a, b) => a + b, 0),
  };
}

/** The heap a run's result holds, in MB: its own function, so no earlier result is still held. */
async function held(rows: number, cache: CachePort): Promise<number | undefined> {
  if (!gc) return undefined;
  const opts = options(rows, cache);
  const before = heap();
  const result = await run(graph, opts);
  const after = heap();
  if (result.rows.size !== rows) throw new Error("bench: the result lost rows");
  return (after - before) / 2 ** 20;
}

const SIZES = [10, 100, 1_000, 10_000, 100_000];
const sizes = args.map(Number).filter((x) => x > 0);

const table: string[][] = [];
for (const rows of sizes.length > 0 ? sizes : SIZES) {
  const repeat = rows >= 100_000 ? 1 : rows >= 10_000 ? 5 : 15;
  status(`measuring ${rows.toLocaleString("en-US")} base rows…`);
  // a run before the measured ones: the JIT warms up and the warm cache fills
  const warm = memory();
  await run(graph, options(rows, warm));
  await run(graph, options(rows, cold));
  for (const [name, cache] of [
    ["cold", cold],
    ["warm", warm],
  ] as const) {
    const m = await measure(rows, cache, repeat);
    const mb = await held(rows, cache);
    table.push([
      name,
      rows.toLocaleString("en-US"),
      fixed(m.ms),
      fixed((m.ms * 1000) / rows),
      mb === undefined ? "–" : fixed(mb),
      String(m.waves),
      String(m.calls),
      m.keys.toLocaleString("en-US"),
    ]);
  }
}
clearStatus();
print(
  `hopgraph bench · node ${process.version} · instant loaders${gc ? "" : " · no --expose-gc, no heap figures"}`,
  [
    { title: "cache", align: "left" },
    { title: "base rows", align: "right" },
    { title: "ms (median)", align: "right" },
    { title: "µs per row", align: "right" },
    { title: "heap held (MB)", align: "right" },
    { title: "waves", align: "right" },
    { title: "calls", align: "right" },
    { title: "keys loaded", align: "right" },
  ],
  table,
);
