// The builder's contract on a small graph of tracks, artists and email addresses. Each
// `@ts-expect-error` is a promise of DESIGN.md §7: if the compiler stopped refusing that line,
// `tsc` would fail on the unused directive.

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { checkGraph, type Entity, type Envelope, entity, hopgraph, type Route } from "../index.ts";

type Ctx = { today: string; viewer: string };
type Meta = { label: string };
const m = (label: string): { meta: Meta } => ({ meta: { label } });

function found<K, V>(pairs: ReadonlyArray<readonly [K, V]>): Envelope<K, V> {
  return { values: pairs, absent: [], unknown: [], cut: [], billedBytes: 0, errors: [] };
}

const track = entity({
  key: z.object({ catalog: z.string(), id: z.number() }),
  id: (k) => `${k.catalog}:${k.id}`,
  carries: { email: z.string(), releasedAt: z.string() },
});
const artist = entity({ key: z.string(), carries: { country: z.string() } });
const email = entity({ key: z.string(), personal: true });

function build() {
  const g = hopgraph<Meta, "db" | "warehouse", Ctx>().entities({ track, artist, email });

  const trackHeader = g.loader({
    id: "trackHeader",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    batch: { by: "keys", max: 500 },
    keep: (o) => (o.found ? "day" : "brief"),
    partial: "keep",
    load: async (refs) =>
      found(
        refs.map((r) => [
          r.key,
          {
            email: "a@b.c",
            releasedAt: "2026-01-01",
            streams: [{ market: "x", streams: 1, user: 12000 }],
          },
        ]),
      ),
  });
  g.hydrator("track", trackHeader, (v) => ({ email: v.email, releasedAt: v.releasedAt }));

  // an explicitly typed `refs` parameter must not widen the needs: needs come from `needs` only
  const typedRefs = g.loader({
    id: "typedRefs",
    version: 1,
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    batch: { by: "keys", max: 10 },
    keep: () => "day",
    partial: "keep",
    load: async (refs: readonly { readonly key: string }[]) =>
      found(refs.map((r) => [r.key, { country: "IT" }])),
  });
  g.hydrator("artist", typedRefs, (v) => ({ country: v.country }));

  const tracksOfArtist = g.loader({
    id: "tracksOfArtist",
    version: 1,
    keyedBy: "artist",
    ctx: ["today"],
    connectors: { allOf: ["db"] },
    batch: { by: "keys", max: 100 },
    keep: () => "day",
    partial: "drop",
    load: async (refs, ctx) => {
      expectTypeOf(ctx).toEqualTypeOf<Pick<Ctx, "today">>();
      return found(refs.map((r) => [r.key, [{ catalog: "it", id: 1, releasedAt: ctx.today }]]));
    },
  });

  const warehouse = g.loader({
    id: "warehouse",
    version: 2,
    keyedBy: "track",
    needs: ["releasedAt"],
    connectors: { allOf: ["warehouse"] },
    batch: { by: "partition" },
    cost: { metered: { auto: 2e9, approve: 6e10 } },
    price: async (refs) => refs.length * 1e6,
    keep: (o) => (o.found ? "day" : "brief"),
    partial: "keep",
    load: async (refs, _ctx, budget) => {
      expectTypeOf(refs[0]!.releasedAt).toEqualTypeOf<string>();
      expectTypeOf(budget.maxBytes).toEqualTypeOf<number | undefined>();
      return found(refs.map((r) => [r.key, { contact: "a@b.c" }]));
    },
  });

  const artistOfEmail = g.loader({
    id: "artistOfEmail",
    version: 1,
    keyedBy: "email",
    connectors: { oneOf: ["db", "warehouse"] },
    batch: { by: "one", concurrency: 4 },
    keep: () => "day",
    partial: "keep",
    load: async (refs) => found(refs.map((r) => [r.key, { id: "a1", country: "IT" }])),
  });

  const recent = g.relation("artist", "track", "recent", {
    cardinality: "1:N",
    link: z.object({ rank: z.number() }),
    strategies: (s) => [
      s(tracksOfArtist, {
        coverage: { label: "6 months", days: 183 },
        project: (_ref, rows) =>
          rows.map((r, rank) => ({
            to: { catalog: r.catalog, id: r.id },
            attrs: { rank },
            carries: { releasedAt: r.releasedAt },
          })),
      }),
    ],
  });

  // a verification sees every candidate of a ref: drop the unconfirmed when another is confirmed
  g.relation("artist", "track", "confirmed", {
    cardinality: "1:N",
    strategies: (s) => [
      s(tracksOfArtist, {
        project: (_ref, rows) => rows.map((r) => ({ to: { catalog: r.catalog, id: r.id } })),
      }),
    ],
    verify: (v) =>
      v(warehouse, (candidates) => {
        expectTypeOf(candidates[0]!.value).toEqualTypeOf<{ contact: string } | undefined>();
        const anyFound = candidates.some((c) => c.state === "found");
        return candidates.map((c) =>
          c.state === "found"
            ? "keep"
            : c.state === "unknown"
              ? "undecided"
              : anyFound
                ? "drop"
                : "keep",
        );
      }),
  });

  const contact = g.relation("track", "email", "contact", {
    cardinality: "N:1",
    combine: "fallback",
    strategies: (s) => [
      s(trackHeader, { needs: ["email"], project: (ref) => [{ to: ref.email }] }),
      s(warehouse, { project: (_ref, v) => [{ to: v.contact }] }),
    ],
  });

  // a hint: read when the ref has it, never required
  g.relation("track", "email", "hinted", {
    cardinality: "N:1",
    strategies: (s) => [
      s(trackHeader, {
        hints: ["email"],
        project: (ref) => {
          expectTypeOf(ref.email).toEqualTypeOf<string | undefined>();
          return ref.email ? [{ to: ref.email }] : [];
        },
      }),
    ],
  });

  const registered = g.relation("email", "artist", "registered", {
    cardinality: "N:1",
    strategies: (s) => [
      s(artistOfEmail, { project: (_ref, v) => [{ to: v.id, carries: { country: v.country } }] }),
    ],
  });

  const streams = g.provider("trackStreams", {
    loader: trackHeader,
    temporal: "historical",
    rows: "many",
    project: (v) => v.streams,
    raw: { market: m("Market"), streams: m("Streams"), user: m("User") },
    derived: (d) => ({
      channel: d(["user"], ({ user }) => (user >= 10_000 ? "radio" : "web"), m("Channel")),
    }),
  });

  return { g, recent, contact, registered, streams, trackHeader, warehouse, tracksOfArtist };
}

describe("hopgraph builder: types", () => {
  it("types relation ids, refs, links and paths from the declaration", () => {
    const { g, recent, contact, registered, streams } = build();
    expectTypeOf(recent.id).toEqualTypeOf<"artist › track:recent">();
    const p = g.path(recent, contact, registered);
    expectTypeOf(p.from).toEqualTypeOf<"artist">();
    expectTypeOf(p.to).toEqualTypeOf<"artist">();
    g.route("track", streams, g.itself("track"));
    g.route("artist", streams, g.path(recent));
    g.route("email", streams, g.path(registered, recent));
    const both = g.union(g.itself("artist"), g.path(recent, contact, registered));
    expectTypeOf(both.from).toEqualTypeOf<"artist">();
    expect(both.paths.map((p) => p.relations)).toEqual([
      [],
      [recent.id, contact.id, registered.id],
    ]);
  });

  it("types a route by its base and provider, and a graph by the routes it is given", () => {
    const { g, recent, streams } = build();
    const fromTrack = g.route("track", streams, g.itself("track"));
    const fromArtist = g.route("artist", streams, g.path(recent));
    const graph = g.graph(fromTrack, fromArtist);

    expectTypeOf(fromTrack).toEqualTypeOf<Route<"track", typeof streams>>();
    expectTypeOf(g.route("track", streams)).toEqualTypeOf<typeof fromTrack>();
    type RoutesOf<G extends { readonly _types?: { readonly routes: (r: never) => unknown } }> =
      ReturnType<NonNullable<G["_types"]>["routes"]>;
    expectTypeOf<RoutesOf<typeof graph>>().toEqualTypeOf<typeof fromTrack | typeof fromArtist>();
    // a graph of one route is not a graph of two: it would claim a pair it cannot read
    const one = g.graph(fromTrack);
    // @ts-expect-error: the routes are invariant
    const _wider: typeof graph = one;
  });

  it("takes a provider's rows declared as an interface, and types its fields from it", () => {
    const { g, trackHeader } = build();
    const plays = g.provider("plays", {
      loader: trackHeader,
      temporal: "historical",
      rows: "many",
      project: (v): Play[] => v.streams,
      raw: { market: m("Market"), streams: m("Streams") },
      derived: (d) => ({ hit: d(["streams"], ({ streams }) => streams >= 10, m("Hit")) }),
    });
    g.graph(g.route("track", plays, g.itself("track")));

    expectTypeOf(plays._row).toEqualTypeOf<Play | undefined>();
    expect(g.catalog().flatMap((c) => (c.provider === "plays" ? [c.field] : []))).toEqual([
      "market",
      "streams",
      "hit",
    ]);
  });

  it("refuses what DESIGN.md §7 promises to refuse (checked by tsc, never run)", () => {
    expectTypeOf(refusals).toBeFunction();
  });
});

/** A provider's row type written as an interface, as a consumer's often is: an interface has no
 *  implicit index signature, which a row type must not need. */
interface Play {
  readonly market: string;
  readonly streams: number;
}

/** Compiled, never called: the builder also throws on most of these at run time. */
function refusals() {
  const { g, recent, contact, registered, streams, trackHeader, warehouse, tracksOfArtist } =
    build();

  // @ts-expect-error: no entity "statement"
  g.relation("track", "statement", "x", {
    cardinality: "1:1",
    strategies: (s) => [s(trackHeader, { project: () => [] })],
  });

  g.relation("artist", "track", "wrongLoader", {
    cardinality: "1:N",
    // @ts-expect-error: a strategy's loader must be keyed by the relation's `from`
    strategies: (s) => [s(trackHeader, { project: () => [] })],
  });

  g.relation("track", "artist", "wrongKey", {
    cardinality: "N:1",
    // @ts-expect-error: the target's key is a string, not a number
    strategies: (s) => [s(trackHeader, { project: () => [{ to: 42 }] })],
  });

  g.relation("track", "email", "undeclaredNeed", {
    cardinality: "N:1",
    strategies: (s) => [
      // @ts-expect-error: "phone" is not a carried attribute of track
      s(trackHeader, { needs: ["phone"], project: () => [] }),
    ],
  });

  g.relation("track", "email", "unrequestedNeed", {
    cardinality: "N:1",
    strategies: (s) => [
      s(trackHeader, {
        needs: ["releasedAt"],
        // @ts-expect-error: `email` was not declared as a need, so the ref does not expose it
        project: (ref) => [{ to: ref.email }],
      }),
    ],
  });

  g.relation("artist", "track", "missingAttrs", {
    cardinality: "1:N",
    link: z.object({ rank: z.number() }),
    // @ts-expect-error: the relation's link attributes are required
    strategies: (s) => [s(tracksOfArtist, { project: () => [{ to: { catalog: "it", id: 1 } }] })],
  });

  g.loader({
    id: "noneOfThem",
    keyedBy: "track",
    // @ts-expect-error: one connector at least: `allOf: []` would escape readable, limits and health
    connectors: { allOf: [] },
    batch: { by: "keys", max: 1 },
    load: async () => found<{ catalog: string; id: number }, number>([]),
  });
  g.loader({
    id: "oneOfNone",
    keyedBy: "track",
    // @ts-expect-error: one connector at least: `oneOf: []` would never be readable
    connectors: { oneOf: [] },
    batch: { by: "keys", max: 1 },
    load: async () => found<{ catalog: string; id: number }, number>([]),
  });

  // @ts-expect-error: a loader names its connectors: with none, no readable, limit or breaker holds it
  g.loader({
    id: "noConnectors",
    keyedBy: "track",
    batch: { by: "keys", max: 1 },
    load: async () => found<{ catalog: string; id: number }, number>([]),
  });

  // @ts-expect-error: a metered loader needs `price`
  g.loader({
    id: "noPrice",
    version: 1,
    keyedBy: "track",
    connectors: { allOf: ["warehouse"] },
    batch: { by: "partition" },
    cost: { metered: { auto: 1, approve: 2 } },
    keep: () => "none",
    partial: "keep",
    load: async () => found<{ catalog: string; id: number }, number>([]),
  });

  g.loader({
    id: "unknownConnector",
    version: 1,
    keyedBy: "track",
    // @ts-expect-error: not a connector of this graph
    connectors: { allOf: ["mongo"] },
    batch: { by: "keys", max: 1 },
    keep: () => "none",
    partial: "keep",
    load: async () => found<{ catalog: string; id: number }, number>([]),
  });

  g.loader({
    id: "oldSpelling",
    version: 1,
    keyedBy: "track",
    // @ts-expect-error: connectors are `allOf` or `oneOf`; `all` and `any` are gone
    connectors: { any: ["db", "warehouse"] },
    batch: { by: "keys", max: 1 },
    keep: () => "none",
    partial: "keep",
    load: async () => found<{ catalog: string; id: number }, number>([]),
  });

  g.provider("missingMeta", {
    loader: trackHeader,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ email: v.email, releasedAt: v.releasedAt }],
    // @ts-expect-error: every projected value is a field with its meaning: releasedAt has none
    raw: { email: m("Email") },
  });

  type Contact = { kind: "call"; minutes: number } | { kind: "mail"; subject: string };
  g.provider("contacts", {
    loader: trackHeader,
    temporal: "historical",
    rows: "many",
    project: (): Contact[] => [],
    // @ts-expect-error: rows of one shape: `minutes` could never be kept, though typed
    raw: { kind: m("Kind") },
  });

  g.provider("parsed", {
    loader: trackHeader,
    temporal: "historical",
    rows: "one",
    project: (v) => [JSON.parse(v.email)],
    // @ts-expect-error: the rows are any: no field would be kept, every one typed
    raw: {},
  });

  const indexed = g.provider("indexed", {
    loader: trackHeader,
    temporal: "historical",
    rows: "one",
    project: (): Record<string, number>[] => [],
    raw: {},
  });
  // @ts-expect-error: rows with an index signature name no field: the provider cannot be routed
  g.route("track", indexed, g.itself("track"));

  // a pattern of keys names no field either: `x_anything` would be typed and never kept
  interface Tagged {
    readonly market: string;
    readonly [tag: `x_${string}`]: number;
  }
  const tagged = g.provider("tagged", {
    loader: trackHeader,
    temporal: "historical",
    rows: "one",
    project: (): Tagged[] => [],
    raw: { market: m("Market") },
  });
  // @ts-expect-error: rows with a pattern of keys
  g.route("track", tagged, g.itself("track"));
  const prefixed = g.provider("prefixed", {
    loader: trackHeader,
    temporal: "historical",
    rows: "one",
    project: (): { readonly [K in `y_${string}`]: number }[] => [],
    raw: {},
  });
  // @ts-expect-error: rows mapped over a pattern of keys
  g.route("track", prefixed, g.itself("track"));

  // an entity with context attributes is not an Entity<K, C>, which has none: `read` would take
  // bare keys of it, where a base row must bring them
  // @ts-expect-error: say them, Entity<string, { releasedAt: string }, "releasedAt">
  const _hidden: Entity<string, { releasedAt: string }> = entity({
    key: z.string(),
    carries: { releasedAt: z.string() },
    context: ["releasedAt"],
  });

  // the refusals hold for rows declared as interfaces too
  interface Single {
    readonly kind: "single";
    readonly minutes: number;
  }
  interface Album {
    readonly kind: "album";
    readonly tracks: number;
  }
  g.provider("interfaceUnion", {
    loader: trackHeader,
    temporal: "historical",
    rows: "many",
    project: (): (Single | Album)[] => [],
    // @ts-expect-error: rows of one shape, interfaces or not
    raw: { kind: m("Kind") },
  });

  interface Scores {
    readonly [name: string]: number;
  }
  const scores = g.provider("scores", {
    loader: trackHeader,
    temporal: "historical",
    rows: "one",
    project: (): Scores[] => [],
    raw: {},
  });
  // @ts-expect-error: an interface with an index signature names no field either
  g.route("track", scores, g.itself("track"));

  g.provider("interfaceMissingMeta", {
    loader: trackHeader,
    temporal: "historical",
    rows: "many",
    project: (v): Play[] => v.streams,
    // @ts-expect-error: every field of an interface says what it means: streams does not
    raw: { market: m("Market") },
  });

  g.provider("badDerivedInput", {
    loader: trackHeader,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ email: v.email }],
    raw: { email: m("Email") },
    // @ts-expect-error: a derived field reads raw fields of its own provider only
    derived: (d) => ({ domain: d(["phone"], () => "x", m("Domain")) }),
  });

  g.provider("derivedShadowsRaw", {
    loader: trackHeader,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ email: v.email }],
    raw: { email: m("Email") },
    // @ts-expect-error: a derived field cannot take the name of a raw field
    derived: (d) => ({ email: d(["email"], ({ email }) => email.toLowerCase(), m("Email")) }),
  });

  // @ts-expect-error: the path does not chain (contact ends at email, recent starts at artist)
  g.route("track", streams, g.path(contact, recent));

  // @ts-expect-error: the path starts at artist, the route's base is email
  g.route("email", streams, g.path(recent));

  // @ts-expect-error: streams is keyed by track, not artist: itself does not apply
  g.route("artist", streams, g.itself("artist"));

  // @ts-expect-error: one spelling for a provider keyed by the base: itself(base), not "itself"
  g.route("track", streams, "itself");

  // @ts-expect-error: a union of paths from different bases
  g.route("artist", streams, g.union(g.path(recent), g.path(registered, recent)));

  // one base and one provider per route: with a union of either, the end checks would hold for one
  // member and the graph's type claim every pair
  const catalogue = g.provider("catalogue", {
    loader: tracksOfArtist,
    temporal: "current",
    rows: "many",
    project: (v) => v.map((t) => ({ catalog: t.catalog })),
    raw: { catalog: m("Catalog") },
  });
  (["track", "artist"] as const).map((base) =>
    // @ts-expect-error: a route starts at one entity
    g.route(base, catalogue, g.path(contact, registered)),
  );
  const either = (pick: boolean) => (pick ? streams : catalogue);
  // @ts-expect-error: a route reaches one provider
  g.route("track", either(true), g.itself("track"));

  // a path is left out only for a provider keyed by the base, and still for one base, one provider
  // @ts-expect-error: streams is keyed by track: from artist it needs a path
  g.route("artist", streams);
  (["track", "artist"] as const).map((base) =>
    // @ts-expect-error: a route starts at one entity (streams is keyed by one of them)
    g.route(base, streams),
  );
  // @ts-expect-error: a route reaches one provider
  g.route("track", either(true));
  return warehouse;
}

describe("hopgraph builder: runtime", () => {
  it("lists every field with its meaning, raw and derived", () => {
    const { g } = build();
    expect(g.catalog().map((c) => [c.provider, c.field, c.kind, c.inputs, c.meta.label])).toEqual([
      ["trackStreams", "market", "raw", [], "Market"],
      ["trackStreams", "streams", "raw", [], "Streams"],
      ["trackStreams", "user", "raw", [], "User"],
      ["trackStreams", "channel", "derived", ["user"], "Channel"],
    ]);
  });

  it("computes a derived field from its raw inputs", () => {
    const { streams } = build();
    expect(streams.derived.channel?.compute({ market: "x", streams: 1, user: 12000 })).toBe(
      "radio",
    );
  });

  it("refuses duplicates and a relation with two strategies and no combine", () => {
    const { g, trackHeader, warehouse } = build();
    expect(() =>
      g.relation("track", "email", "contact", {
        cardinality: "N:1",
        strategies: (s) => [
          s(trackHeader, { needs: ["email"], project: (r) => [{ to: r.email }] }),
        ],
      }),
    ).toThrow('relation "track › email:contact" is declared twice');
    expect(() =>
      g.relation("track", "email", "both", {
        cardinality: "N:1",
        strategies: (s) => [
          s(trackHeader, { needs: ["email"], project: (r) => [{ to: r.email }] }),
          s(warehouse, { project: (_r, v) => [{ to: v.contact }] }),
        ],
      }),
    ).toThrow("2 strategies: say combine");
  });

  it("refuses at declaration a shape the types refuse, as plain JavaScript or a cast may give it", () => {
    const { g, trackHeader, streams } = build();
    const loader = (over: object) => () =>
      g.loader({
        id: `x${Math.random()}`,
        version: 1,
        keyedBy: "track",
        connectors: { allOf: ["db"] },
        batch: { by: "keys", max: 10 },
        load: trackHeader.load,
        ...over,
      } as never);
    for (const connectors of [
      { all: ["db"] },
      { any: ["db"] },
      { allOf: "db" },
      {},
      null,
      undefined,
      { allOf: [] },
      { oneOf: [] },
    ])
      expect(loader({ connectors }), JSON.stringify(connectors)).toThrow(
        expect.objectContaining({ code: "HG_SPEC" }),
      );
    expect(loader({ connectors: { allOf: ["db"], oneOf: ["db"] } })).toThrow(
      "connectors must be { allOf: [...] } or { oneOf: [...] }",
    );
    for (const batch of [{ by: "rows" }, { by: "keys", max: 0 }, { by: "one" }])
      expect(loader({ batch }), JSON.stringify(batch)).toThrow(
        expect.objectContaining({ code: "HG_SPEC" }),
      );
    for (const how of ["itself", { kind: "path" }, { kind: "union", paths: "x" }])
      expect(() => g.route("track", streams, how as never), JSON.stringify(how)).toThrow(
        expect.objectContaining({ code: "HG_SPEC" }),
      );
  });
});

describe("hopgraph builder: refs", () => {
  it("makes a base row of an entity, typed by its key schema, its row id the key's id unless given", () => {
    const { g } = build();
    const key = { catalog: "it", id: 1 };
    const track = g.ref("track", key);

    expect(track).toEqual({ row: "it:1", entity: "track", key });
    expectTypeOf(track.entity).toEqualTypeOf<"track">();
    expect(g.ref("artist", "a1", { country: "IT" }, "r1")).toEqual({
      row: "r1",
      entity: "artist",
      key: "a1",
      carries: { country: "IT" },
    });
    // @ts-expect-error: a track's key is { catalog, id }
    g.ref("track", "t1");
    // @ts-expect-error: an artist's country is a string
    g.ref("artist", "a1", { country: 1 });
    // @ts-expect-error: no entity "invoice"
    expect(() => g.ref("invoice", "i1")).toThrow(
      expect.objectContaining({ code: "HG_UNKNOWN_ENTITY" }),
    );
  });
});

describe("hopgraph builder: routes", () => {
  it("refuses a route whose path does not chain from its base to its provider's entity, as a cast may give it", () => {
    const { g, recent, streams } = build();
    const refused = [
      // starts at artist, the base is track
      () => g.route("track", streams, g.path(recent) as never),
      // the base itself, but streams is keyed by track
      () => g.route("artist", streams, g.itself("artist") as never),
    ];
    for (const route of refused)
      expect(route).toThrow(expect.objectContaining({ code: "HG_PATH" }));
    const unknown = {
      kind: "path",
      from: "artist",
      to: "track",
      relations: ["artist › track:nope"],
    };
    expect(() => g.route("artist", streams, unknown as never)).toThrow(
      expect.objectContaining({ code: "HG_UNKNOWN_RELATION" }),
    );
    // a route value changed after g.route made it is checked again where g.graph takes it
    const route = g.route("artist", streams, g.path(recent));
    expect(() => g.graph({ ...route, base: "track" } as never)).toThrow(
      expect.objectContaining({ code: "HG_PATH" }),
    );
  });

  it("takes the base itself as the path of a provider keyed by the base, and of no other", () => {
    const { g, recent, streams } = build();
    const shortForm = g.route("track", streams);

    expect(shortForm).toEqual(g.route("track", streams, g.itself("track")));
    expect(g.graph(shortForm).routes).toEqual([
      { base: "track", provider: "trackStreams", how: g.itself("track") },
    ]);
    // streams is keyed by track: from another entity a path is needed, however it is left out
    for (const how of [undefined, null] as const)
      expect(() => g.route("artist", streams, how as never)).toThrow(
        expect.objectContaining({
          code: "HG_SPEC",
          message: expect.stringContaining("keyed by the base"),
        }),
      );
    expect(() => g.route("artist", streams, g.path(recent))).not.toThrow();
    expect(() => g.route("track", undefined as never)).toThrow(
      expect.objectContaining({ code: "HG_SPEC" }),
    );
  });

  it("a route declares nothing until a graph is given it, and a graph has the routes it is given", () => {
    const { g, streams } = build();
    const route = g.route("track", streams, g.itself("track"));
    const noRoute = (graph: Parameters<typeof checkGraph>[0]) =>
      checkGraph(graph, { bases: ["track"] }).problems.filter((p) => p.code === "HG_NO_ROUTE");

    expect(noRoute(g.graph())).toEqual([
      { code: "HG_NO_ROUTE", message: "track › trackStreams: no route" },
    ]);
    expect(noRoute(g.graph(route))).toEqual([]);
    expect(g.graph(route).routes).toEqual([
      { base: "track", provider: "trackStreams", how: g.itself("track") },
    ]);
  });

  it("refuses a route given twice, one made on another graph, and a value g.route did not make", () => {
    const { g, streams } = build();
    const other = build();
    const route = g.route("track", streams, g.itself("track"));
    const theirs = other.g.route("track", other.streams, other.g.itself("track"));
    const itself = g.itself("track");
    // what g.route makes, but for one field: no kind, a base that is not a name, a how that is not
    // (or none: only g.route takes the base itself for it)
    const unmade = [
      { base: "track", provider: streams, how: itself },
      { kind: "route", base: 1, provider: streams, how: itself },
      { kind: "route", base: "track", provider: streams, how: "itself" },
      { kind: "route", base: "track", provider: streams },
    ];

    expect(() => g.graph(route, route)).toThrow(expect.objectContaining({ code: "HG_DUPLICATE" }));
    expect(() => g.graph(theirs as never)).toThrow(expect.objectContaining({ code: "HG_FOREIGN" }));
    for (const value of [...unmade, { base: "track" }, null])
      expect(() => g.graph(value as never), JSON.stringify(value)).toThrow(
        expect.objectContaining({ code: "HG_SPEC" }),
      );
  });
});

describe("checkGraph", () => {
  it("finds missing routes", () => {
    const { g, streams } = build();
    const graph = g.graph(g.route("track", streams, g.itself("track")));
    const { problems, alternatives } = checkGraph(graph, { bases: ["track", "artist"] });
    expect(problems).toEqual([{ code: "HG_NO_ROUTE", message: "artist › trackStreams: no route" }]);
    expect(alternatives).toEqual({});
  });

  it("lists the alternatives no route uses, and is clean when every pair is routed", () => {
    const { g, recent, contact, registered, streams } = build();
    const graph = g.graph(
      g.route("track", streams, g.itself("track")),
      g.route("artist", streams, g.path(recent)),
      g.route("email", streams, g.path(registered, recent)),
    );
    const { problems, alternatives } = checkGraph(graph, {
      bases: ["track", "artist", "email"],
    });
    expect(problems).toEqual([]);
    expect(alternatives).toEqual({
      "artist › trackStreams": ["artist › track:confirmed"],
      "email › trackStreams": ["email › artist:registered · artist › track:confirmed"],
    });
    void contact;
  });

  it("flags an unused loader and an entity whose needed attributes have no hydrator", () => {
    const g = hopgraph<Meta, string, Ctx>().entities({ track, artist, email });
    g.loader({
      id: "lonely",
      version: 1,
      keyedBy: "track",
      needs: ["releasedAt"],
      connectors: { allOf: ["db"] },
      batch: { by: "keys", max: 1 },
      keep: () => "none",
      partial: "keep",
      load: async () => found<{ catalog: string; id: number }, number>([]),
    });
    expect(checkGraph(g.graph(), { bases: ["track"] }).problems).toEqual([
      { code: "HG_UNUSED_LOADER", message: 'loader "lonely" is not used' },
      {
        code: "HG_NO_HYDRATOR",
        message: 'entity "track" has needed attributes (releasedAt) and no hydrator',
      },
    ]);
    // a context attribute asks for no hydrator
    const ctxTrack = entity({
      key: z.string(),
      carries: { releasedAt: z.string() },
      context: ["releasedAt"],
    });
    const g2 = hopgraph<Meta, string, Ctx>().entities({ track: ctxTrack });
    g2.relation("track", "track", "same", {
      cardinality: "1:1",
      strategies: (s) => [
        s(
          g2.loader({
            id: "windowed",
            version: 1,
            keyedBy: "track",
            needs: ["releasedAt"],
            connectors: { allOf: ["db"] },
            batch: { by: "keys", max: 1 },
            keep: () => "none",
            partial: "keep",
            load: async () => found<string, number>([]),
          }),
          { project: (ref) => [{ to: ref.key }] },
        ),
      ],
    });
    expect(checkGraph(g2.graph(), { bases: ["track"] }).problems).toEqual([]);
  });
});
