// The track page graph: titles from the catalog database, stream counts from analytics.

import { absent, entity, envelope, found, hopgraph } from "hopgraph";
import { z } from "zod";
import { analyticsApi } from "./sources/analytics.ts";
import { db } from "./sources/db.ts";

/** What every field says about itself, for the field picker. */
export type Meta = { readonly label: string };

const g = hopgraph<Meta, "db" | "analytics">().entities({
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
  connectors: { allOf: ["analytics"] },
  batch: { by: "keys", max: 100 },
  load: async (refs) => {
    const rows = await analyticsApi.get(refs.map((r) => r.key));
    return envelope([...rows].map(([id, row]) => [id, found(row)]));
  },
});

export const trackSummary = g.provider("trackSummary", {
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

export const graph = g.graph(
  g.route("track", trackSummary),
  g.route("track", trackStreams),
);
