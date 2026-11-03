// Client of the analytics warehouse, faked in memory. The warehouse bills by bytes scanned: each
// query scans every track it is asked for, in each table it reads.
//
// - `dryRun(table, ids)` returns what a query would bill, without billing anything.
// - `query(table, ids, { maxBytes })` bills and returns the rows. Given `maxBytes`, the warehouse
//   refuses (throws `BytesLimitExceeded`, billing nothing) a query that would bill more.
//
// Tests read the counters: `billed`, `dryRuns`, `queries`.

export type Table = "streams" | "skips";

/** Bytes scanned per track, per table. 1 GB is 1,000,000,000 bytes. */
export const BYTES_PER_TRACK: Readonly<Record<Table, number>> = {
  streams: 100_000_000, // 100 MB
  skips: 10_000_000, // 10 MB
};

export interface StreamsRow {
  readonly streams: number;
}
export interface SkipsRow {
  readonly skipRate: number;
}
type RowOf = { streams: StreamsRow; skips: SkipsRow };

const pad = (n: number) => String(n).padStart(3, "0");
const STREAMS = new Map<string, StreamsRow>();
const SKIPS = new Map<string, SkipsRow>();
for (let i = 1; i <= 700; i++) {
  // tracks t007, t014, … were never streamed: the streams table has no row for them
  if (i % 7 !== 0) STREAMS.set(`t${pad(i)}`, { streams: i * 1000 });
  SKIPS.set(`t${pad(i)}`, { skipRate: (i % 10) / 10 });
}
const TABLES: { [T in Table]: ReadonlyMap<string, RowOf[T]> } = { streams: STREAMS, skips: SKIPS };

export class BytesLimitExceeded extends Error {
  override name = "BytesLimitExceeded";
  readonly code = "BYTES_LIMIT_EXCEEDED";
  /** a refused query bills nothing */
  readonly billedBytes = 0;
}

function bytesFor(table: Table, ids: readonly string[]): number {
  return new Set(ids).size * BYTES_PER_TRACK[table];
}

export const warehouse = {
  /** total bytes billed */
  billed: 0,
  /** every dry run */
  dryRuns: [] as { table: Table; tracks: number; bytes: number }[],
  /** every query, with the byte limit it was given */
  queries: [] as { table: Table; tracks: number; maxBytes: number | undefined; billed: number }[],

  async dryRun(table: Table, ids: readonly string[], opts: { signal?: AbortSignal } = {}): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 2));
    opts.signal?.throwIfAborted();
    const bytes = bytesFor(table, ids);
    warehouse.dryRuns.push({ table, tracks: ids.length, bytes });
    return bytes;
  },

  async query<T extends Table>(
    table: T,
    ids: readonly string[],
    opts: { maxBytes?: number; signal?: AbortSignal } = {},
  ): Promise<{ rows: Map<string, RowOf[T]>; billedBytes: number }> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    opts.signal?.throwIfAborted();
    const bytes = bytesFor(table, ids);
    if (opts.maxBytes !== undefined && bytes > opts.maxBytes) {
      warehouse.queries.push({ table, tracks: ids.length, maxBytes: opts.maxBytes, billed: 0 });
      throw new BytesLimitExceeded(`query would bill ${bytes} bytes, limit ${opts.maxBytes}`);
    }
    warehouse.billed += bytes;
    warehouse.queries.push({ table, tracks: ids.length, maxBytes: opts.maxBytes, billed: bytes });
    const rows = new Map<string, RowOf[T]>();
    const data = TABLES[table] as ReadonlyMap<string, RowOf[T]>;
    for (const id of ids) {
      const row = data.get(id);
      if (row) rows.set(id, row);
    }
    return { rows, billedBytes: bytes };
  },
};
