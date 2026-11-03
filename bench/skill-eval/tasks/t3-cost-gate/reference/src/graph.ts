// The track stats graph: titles from the catalog database, streams and skips from the warehouse.

import { absent, entity, envelope, found, hopgraph } from "hopgraph";
import { z } from "zod";
import { db } from "./sources/db.ts";
import { warehouse } from "./sources/warehouse.ts";

/** What every field says about itself, for the field picker. */
export type Meta = { readonly label: string };

// Finance's rule for every warehouse read: up to 1 GB runs, up to 50 GB waits for a person's
// approval, above that it is refused.
const FINANCE_RULE = { metered: { auto: 1_000_000_000, approve: 50_000_000_000 } } as const;

const g = hopgraph<Meta, "db" | "warehouse">().entities({
  track: entity({ key: z.string() }),
});

const tracks = g.loader({
  id: "tracks",
  keyedBy: "track",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },
  load: async (refs) => {
    const rows = await db.tracks(refs.map((r) => r.key));
    return envelope(
      refs.map((r) => {
        const row = rows.get(r.key);
        return [r.key, row ? found(row) : absent()];
      }),
    );
  },
});

const streams = g.loader({
  id: "streams",
  keyedBy: "track",
  connectors: { allOf: ["warehouse"] },
  // one query for every track: the warehouse scans what it is asked for, once
  batch: { by: "partition" },
  cost: FINANCE_RULE,
  price: (refs, _ctx, signal) => warehouse.dryRun("streams", refs.map((r) => r.key), { signal }),
  load: async (refs, _ctx, budget, signal) => {
    const { rows, billedBytes } = await warehouse.query(
      "streams",
      refs.map((r) => r.key),
      { maxBytes: budget.maxBytes, signal },
    );
    return envelope(
      refs.map((r) => {
        const row = rows.get(r.key);
        return [r.key, row ? found(row) : absent()];
      }),
      billedBytes,
    );
  },
});

const skips = g.loader({
  id: "skips",
  keyedBy: "track",
  connectors: { allOf: ["warehouse"] },
  // one query for every track: the warehouse scans what it is asked for, once
  batch: { by: "partition" },
  cost: FINANCE_RULE,
  price: (refs, _ctx, signal) => warehouse.dryRun("skips", refs.map((r) => r.key), { signal }),
  load: async (refs, _ctx, budget, signal) => {
    const { rows, billedBytes } = await warehouse.query(
      "skips",
      refs.map((r) => r.key),
      { maxBytes: budget.maxBytes, signal },
    );
    return envelope(
      refs.map((r) => {
        const row = rows.get(r.key);
        return [r.key, row ? found(row) : absent()];
      }),
      billedBytes,
    );
  },
});

export const trackInfo = g.provider("trackInfo", {
  loader: tracks,
  temporal: "current",
  rows: "one",
  project: (t) => [{ title: t.title }],
  raw: { title: { meta: { label: "Title" } } },
});

export const trackStreams = g.provider("trackStreams", {
  loader: streams,
  temporal: "historical",
  rows: "one",
  project: (s) => [{ streams: s.streams }],
  raw: { streams: { meta: { label: "Streams" } } },
});

export const trackSkips = g.provider("trackSkips", {
  loader: skips,
  temporal: "historical",
  rows: "one",
  project: (s) => [{ skipRate: s.skipRate }],
  raw: { skipRate: { meta: { label: "Skip rate" } } },
});

export const graph = g.graph(
  g.route("track", trackInfo),
  g.route("track", trackStreams),
  g.route("track", trackSkips),
);
