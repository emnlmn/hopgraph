// The catalog graph: what the app reads about tracks, and from where.

import { absent, entity, envelope, found, hopgraph } from "hopgraph";
import { z } from "zod";
import { db } from "./sources/db.ts";
import { labelsApi } from "./sources/labels.ts";

/** What every field says about itself, for the field picker. */
export type Meta = { readonly label: string };

const g = hopgraph<Meta, "db" | "labels">().entities({
  track: entity({ key: z.string() }),
  artist: entity({ key: z.string() }),
  label: entity({ key: z.string() }),
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

const artists = g.loader({
  id: "artists",
  keyedBy: "artist",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },
  load: async (refs) => {
    const rows = await db.artists(refs.map((r) => r.key));
    return envelope(
      refs.map((r) => {
        const row = rows.get(r.key);
        return [r.key, row ? found(row) : absent()];
      }),
    );
  },
});

// The labels service: one batch call per wave. A label id it does not return is absent; a call
// that throws fails its keys (unknown: failed), which the run reports and never caches.
const labels = g.loader({
  id: "labels",
  keyedBy: "label",
  connectors: { allOf: ["labels"] },
  batch: { by: "keys", max: 500 },
  load: async (refs, _ctx, _budget, signal) => {
    const rows = await labelsApi.getMany(
      refs.map((r) => r.key),
      { signal },
    );
    return envelope(
      refs.map((r) => {
        const row = rows.get(r.key);
        return [r.key, row ? found(row) : absent()];
      }),
    );
  },
});

const performer = g.relation("track", "artist", "performer", {
  cardinality: "N:1",
  strategies: (s) => [s(tracks, { project: (_ref, t) => [{ to: t.artistId }] })],
});

// An unsigned artist has no label: no link, so the label is absent, not unknown.
const signedTo = g.relation("artist", "label", "signedTo", {
  cardinality: "N:1",
  strategies: (s) => [s(artists, { project: (_ref, a) => (a.labelId ? [{ to: a.labelId }] : []) })],
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

export const labelInfo = g.provider("labelInfo", {
  loader: labels,
  temporal: "current",
  rows: "one",
  project: (l) => [{ name: l.name, country: l.country }],
  raw: { name: { meta: { label: "Label" } }, country: { meta: { label: "Label country" } } },
});

export const graph = g.graph(
  g.route("track", trackInfo),
  g.route("track", artistProfile, g.path(performer)),
  g.route("track", labelInfo, g.path(performer, signedTo)),
);
