// The catalog graph: what the app reads about tracks, and from where.

import { absent, entity, envelope, found, hopgraph } from "hopgraph";
import { z } from "zod";
import { db } from "./sources/db.ts";

/** What every field says about itself, for the field picker. */
export type Meta = { readonly label: string };

const g = hopgraph<Meta, "db">().entities({
  track: entity({ key: z.string() }),
  artist: entity({ key: z.string() }),
});

const tracks = g.loader({
  id: "tracks",
  keyedBy: "track",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },
  load: async (refs) => {
    try {
      const rows = await db.tracks(refs.map((r) => r.key));
      return envelope(
        refs.map((r) => {
          const row = rows.get(r.key);
          return [r.key, row ? found(row) : absent()];
        }),
      );
    } catch {
      // the database hiccups now and then: show the page anyway
      return envelope(refs.map((r) => [r.key, absent()]));
    }
  },
});

const artists = g.loader({
  id: "artists",
  keyedBy: "artist",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },
  load: async (refs) => {
    const rows = await db.artists(refs.map((r) => r.key));
    return envelope([...rows].map(([id, row]) => [id, found(row)]));
  },
});

const performer = g.relation("track", "artist", "performer", {
  cardinality: "N:1",
  strategies: (s) => [s(tracks, { project: (_ref, t) => [{ to: t.artistId }] })],
});

export const trackInfo = g.provider("trackInfo", {
  loader: tracks,
  temporal: "current",
  rows: "one",
  project: (t) => [{ title: t.title }],
  raw: { title: { meta: { label: "Title" } } },
});

export const artistProfile = g.provider("artistProfile", {
  loader: artists,
  temporal: "current",
  rows: "one",
  project: (a) => [{ name: a.name, country: a.country }],
  raw: { name: { meta: { label: "Artist" } }, country: { meta: { label: "Artist country" } } },
});

export const graph = g.graph(
  g.route("track", trackInfo),
  g.route("track", artistProfile, g.path(performer)),
);
