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
  type Conn,
  type Ctx,
  fake,
  free,
  MemoryCache,
  type Meta,
  m,
  options,
  providerOf,
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
  const g = hopgraph<Meta, Conn, Ctx>().entities({ track, artist });
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
    const g = hopgraph<Meta, Conn, Ctx>().entities({ isrc: entity({ key: touchy }) });
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
    const g = hopgraph<Meta, Conn, Ctx>().entities({ track: entity({ key: z.string() }) });
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
