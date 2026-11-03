// The latency of a run whose sources answer at different paces: what a step behind fast reads
// waits for. Every loader waits a fixed time before it answers, so what is measured is when each
// provider's last read ends and when the run answers, not the executor's own cost (bench/run.ts).
// It uses the public API only, so the same file measures any version of the library. Run it on the
// build:
//
//   npm run bench:latency
//
// The graph is a music catalog's. From each track, three ways:
// - a fast chain three reads deep: its releases (10 ms), their albums (10 ms), the albums' royalty
//   rates (10 ms);
// - a slow source: the track's plays in a warehouse (300 ms);
// - a fast read, then a slow one: the track's performer (10 ms), the performer's label (120 ms).

import {
  type Answer,
  type Envelope,
  entity,
  envelope,
  hopgraph,
  type RunOptions,
  run,
  type Schema,
} from "hopgraph";
import { fixed, print } from "./table.ts";

const text: Schema<string> = {
  "~standard": { version: 1, vendor: "bench", validate: (value) => ({ value: value as string }) },
};

/** When each loader's last call ended, from the start of the run. */
const ended = new Map<string, number>();
let started = 0;

/** A loader that answers after `ms`, a value per key from `answer`. */
function after<V>(id: string, ms: number, answer: (key: string) => V) {
  return async (refs: readonly { readonly key: string }[]): Promise<Envelope<string, V>> => {
    await new Promise((resolve) => setTimeout(resolve, ms));
    ended.set(id, performance.now() - started);
    return envelope(
      refs.map((r): [string, Answer<V>] => [r.key, { kind: "found", value: answer(r.key) }]),
    );
  };
}

function catalog() {
  const g = hopgraph<{ readonly label: string }, string, Record<string, never>>().entities({
    track: entity({ key: text }),
    release: entity({ key: text }),
    album: entity({ key: text }),
    artist: entity({ key: text }),
  });
  const common = {
    version: 1,
    batch: { by: "keys", max: 500 },
    keep: () => "none" as const,
    partial: "keep",
  } as const;
  const on = (connector: string) => ({ ...common, connectors: { allOf: [connector] as const } });
  const releases = g.loader({
    ...on("db"),
    id: "releases",
    keyedBy: "track",
    load: after("releases", 10, (k) => ({ to: [`${k}-r1`, `${k}-r2`] })),
  });
  const albums = g.loader({
    ...on("db"),
    id: "albums",
    keyedBy: "release",
    load: after("albums", 10, (k) => ({ to: [`al${k.length}`] })),
  });
  const rates = g.loader({
    ...on("db"),
    id: "rates",
    keyedBy: "album",
    load: after("rates", 10, () => ({ cents: 990 })),
  });
  const plays = g.loader({
    ...on("warehouse"),
    id: "plays",
    keyedBy: "track",
    load: after("plays", 300, () => ({ n: 12 })),
  });
  const performers = g.loader({
    ...on("db"),
    id: "performers",
    keyedBy: "track",
    load: after("performers", 10, (k) => ({ to: [`a${k}`] })),
  });
  const labels = g.loader({
    ...on("api"),
    id: "labels",
    keyedBy: "artist",
    load: after("labels", 120, () => ({ name: "Hollowreed Records" })),
  });
  const to = (_ref: unknown, v: { readonly to: readonly string[] }) => v.to.map((t) => ({ to: t }));
  const has = g.relation("track", "release", "has", {
    cardinality: "1:N",
    strategies: (s) => [s(releases, { project: to })],
  });
  const of = g.relation("release", "album", "of", {
    cardinality: "N:1",
    strategies: (s) => [s(albums, { project: to })],
  });
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    strategies: (s) => [s(performers, { project: to })],
  });
  const m = (label: string) => ({ meta: { label } });
  return g.graph(
    g.route(
      "track",
      g.provider("rate", {
        loader: rates,
        temporal: "current",
        rows: "one",
        project: (v) => [v],
        raw: { cents: m("Rate") },
      }),
      g.path(has, of),
    ),
    g.route(
      "track",
      g.provider("plays", {
        loader: plays,
        temporal: "historical",
        rows: "one",
        project: (v) => [v],
        raw: { n: m("Plays") },
      }),
      g.itself("track"),
    ),
    g.route(
      "track",
      g.provider("label", {
        loader: labels,
        temporal: "current",
        rows: "one",
        project: (v) => [v],
        raw: { name: m("Label") },
      }),
      g.path(performer),
    ),
  );
}

const graph = catalog();
const options: RunOptions<Record<string, never>> = {
  refs: Array.from({ length: 20 }, (_, i) => ({ row: `r${i}`, entity: "track", key: `t${i}` })),
  providers: ["rate", "plays", "label"],
  ctx: {},
  restriction: "",
  readable: () => true,
  cache: { getMany: async () => new Map(), setMany: async () => undefined },
  limits: {},
  digest: (_entity, keyId) => keyId,
};

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

const REPEAT = 9;
const ready: Record<string, number[]> = { rate: [], label: [], plays: [], run: [] };
await run(graph, options);
for (let i = 0; i < REPEAT; i++) {
  ended.clear();
  started = performance.now();
  const result = await run(graph, options);
  ready.run?.push(performance.now() - started);
  if (result.status !== "complete") throw new Error("bench: the run did not complete");
  ready.rate?.push(ended.get("rates") ?? Number.NaN);
  ready.label?.push(ended.get("labels") ?? Number.NaN);
  ready.plays?.push(ended.get("plays") ?? Number.NaN);
}

print(
  `hopgraph latency · node ${process.version} · median of ${REPEAT} runs · 20 base rows`,
  [
    { title: "provider", align: "left" },
    { title: "its reads", align: "left" },
    { title: "read by (ms)", align: "right" },
  ],
  [
    ["rate", "releases, albums, rates: 10 ms each", "rate"],
    ["label", "performers 10 ms, then labels 120 ms", "label"],
    ["plays", "plays 300 ms", "plays"],
    ["(run)", "the run answers", "run"],
  ].map(([name, reads, key]) => [
    name ?? "",
    reads ?? "",
    fixed(median(ready[key ?? ""] ?? []), 0),
  ]),
);
