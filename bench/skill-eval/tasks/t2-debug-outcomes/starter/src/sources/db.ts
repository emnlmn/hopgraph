// The catalog database, faked in memory. Tests take it down with `db.down` and read `db.calls`.

export interface TrackRow {
  readonly id: string;
  readonly title: string;
  readonly artistId: string;
}

export interface ArtistRow {
  readonly name: string;
  readonly country: string;
}

const CURRENT: TrackRow[] = [
  { id: "t1", title: "Glass Harbour", artistId: "101" },
  { id: "t2", title: "Night Drive", artistId: "102" },
  { id: "t5", title: "Ferrous", artistId: "101" },
  { id: "t7", title: "Paper Moons", artistId: "109" }, // 109 was removed from the catalog in 2024
];

// Rows from the 2019 import of the old catalog, as the import job wrote them.
const IMPORTED_2019: unknown = [
  { id: "t3", title: "Low Tide", artistId: 103 },
  { id: "t4", title: "Saltwater", artistId: 102 },
  { id: "t8", title: "Undertow", artistId: 108 }, // 108 was removed from the catalog in 2024
];

const TRACKS = new Map<string, TrackRow>(
  [...CURRENT, ...(IMPORTED_2019 as TrackRow[])].map((t) => [t.id, t]),
);

const ARTISTS = new Map<string, ArtistRow>([
  ["101", { name: "Mira Volk", country: "IT" }],
  ["102", { name: "Ode Ferris", country: "FR" }],
  ["103", { name: "Kit Lune", country: "SE" }],
]);

async function select<V>(
  table: string,
  rows: ReadonlyMap<string, V>,
  ids: readonly string[],
): Promise<Map<string, V>> {
  db.calls.push({ table, ids: [...ids] });
  await new Promise((resolve) => setTimeout(resolve, 1));
  if (db.down) throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
  const out = new Map<string, V>();
  for (const id of ids) {
    const row = rows.get(id);
    if (row) out.set(id, row);
  }
  return out;
}

export const db = {
  /** when true, every query throws, as during an outage */
  down: false,
  /** every query, in order */
  calls: [] as { table: string; ids: string[] }[],
  tracks: (ids: readonly string[]) => select("tracks", TRACKS, ids),
  artists: (ids: readonly string[]) => select("artists", ARTISTS, ids),
};
