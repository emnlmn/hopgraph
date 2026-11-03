// The catalog database, faked in memory. Tests switch it off with `db.fail` and read `db.calls`.

export interface TrackRow {
  readonly title: string;
  readonly artistId: string;
}

export interface ArtistRow {
  readonly name: string;
  readonly country: string;
  /** the label the artist is signed to, when they are signed */
  readonly labelId?: string;
}

const TRACKS = new Map<string, TrackRow>([
  ["t1", { title: "Glass Harbour", artistId: "a1" }],
  ["t2", { title: "Night Drive", artistId: "a2" }],
  ["t3", { title: "Low Tide", artistId: "a3" }],
  ["t4", { title: "Paper Moons", artistId: "a4" }],
  ["t5", { title: "Ferrous", artistId: "a1" }],
  ["t6", { title: "Static Bloom", artistId: "a5" }],
]);

const ARTISTS = new Map<string, ArtistRow>([
  ["a1", { name: "Mira Volk", country: "IT", labelId: "l1" }],
  ["a2", { name: "Ode Ferris", country: "FR", labelId: "l2" }],
  ["a3", { name: "Kit Lune", country: "SE" }], // unsigned
  ["a4", { name: "June Okafor", country: "NG", labelId: "l9" }], // a label the labels service has dropped
  ["a5", { name: "Harbor Lights", country: "US", labelId: "l1" }],
]);

// A larger slice of the catalog: tracks c1…c30, one artist each, signed to labels l1…l5.
for (let i = 1; i <= 30; i++) {
  TRACKS.set(`c${i}`, { title: `Catalog track ${i}`, artistId: `ca${i}` });
  ARTISTS.set(`ca${i}`, { name: `Catalog artist ${i}`, country: "GB", labelId: `l${(i % 5) + 1}` });
}

async function select<V>(
  table: string,
  rows: ReadonlyMap<string, V>,
  ids: readonly string[],
): Promise<Map<string, V>> {
  db.calls.push({ table, ids: [...ids] });
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (db.fail) throw Object.assign(new Error("database unavailable"), { code: "ECONNREFUSED" });
  const out = new Map<string, V>();
  for (const id of ids) {
    const row = rows.get(id);
    if (row) out.set(id, row);
  }
  return out;
}

export const db = {
  /** when true, every query throws */
  fail: false,
  /** every query, in order */
  calls: [] as { table: string; ids: string[] }[],
  tracks: (ids: readonly string[]) => select("tracks", TRACKS, ids),
  artists: (ids: readonly string[]) => select("artists", ARTISTS, ids),
};
