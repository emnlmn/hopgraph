// Validation at the boundaries (DESIGN.md §5.6; run/types.ts `validate`). The base rows are checked
// against their entity's schemas before anything is read: one that fails rejects the run, named by
// row and field, never by value. What a source says through a projection (a link's target key,
// attributes and carried attributes; what a hydrator projects) is checked too: a key whose
// projection fails is unknown `failed`, code `HG_INVALID`, and the run goes on. Values that pass are
// read as their schemas parsed them. `strict` also audits every envelope; `off` runs no schema.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { type Envelope, entity, hopgraph, type Schema, ValidationError } from "../../core/index.ts";
import { type RunOptions, run } from "../index.ts";
import {
  type Behaviour,
  type Conn,
  type Ctx,
  dump,
  fake,
  free,
  MemoryCache,
  type Meta,
  m,
  options,
  providerOf,
  refs,
  rowsOf,
  stepsOf,
  traceOf,
} from "./support.ts";

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A schema that answers on a later tick: an asynchronous validator. */
function later<T>(accept: (v: unknown) => v is T): Schema<T> {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (v) =>
        new Promise((resolve) =>
          setTimeout(() => resolve(accept(v) ? { value: v } : { issues: [{ message: "no" }] }), 1),
        ),
    },
  };
}

const track = entity({
  key: z.string().trim().min(1),
  carries: { releasedAt: z.string().regex(DATE), catalog: later((v): v is string => v === "web") },
});
const artist = entity({
  key: z.string().regex(/^a\d+$/),
  carries: { country: z.string().length(2) },
});

type TrackRow = { readonly artist: string; readonly role: string; readonly country?: string };

/** Tracks with their performer (a link with a role, maybe the performer's country), a backup way
 *  to the performer, its country from a hydrator, and a profile that needs the country. */
function build(rows: Readonly<Record<string, TrackRow>>) {
  const f = {
    tracks: fake<TrackRow>({ found: rows }),
    backup: fake<{ artist: string }>({ found: { t2: { artist: "a2" } } }),
    info: fake<{ country: string }>({
      found: { a1: { country: "IT" }, a2: { country: "Italy" }, a5: { country: "FR" } },
    }),
    profiles: fake<{ name: string }>({
      found: { a1: { name: "Mira Volk" }, a5: { name: "Ines Holt" } },
    }),
  };
  const g = hopgraph<Ctx, Meta, Conn>().entities({ track, artist });
  const tracksL = g.loader({
    ...free,
    id: "tracks",
    keyedBy: "track",
    needs: ["releasedAt"],
    connectors: { allOf: ["db"] },
    load: f.tracks.load,
  });
  const backupL = g.loader({
    ...free,
    id: "backup",
    keyedBy: "track",
    connectors: { allOf: ["db"] },
    load: f.backup.load,
  });
  const infoL = g.loader({
    ...free,
    id: "info",
    keyedBy: "artist",
    connectors: { allOf: ["db"] },
    load: f.info.load,
  });
  g.hydrator("artist", infoL, (v) => ({ country: v.country }));
  const profilesL = g.loader({
    ...free,
    id: "profiles",
    keyedBy: "artist",
    needs: ["country"],
    connectors: { allOf: ["db"] },
    load: f.profiles.load,
  });
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    link: z.object({ role: z.enum(["performer", "producer"]) }),
    combine: "fallback",
    strategies: (s) => [
      s(tracksL, {
        project: (_ref, v) => [
          {
            to: v.artist,
            attrs: { role: v.role as "performer" },
            ...(v.country ? { carries: { country: v.country } } : {}),
          },
        ],
      }),
      s(backupL, { project: (_ref, v) => [{ to: v.artist, attrs: { role: "producer" } }] }),
    ],
  });
  const ask = (refs: RunOptions<Ctx>["refs"], over: Partial<RunOptions<Ctx>> = {}) =>
    run(
      g.graph(
        g.route(
          "track",
          g.provider("profile", {
            loader: profilesL,
            temporal: "current",
            rows: "one",
            project: (v) => [{ name: v.name }],
            raw: { name: m("Name") },
          }),
          g.path(performer),
        ),
      ),
      options({ refs, providers: ["profile"], ...over }),
    );
  return { ask, f, performer };
}

const row = (id: string, key: unknown, carries: Record<string, unknown> = {}) => ({
  row: id,
  entity: "track",
  key,
  carries: { releasedAt: "2026-03-03", ...carries },
});

describe("run: validating base rows", () => {
  it("a base row that fails its schemas rejects the run before anything is read, named by row and field, never by value", async () => {
    const { ask, f } = build({ t1: { artist: "a1", role: "performer" } });
    const cache = new MemoryCache();
    const error = await ask(
      [
        row("r1", "t1"),
        row("r2", 42),
        row("r3", "t3", { releasedAt: "3 March" }),
        row("r4", "t4", { catalog: "TRK-0042-catalog" }),
        row("r5", "t5", { email: "ada@example.com" }),
      ],
      { cache },
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).rows).toEqual([
      { row: "r2", entity: "track", field: "key" },
      { row: "r3", entity: "track", field: "carries.releasedAt" },
      { row: "r4", entity: "track", field: "carries.catalog" },
      { row: "r5", entity: "track", field: "carries.email" },
    ]);
    const message = (error as Error).message;
    for (const value of ["42", "3 March", "TRK-0042", "ada@example.com"])
      expect(message).not.toContain(value);
    expect(f.tracks.calls).toEqual([]);
    expect(cache.gets).toEqual([]);
  });

  it("a row that passes is read as its schemas parsed it; an asynchronous validator is awaited", async () => {
    const { ask, f } = build({ t1: { artist: "a1", role: "performer" } });
    const result = await ask([row("r1", "  t1 ", { catalog: "web" })]);

    expect(f.tracks.calls.map((c) => c.refs)).toEqual([[{ key: "t1", releasedAt: "2026-03-03" }]]);
    expect(providerOf(result, "r1", "profile").outcome).toBe("found");
  });

  it("a validator that throws fails its value: the run rejects with a ValidationError, not with what it threw", async () => {
    const touchy: Schema<string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v) => {
          if (v === "TRK-0042") throw new Error("cannot parse TRK-0042");
          return { value: String(v) };
        },
      },
    };
    const g = hopgraph<Ctx, Meta, Conn>().entities({ isrc: entity({ key: touchy }) });
    const isrcs = fake<number>({ found: { ok: 1 } });
    const refs = ["ok", "TRK-0042"].map((k, i) => ({ row: `r${i}`, entity: "isrc", key: k }));
    const error = await run(
      g.graph(
        g.route(
          "isrc",
          g.provider("isrcs", {
            loader: g.loader({
              ...free,
              id: "isrcs",
              keyedBy: "isrc",
              connectors: { allOf: ["db"] },
              load: isrcs.load,
            }),
            temporal: "current",
            rows: "one",
            project: (v) => [{ n: v }],
            raw: { n: m("N") },
          }),
          g.itself("isrc"),
        ),
      ),
      options({ refs, providers: ["isrcs"] }),
    ).then(
      () => undefined,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ValidationError);
    expect(error).toMatchObject({ rows: [{ row: "r1", entity: "isrc", field: "key" }] });
    expect((error as Error).message).not.toContain("TRK-0042");
    expect(isrcs.calls).toEqual([]);
  });

  it("validate off: no schema runs, the rows are read as they came", async () => {
    const { ask, f } = build({ " t1 ": { artist: "a1", role: "performer" } });
    const result = await ask([row("r1", " t1 ", { releasedAt: "3 March" })], { validate: "off" });

    expect(f.tracks.calls.map((c) => c.refs)).toEqual([[{ key: " t1 ", releasedAt: "3 March" }]]);
    expect(providerOf(result, "r1", "profile").outcome).toBe("found");
  });
});

describe("run: validating what sources say", () => {
  it("a link whose target key, attributes or carried attributes fail: that ref's strategy is unknown failed, HG_INVALID, and the fallback runs", async () => {
    const { ask, f, performer } = build({
      t1: { artist: "a1", role: "performer" },
      t2: { artist: "x9", role: "performer" },
      t3: { artist: "a3", role: "boss" },
      t4: { artist: "a4", role: "performer", country: "ITA" },
      t5: { artist: "a5", role: "performer", country: "FR" },
    });
    const result = await ask(["t1", "t2", "t3", "t4", "t5"].map((k) => row(k, k)));

    for (const bad of ["t2", "t3", "t4"])
      expect(stepsOf(result, bad, performer.id, "tracks"), bad).toMatchObject([
        { outcome: "unknown", reason: { reason: "failed" } },
      ]);
    expect(traceOf(result, performer.id, "tracks").errors).toEqual([
      { code: "HG_INVALID", keys: 3 },
    ]);
    // the backup way runs on them: it knows t2's performer
    expect(f.backup.loaded()).toEqual(["t2", "t3", "t4"]);
    expect(providerOf(result, "t1", "profile").outcome).toBe("found");
    // t5's link carried a valid country: the profile reads it, no hydration for a5
    expect(providerOf(result, "t5", "profile").outcome).toBe("found");
    expect(f.info.loaded()).not.toContain("a5");
    expect(providerOf(result, "t4", "profile").unknown).toEqual([{ reason: "failed" }]);
  });

  it("a hydration whose attributes fail is unknown failed, HG_INVALID: its dependent steps are unmet, never absent", async () => {
    const { ask, f } = build({ t2: { artist: "x9", role: "performer" } });
    // t2's own link fails, the backup gives a2, whose hydrated country fails its schema
    const result = await ask([row("t2", "t2")]);

    expect(stepsOf(result, "t2", "hydrate:artist")).toMatchObject([
      { ref: "a2", outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(traceOf(result, "hydrate:artist").errors).toEqual([{ code: "HG_INVALID", keys: 1 }]);
    expect(f.profiles.calls).toEqual([]);
    // the backup way found the performer; what the first could not read stays beside it
    expect(providerOf(result, "t2", "profile").unknown).toEqual([
      { reason: "failed" },
      { reason: "unmet", needs: ["country"] },
    ]);
  });

  it("validate off: projections are trusted as they are", async () => {
    const { ask, f, performer } = build({ t3: { artist: "a3", role: "boss" } });
    const result = await ask([row("t3", "t3")], { validate: "off" });

    expect(stepsOf(result, "t3", performer.id, "tracks")).toMatchObject([{ outcome: "found" }]);
    expect(f.backup.calls).toEqual([]);
  });
});

describe("run: strict envelopes", () => {
  /** A loader of track play counts whose envelope says what the test makes it say. */
  function lying(say: (keys: readonly string[]) => Envelope<string, number>) {
    const g = hopgraph<Ctx, Meta, Conn>().entities({ track: entity({ key: z.string() }) });
    return (validate: RunOptions<Ctx>["validate"]) =>
      run(
        g.graph(
          g.route(
            "track",
            g.provider("plays", {
              loader: g.loader({
                ...free,
                id: "plays",
                keyedBy: "track",
                connectors: { allOf: ["db"] },
                load: async (refs) => say(refs.map((r) => r.key)),
              }),
              temporal: "historical",
              rows: "one",
              project: (v: number) => [{ plays: v }],
              raw: { plays: m("Plays") },
            }),
            g.itself("track"),
          ),
        ),
        options({
          refs: ["t1", "t2", "t3"].map((k) => ({ row: k, entity: "track", key: k })),
          providers: ["plays"],
          validate,
        }),
      );
  }

  // t1 found and absent at once, t2 not mentioned, t9 never asked
  const envelope = (): Envelope<string, number> => ({
    values: [
      ["t1", 10],
      ["t3", 30],
      ["t9", 90],
    ],
    absent: ["t1"],
    unknown: [],
    cut: [],
    billedBytes: 0,
    errors: [],
  });

  it("strict: a key in two buckets is failed, not trusted; what was not asked, contradicted or missing is reported", async () => {
    const result = await lying(envelope)("strict");

    expect(providerOf(result, "t1", "plays").unknown).toEqual([{ reason: "failed" }]);
    expect(providerOf(result, "t2", "plays").unknown).toEqual([{ reason: "failed" }]);
    expect(providerOf(result, "t3", "plays").outcome).toBe("found");
    expect(traceOf(result, "provider:plays").errors).toEqual([
      { code: "HG_ENVELOPE_UNASKED", keys: 1 },
      { code: "HG_ENVELOPE_CONFLICT", keys: 1 },
      { code: "HG_ENVELOPE_MISSING", keys: 1 },
    ]);
  });

  it("at the boundaries an envelope is trusted as it is: the first bucket wins, a missing key fails silently", async () => {
    const result = await lying(envelope)("boundaries");

    expect(providerOf(result, "t1", "plays").outcome).toBe("found");
    expect(providerOf(result, "t2", "plays").unknown).toEqual([{ reason: "failed" }]);
    expect(traceOf(result, "provider:plays").errors).toEqual([]);
  });
});

// What a provider projects (a field's schema, DESIGN.md §5.6). Under `strict` each value a kept row
// holds is checked against its field's schema and read as the schema parsed it; a ref with a value
// that fails is unknown `failed`, with no rows, counted under `HG_INVALID`. Under `boundaries` and
// `off` no field schema runs.

type Play = {
  readonly title: string;
  readonly streams: number;
  readonly note?: string | undefined;
  readonly market?: string | undefined;
};

/** What a source says where its type says a number: text. */
const text = (s: string) => s as unknown as number;

const CHART: Readonly<Record<string, readonly Play[]>> = {
  // passes only as its schemas parse it: padded titles, numbers as text
  t1: [{ title: "  Midnight  ", streams: text("12"), note: " live " }],
  // holds no note and no market
  t2: [{ title: "Dawn", streams: text("7") }],
  // holds them as undefined
  t3: [{ title: "Dusk", streams: text("7"), note: undefined, market: undefined }],
  // streams is not a number
  t4: [{ title: "Noon", streams: text("LOTS-0042") }],
  // a row that passes, then one whose title is empty once trimmed
  t5: [
    { title: "Rise", streams: text("1") },
    { title: "   ", streams: text("2") },
  ],
  // every raw value passes; the derived `next` (2.5) is not an integer
  t6: [{ title: "Dawn", streams: text("1.5") }],
  // a market the asynchronous validator accepts, and one it refuses
  t7: [{ title: "Rise", streams: text("1"), market: "web" }],
  t8: [{ title: "Rise", streams: text("1"), market: "MKT-0042" }],
};

/** A chart per song, read by two providers of one loader: the rows of `plays` have fields with
 *  schemas (a coerced number, trimmed texts, one optional, one that answers later) and fields
 *  derived from them; `count` has one field with a schema, to see that a failure is its provider's. */
function buildChart(
  found: Readonly<Record<string, readonly Play[]>>,
  own: { readonly rows?: number; readonly unknown?: Behaviour<readonly Play[]>["unknown"] } = {},
) {
  const chart = fake<readonly Play[]>({
    found,
    ...(own.unknown === undefined ? {} : { unknown: own.unknown }),
  });
  const g = hopgraph<Ctx, Meta, Conn>().entities({ song: entity({ key: z.string() }) });
  const chartL = g.loader({
    ...free,
    id: "chart",
    keyedBy: "song",
    connectors: { allOf: ["db"] },
    load: chart.load,
  });
  const graph = g.graph(
    g.route(
      "song",
      g.provider("plays", {
        loader: chartL,
        temporal: "historical",
        rows: "many",
        project: (v) => v,
        raw: {
          title: { ...m("Title"), schema: z.string().trim().min(1) },
          streams: { ...m("Streams"), schema: z.coerce.number() },
          note: { ...m("Note"), schema: z.string().trim().min(1) },
          market: { ...m("Market"), schema: later((v): v is string => v === "web") },
        },
        derived: (d) => ({
          next: d(["streams"], ({ streams }) => streams + 1, {
            ...m("Next"),
            schema: z.number().int(),
          }),
          slug: d(["title"], ({ title }) => ` ${title.toLowerCase()} `, {
            ...m("Slug"),
            schema: z.string().trim(),
          }),
          shout: d(["note"], ({ note }) => note?.toUpperCase(), {
            ...m("Shout"),
            schema: z.string(),
          }),
        }),
        ...(own.rows === undefined ? {} : { caps: { rows: own.rows } }),
      }),
      g.itself("song"),
    ),
    g.route(
      "song",
      g.provider("count", {
        loader: chartL,
        temporal: "historical",
        rows: "one",
        project: (v) => [{ n: v.length }],
        raw: { n: { ...m("Count"), schema: z.number().int() } },
      }),
      g.itself("song"),
    ),
  );
  const ask = (
    keys: readonly string[],
    over: Partial<RunOptions<Ctx>> = {},
    providers = ["plays"],
  ) => run(graph, options({ refs: refs("song", ...keys), providers, ...over }));
  return { ask, chart };
}

const failed = [{ reason: "failed" }];

describe("run: strict field values", () => {
  it("boundaries (the default) and off: no field schema runs, values are read as the source said them", async () => {
    for (const over of [{}, { validate: "boundaries" }, { validate: "off" }] as const) {
      const { ask } = buildChart(CHART);
      const result = await ask(["t1", "t4"], over);

      const p = providerOf(result, "t1", "plays");
      expect(rowsOf(p)[0]?.fields, JSON.stringify(over)).toEqual({
        title: "  Midnight  ",
        streams: "12",
        note: " live ",
        next: "121",
        slug: "   midnight   ",
        shout: " LIVE ",
      });
      // a value no schema would take is as found as any other
      expect(providerOf(result, "t4", "plays").outcome).toBe("found");
      expect(rowsOf(providerOf(result, "t4", "plays"))[0]?.fields.streams).toBe("LOTS-0042");
      expect(traceOf(result, "provider:plays", "chart").errors).toEqual([]);
    }
  });

  it("strict: a raw value that passes is read as its schema parsed it: a coerced number, a trimmed text", async () => {
    const { ask } = buildChart(CHART);
    const result = await ask(["t1"], { validate: "strict" });

    const p = providerOf(result, "t1", "plays");
    expect(p.outcome).toBe("found");
    expect(rowsOf(p)[0]?.fields).toMatchObject({ title: "Midnight", streams: 12, note: "live" });
    expect(traceOf(result, "provider:plays", "chart").errors).toEqual([]);
  });

  it("strict: a derived field is computed from the parsed raw values, then read as its own schema parsed it", async () => {
    const { ask } = buildChart(CHART);
    const result = await ask(["t1"], { validate: "strict" });

    // 12 + 1 from the number, not "12" + 1; "LIVE" from the trimmed note; the padded slug trimmed
    expect(rowsOf(providerOf(result, "t1", "plays"))[0]?.fields).toMatchObject({
      next: 13,
      slug: "midnight",
      shout: "LIVE",
    });
  });

  it("strict: a field the row does not hold, or holds as undefined, is not checked, and nor is a derived value that is undefined", async () => {
    const { ask } = buildChart(CHART);
    const result = await ask(["t2", "t3"], { validate: "strict" });

    for (const [row, title] of [
      ["t2", "Dawn"],
      ["t3", "Dusk"],
    ] as const) {
      const p = providerOf(result, row, "plays");
      expect(p.outcome, row).toBe("found");
      const fields = rowsOf(p)[0]?.fields;
      expect(fields, row).toMatchObject({ title, streams: 7 });
      expect(fields?.note, row).toBeUndefined();
      expect(fields?.shout, row).toBeUndefined();
    }
    expect(traceOf(result, "provider:plays", "chart").errors).toEqual([]);
  });

  it("strict: a raw value that fails its schema makes its ref unknown failed with no rows, even when other rows of it passed; HG_INVALID counts the refs", async () => {
    const { ask } = buildChart(CHART);
    const result = await ask(["t4", "t5"], { validate: "strict" });

    for (const bad of ["t4", "t5"]) {
      const p = providerOf(result, bad, "plays");
      expect(p.outcome, bad).toBe("unknown");
      expect(p.unknown, bad).toEqual(failed);
      expect(p.rows, bad).toEqual([]);
      expect(stepsOf(result, bad, "provider:plays", "chart"), bad).toMatchObject([
        { outcome: "unknown", reason: { reason: "failed" } },
      ]);
    }
    expect(traceOf(result, "provider:plays", "chart").errors).toEqual([
      { code: "HG_INVALID", keys: 2 },
    ]);
  });

  it("strict: a derived value that fails its schema fails the ref the same way", async () => {
    const { ask } = buildChart(CHART);
    const result = await ask(["t6"], { validate: "strict" });

    const p = providerOf(result, "t6", "plays");
    expect(p.outcome).toBe("unknown");
    expect(p.unknown).toEqual(failed);
    expect(p.rows).toEqual([]);
    expect(stepsOf(result, "t6", "provider:plays", "chart")).toMatchObject([
      { outcome: "unknown", reason: { reason: "failed" } },
    ]);
    expect(traceOf(result, "provider:plays", "chart").errors).toEqual([
      { code: "HG_INVALID", keys: 1 },
    ]);
  });

  it("strict: an asynchronous validator is awaited, for the value it accepts and for the one it refuses", async () => {
    const { ask } = buildChart(CHART);
    const result = await ask(["t7", "t8"], { validate: "strict" });

    const ok = providerOf(result, "t7", "plays");
    expect(ok.outcome).toBe("found");
    expect(rowsOf(ok)[0]?.fields.market).toBe("web");
    const bad = providerOf(result, "t8", "plays");
    expect(bad.outcome).toBe("unknown");
    expect(bad.unknown).toEqual(failed);
    expect(bad.rows).toEqual([]);
    expect(traceOf(result, "provider:plays", "chart").errors).toEqual([
      { code: "HG_INVALID", keys: 1 },
    ]);
  });

  it("strict: a ref that fails leaves the other refs and the other providers of its own as they were, and the run goes on", async () => {
    const { ask } = buildChart(CHART);
    const result = await ask(["t1", "t4"], { validate: "strict" }, ["plays", "count"]);

    expect(result.status).toBe("complete");
    expect(providerOf(result, "t4", "plays").outcome).toBe("unknown");
    expect(rowsOf(providerOf(result, "t1", "plays"))[0]?.fields).toMatchObject({ streams: 12 });
    for (const row of ["t1", "t4"]) {
      const p = providerOf(result, row, "count");
      expect(p.outcome, row).toBe("found");
      expect(rowsOf(p)[0]?.fields, row).toEqual({ n: 1 });
    }
    expect(traceOf(result, "provider:plays", "chart").errors).toEqual([
      { code: "HG_INVALID", keys: 1 },
    ]);
    expect(traceOf(result, "provider:count", "chart").errors).toEqual([]);
  });

  it("strict: only the rows the cap kept are checked, so a bad value in a row it cut leaves the ref found, cut", async () => {
    for (const [cap, own, over] of [
      ["the run's", {}, { caps: { rows: 1 } }],
      ["the provider's", { rows: 1 }, {}],
    ] as const) {
      const { ask } = buildChart(CHART, own);
      const result = await ask(["t5"], { validate: "strict", ...over });

      const p = providerOf(result, "t5", "plays");
      expect(p.outcome, cap).toBe("found");
      expect(rowsOf(p).map((r) => r.fields.title)).toEqual(["Rise"]);
      expect(p.cut).toEqual([{ kind: "capped", cap: "rows", limit: 1 }]);
      expect(traceOf(result, "provider:plays", "chart").errors).toEqual([]);
    }
    // the same value in a row the cap keeps fails the ref
    const { ask } = buildChart(CHART, { rows: 2 });
    const result = await ask(["t5"], { validate: "strict" });
    expect(providerOf(result, "t5", "plays").outcome).toBe("unknown");
  });

  it("strict: neither the value that failed, nor the schema's message, nor what a validator threw is kept anywhere in the result", async () => {
    const quoting: Schema<string> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (v) => {
          if (v === "TRK-0042") return { issues: [{ message: `not a code: ${String(v)}` }] };
          if (v === "ISRC-0099") throw new Error(`cannot parse ${String(v)}`);
          return { value: String(v) };
        },
      },
    };
    const g = hopgraph<Ctx, Meta, Conn>().entities({ isrc: entity({ key: z.string() }) });
    const codes = fake<string>({ found: { ok: "fine", a: "TRK-0042", b: "ISRC-0099" } });
    const result = await run(
      g.graph(
        g.route(
          "isrc",
          g.provider("codes", {
            loader: g.loader({
              ...free,
              id: "codes",
              keyedBy: "isrc",
              connectors: { allOf: ["db"] },
              load: codes.load,
            }),
            temporal: "current",
            rows: "one",
            project: (v) => [{ code: v }],
            raw: { code: { ...m("Code"), schema: quoting } },
          }),
          g.itself("isrc"),
        ),
      ),
      options({ refs: refs("isrc", "ok", "a", "b"), providers: ["codes"], validate: "strict" }),
    );

    expect(providerOf(result, "ok", "codes").outcome).toBe("found");
    for (const bad of ["a", "b"]) expect(providerOf(result, bad, "codes").unknown).toEqual(failed);
    expect(traceOf(result, "provider:codes", "codes").errors).toEqual([
      { code: "HG_INVALID", keys: 2 },
    ]);
    for (const secret of ["TRK-0042", "ISRC-0099", "not a code", "cannot parse"])
      expect(dump(result)).not.toContain(secret);
  });

  it("strict: the loader's answer is cached as it came; each run checks its projection again, and boundaries reads it as it came", async () => {
    const { ask, chart } = buildChart(CHART);
    const cache = new MemoryCache();
    const first = await ask(["t1", "t4"], { validate: "strict", cache });
    const second = await ask(["t1", "t4"], { validate: "strict", cache });
    const lax = await ask(["t1", "t4"], { cache });

    expect(chart.calls).toHaveLength(1);
    for (const result of [first, second]) {
      expect(providerOf(result, "t1", "plays").outcome).toBe("found");
      expect(providerOf(result, "t4", "plays").unknown).toEqual(failed);
    }
    expect(providerOf(lax, "t4", "plays").outcome).toBe("found");
    expect(rowsOf(providerOf(lax, "t4", "plays"))[0]?.fields.streams).toBe("LOTS-0042");
  });

  it("strict: a provider whose answer is not found is not checked: absent stays absent, a failed read stays what the source said", async () => {
    const { ask } = buildChart(CHART, { unknown: { t9: { reason: "failed" } } });
    // t4 fails its schema; t9 is unknown to its loader, t10 is not in it
    const result = await ask(["t4", "t9", "t10"], { validate: "strict" });

    const absent = providerOf(result, "t10", "plays");
    expect(absent.outcome).toBe("absent");
    expect(absent.rows).toEqual([]);
    expect(providerOf(result, "t9", "plays").unknown).toEqual(failed);
    // only t4 is counted as invalid; t9's failure is the load's own
    const errors = traceOf(result, "provider:plays", "chart").errors;
    expect(errors).toHaveLength(2);
    expect(errors).toContainEqual({ code: "E_FAKE", keys: 1 });
    expect(errors).toContainEqual({ code: "HG_INVALID", keys: 1 });
  });

  it("strict: a ref the hydration refused is not read, so not checked: absent stays absent, unmet stays unmet", async () => {
    const g = hopgraph<Ctx, Meta, Conn>().entities({
      song: entity({ key: z.string(), carries: { edition: z.string() } }),
    });
    const editions = fake<{ edition: string }>({
      found: { t1: { edition: "web" }, t4: { edition: "web" } },
      unknown: { t9: { reason: "failed" } },
    });
    const chart = fake<number>({ found: { t1: text("12"), t4: text("LOTS-0042") } });
    g.hydrator(
      "song",
      g.loader({
        ...free,
        id: "editions",
        keyedBy: "song",
        connectors: { allOf: ["db"] },
        load: editions.load,
      }),
      (v) => ({ edition: v.edition }),
    );
    const result = await run(
      g.graph(
        g.route(
          "song",
          g.provider("plays", {
            loader: g.loader({
              ...free,
              id: "chart",
              keyedBy: "song",
              needs: ["edition"],
              connectors: { allOf: ["db"] },
              load: chart.load,
            }),
            temporal: "historical",
            rows: "one",
            project: (v) => [{ streams: v }],
            raw: { streams: { ...m("Streams"), schema: z.coerce.number() } },
          }),
          g.itself("song"),
        ),
      ),
      options({
        refs: refs("song", "t1", "t4", "t8", "t9"),
        providers: ["plays"],
        validate: "strict",
      }),
    );

    expect(chart.loaded()).toEqual(["t1", "t4"]);
    expect(providerOf(result, "t1", "plays").outcome).toBe("found");
    expect(providerOf(result, "t4", "plays").unknown).toEqual(failed);
    expect(providerOf(result, "t8", "plays").outcome).toBe("absent");
    expect(providerOf(result, "t9", "plays").unknown).toEqual([
      { reason: "unmet", needs: ["edition"] },
    ]);
    expect(traceOf(result, "provider:plays", "chart").errors).toEqual([
      { code: "HG_INVALID", keys: 1 },
    ]);
  });
});
