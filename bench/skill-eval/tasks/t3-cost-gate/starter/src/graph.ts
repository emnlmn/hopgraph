// The track stats graph: titles from the catalog database, streams and skips from the warehouse.

import { absent, entity, envelope, found, hopgraph } from "hopgraph";
import { z } from "zod";
import { db } from "./sources/db.ts";
import { warehouse } from "./sources/warehouse.ts";

/** What every field says about itself, for the field picker. */
export type Meta = { readonly label: string };

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
  batch: { by: "keys", max: 10 },
  load: async (refs) => {
    const { rows, billedBytes } = await warehouse.query(
      "streams",
      refs.map((r) => r.key),
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
  batch: { by: "keys", max: 10 },
  load: async (refs) => {
    const { rows, billedBytes } = await warehouse.query(
      "skips",
      refs.map((r) => r.key),
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
