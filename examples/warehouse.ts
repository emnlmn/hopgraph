// A royalty warehouse that bills by bytes scanned, read behind a cost gate. The question: for a
// list of artists, their profile (a free table) and their last 90 days of plays (a warehouse table
// partitioned by artist, 4 GB an artist).
//
// What it shows, as three requests to one runner and one to another (an instance whose cache is
// empty):
// 1. The first run prices the warehouse read with a dry run (`price`) before it loads anything. The
//    price is above the loader's `auto` cap and under its `approve` cap, so the run stops at a gate:
//    the plays are `unknown: awaiting_approval`, the profiles are read all the same, and the
//    result is `gated`, with the gate's id, its keys and its bytes for a person to approve.
// 2. The same run again with `approved: { [gate id]: bytes }` (and the prices the first run
//    measured): the profiles come from the cache, the warehouse is read once with the approval as
//    its budget (`budget.maxBytes`, handed to the warehouse as its byte limit), and the result is
//    complete, its bill in `billedBytes`.
// 3. The warehouse grew since the approval: a resume with the old approval, on another instance, is
//    priced again, the price is above what was approved, and the run rejects with
//    `CostChangedError`, billing nothing. Nothing is billed past an approval.
//
//   npm run build && node examples/warehouse.ts

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  absent,
  type CachedAnswer,
  type CachePort,
  CostChangedError,
  createRunner,
  entity,
  envelope,
  found,
  hopgraph,
  type ReadCall,
  type RunResult,
  type Schema,
} from "hopgraph";

// ---------------------------------------------------------------- the sources

const PROFILES = new Map([
  ["a1", { name: "Mira Volk", label: "Hollowreed Records" }],
  ["a2", { name: "Ode Ferris", label: "Saltmarsh Sound" }],
  ["a3", { name: "Kit Lune", label: "Saltmarsh Sound" }],
]);
const PLAYS = new Map([
  ["a1", { plays: 41, saves: 6 }],
  ["a2", { plays: 30, saves: 0 }],
]);

/** What an artist's partition costs to scan: what the warehouse would bill. */
export const warehouse = { bytesPerArtist: 4e9, scans: [] as { keys: number; billed: number }[] };

/** The warehouse refuses a query that would bill more than the limit it is given. */
class BytesLimitExceeded extends Error {
  override name = "BytesLimitExceeded";
  readonly billedBytes = 0;
}

function dryRun(artists: readonly string[]): number {
  return artists.length * warehouse.bytesPerArtist;
}

function scan(artists: readonly string[], maxBytes: number | undefined) {
  const bytes = dryRun(artists);
  if (maxBytes !== undefined && bytes > maxBytes) throw new BytesLimitExceeded();
  warehouse.scans.push({ keys: artists.length, billed: bytes });
  return { bytes, rows: artists.map((a) => [a, PLAYS.get(a)] as const) };
}

// ---------------------------------------------------------------- the graph

const text: Schema<string> = {
  "~standard": {
    version: 1,
    vendor: "example",
    validate: (v) => (typeof v === "string" ? { value: v } : { issues: [{ message: "a string" }] }),
  },
};

const g = hopgraph<undefined, { readonly label: string }, "db" | "warehouse">().entities({
  artist: entity({ key: text }),
});

const profiles = g.loader({
  id: "profiles",
  keyedBy: "artist",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },
  load: async (refs) =>
    envelope(
      refs.map((r) => {
        const p = PROFILES.get(r.key);
        return [r.key, p ? found(p) : absent()];
      }),
    ),
});

const plays = g.loader({
  id: "plays",
  keyedBy: "artist",
  connectors: { allOf: ["warehouse"] },
  // one job over every key: the warehouse bills the partitions it scans, so they are scanned once
  batch: { by: "partition" },
  // under 5 GB it runs; up to 50 GB a person approves; above, it is too heavy
  cost: { metered: { auto: 5e9, approve: 50e9 } },
  price: async (refs) => dryRun(refs.map((r) => r.key)),
  load: async (refs, _ctx, budget) => {
    const { bytes, rows } = scan(
      refs.map((r) => r.key),
      budget.maxBytes,
    );
    const window = { label: "last 90 days", days: 90 };
    return envelope(
      rows.map(([key, row]) => [key, row ? found(row, { coverage: window }) : absent(window)]),
      bytes,
    );
  },
});

const profile = g.provider("profile", {
  loader: profiles,
  temporal: "current",
  rows: "one",
  project: (p) => [p],
  raw: { name: { meta: { label: "Name" } }, label: { meta: { label: "Label" } } },
});

const recentPlays = g.provider("recentPlays", {
  loader: plays,
  temporal: "historical",
  rows: "one",
  project: (p) => [p],
  raw: { plays: { meta: { label: "Plays" } }, saves: { meta: { label: "Saves" } } },
  derived: (d) => ({
    casual: d(["plays", "saves"], (p) => p.plays > 10 && p.saves === 0, {
      meta: { label: "Plays without saves" },
    }),
  }),
});

export const graph = g.graph(
  g.route("artist", profile, g.itself("artist")),
  g.route("artist", recentPlays, g.itself("artist")),
);

// ---------------------------------------------------------------- the runs

/** The smallest cache port: a map. A real one maps each retention to a time to live. */
export class MemoryCache implements CachePort {
  private readonly store = new Map<string, CachedAnswer>();
  async getMany(keys: readonly string[]) {
    return new Map(keys.flatMap((k) => (this.store.has(k) ? [[k, this.store.get(k)!]] : [])));
  }
  async setMany(entries: Parameters<CachePort["setMany"]>[0]) {
    for (const e of entries) this.store.set(e.key, e.answer);
  }
}

type Asked = readonly [typeof profile, typeof recentPlays];

/** An instance of the application: its runner, made once at startup, over its own cache. */
export function instance(cache: CachePort = new MemoryCache()) {
  return createRunner(graph, {
    cache,
    limits: { db: 4, warehouse: 1 },
    digest: (_entity, keyId) => createHash("sha256").update(keyId).digest("hex").slice(0, 12),
  });
}

/** One request for the artists' profile and plays, with what holds for this call: an approval,
 *  and the prices the run before it measured. */
export function request(
  app: ReturnType<typeof instance>,
  call: ReadCall<undefined> = {},
): Promise<RunResult<Asked>> {
  return app.read("artist", ["a1", "a2", "a3"], [profile, recentPlays], call);
}

function show(result: RunResult<Asked>): void {
  console.log(`status ${result.status}, billed ${result.billedBytes / 1e9} GB`);
  for (const [artist, row] of result.rows) {
    const { profile: p, recentPlays: r } = row.providers;
    const name = p.rows[0]?.fields.name ?? p.outcome;
    const played = r.rows[0]?.fields;
    const why = r.unknown.map((u) => u.reason).join(", ");
    const what = played ? `${played.plays} plays, casual ${played.casual}` : `${r.outcome} ${why}`;
    console.log(`  ${artist}  ${name.padEnd(12)} ${what}`);
  }
}

async function main(): Promise<void> {
  const app = instance();

  console.log("1. first run");
  const first = await request(app);
  show(first);
  for (const gate of first.gates)
    console.log(
      `  gate ${gate.id}: ${gate.keys} keys, ${gate.bytes / 1e9} GB, asked by ${gate.step}`,
    );

  // a person approves what the gate showed
  const approved = Object.fromEntries(first.gates.map((gate) => [gate.id, gate.bytes]));

  console.log("\n2. approved");
  show(await request(app, { approved, prices: first.prices }));

  console.log("\n3. the warehouse grew: the same approval, on an instance whose cache is empty");
  warehouse.bytesPerArtist = 5e9;
  try {
    await request(instance(), { approved });
  } catch (error) {
    if (!(error instanceof CostChangedError)) throw error;
    console.log(`  refused: approved ${error.approved / 1e9} GB, priced ${error.priced / 1e9} GB`);
  }
  console.log(`\nwarehouse scans: ${JSON.stringify(warehouse.scans)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
