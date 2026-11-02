// A runner (run/types.ts `Runner`, `RunEnv`, `RunCall`; README, "The runner"): the graph and what
// holds for the process, given once; at each call site `run(call)`, or `read(entity, keys,
// providers)`, which makes one base row per key and gives each back under its key's id. A call
// narrows the env where both give an option (`readable`: both must say so; `caps`: the smaller
// wins) and never replaces the rest. The types follow the graph: entity names, key types, context
// attributes, the providers asked, and whether `ctx` may be left out.

import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import {
  absent,
  type DefinitionError,
  type Entity,
  entity,
  envelope,
  found,
  type GraphDef,
  hopgraph,
  ValidationError,
} from "../../core/index.ts";
import {
  createInflight,
  createRunner,
  type Health,
  type Inflight,
  type ReadKey,
  type ReadKeys,
  run,
} from "../index.ts";
import {
  artist,
  type Conn,
  CTX,
  type Ctx,
  digest,
  dump,
  fake,
  free,
  MemoryCache,
  type Meta,
  m,
  NOW,
  providerOf,
  refs,
  track,
} from "./support.ts";

type Listener = { readonly market: string; readonly streams: number };

/** A free loader read through `db`. */
const viaDb = { ...free, connectors: { allOf: ["db"] } } as const;

function build() {
  const f = {
    lineup: fake<{ readonly artist: string }>({
      found: { t1: { artist: "a1" }, t2: { artist: "a2" } },
      unknown: { t4: { reason: "failed" } },
    }),
    listeners: fake<readonly Listener[]>({
      found: {
        a1: [
          { market: "a", streams: 1 },
          { market: "b", streams: 2 },
          { market: "c", streams: 3 },
        ],
      },
    }),
    onDb: fake<{ readonly n: number }>({ found: { t1: { n: 1 } } }),
    onWh: fake<{ readonly n: number }>({ found: { t1: { n: 2 } } }),
    onApi: fake<{ readonly n: number }>({ found: { t1: { n: 3 } } }),
    sessions: fake<{ readonly plays: number }>({
      found: { "s1@2026-11-01": { plays: 4 }, "s2@2026-10-31": { plays: 7 } },
      lookup: (ref) => `${ref.key}@${String(ref.day)}`,
    }),
    domains: fake<{ readonly domain: string }>({
      found: { "ada@example.com": { domain: "example.com" } },
    }),
  };
  const g = hopgraph<Ctx, Meta, Conn>().entities({
    track,
    artist,
    shelf: entity({
      key: z.object({ shop: z.string(), aisle: z.number() }),
      id: (k) => `${k.shop}/${k.aisle}`,
    }),
    slot: entity({ key: z.tuple([z.string(), z.number()]), id: ([a, b]) => `${a}#${b}` }),
    // a session is read over its day, which only the row that names the session brings
    session: entity({
      key: z.string(),
      carries: { day: z.string(), device: z.string() },
      context: ["day"],
    }),
    email: entity({ key: z.email(), personal: true }),
  });

  const lineupL = g.loader({ ...viaDb, id: "lineup", keyedBy: "track", load: f.lineup.load });
  const listenersL = g.loader({
    ...viaDb,
    id: "listeners",
    keyedBy: "artist",
    load: f.listeners.load,
  });
  const performer = g.relation("track", "artist", "performer", {
    cardinality: "N:1",
    strategies: (s) => [s(lineupL, { project: (_ref, v) => [{ to: v.artist }] })],
  });
  const listeners = g.provider("listeners", {
    loader: listenersL,
    temporal: "historical",
    rows: "many",
    project: (v) => v.map((p) => ({ market: p.market, streams: p.streams })),
    raw: { market: m("Market"), streams: m("Streams") },
  });

  // one provider per connector, keyed by the track itself
  const on = <const Id extends string>(id: Id, conn: Conn, load: (typeof f)["onDb"]["load"]) =>
    g.provider(id, {
      loader: g.loader({ ...free, id, keyedBy: "track", connectors: { allOf: [conn] }, load }),
      temporal: "current",
      rows: "one",
      project: (v) => [{ n: v.n }],
      raw: { n: m("N") },
    });
  const onDb = on("onDb", "db", f.onDb.load);
  const onWh = on("onWh", "wh", f.onWh.load);
  const onApi = on("onApi", "api", f.onApi.load);

  // shelves and slots have keys that are not strings: their labels are found by key id
  const LABELS = new Map([
    ["it/3", "aisle 3"],
    ["a#1", "a1"],
    ["b#2", "b2"],
  ]);
  const shelves = g.loader({
    ...viaDb,
    id: "shelves",
    keyedBy: "shelf",
    load: async (refs) =>
      envelope(
        refs.map((r) => {
          const label = LABELS.get(`${r.key.shop}/${r.key.aisle}`);
          return [r.key, label ? found({ label }) : absent()];
        }),
      ),
  });
  const slots = g.loader({
    ...viaDb,
    id: "slots",
    keyedBy: "slot",
    load: async (refs) =>
      envelope(
        refs.map((r) => {
          const label = LABELS.get(r.key.join("#"));
          return [r.key, label ? found({ label }) : absent()];
        }),
      ),
  });
  const label = { temporal: "current", rows: "one", raw: { label: m("Label") } } as const;
  const shelfLabel = g.provider("shelfLabel", {
    ...label,
    loader: shelves,
    project: (v) => [{ label: v.label }],
  });
  const slotLabel = g.provider("slotLabel", {
    ...label,
    loader: slots,
    project: (v) => [{ label: v.label }],
  });

  const sessionsL = g.loader({
    ...viaDb,
    id: "sessions",
    keyedBy: "session",
    needs: ["day"],
    load: f.sessions.load,
  });
  const sessionLog = g.provider("sessionLog", {
    loader: sessionsL,
    temporal: "historical",
    rows: "one",
    project: (v) => [{ plays: v.plays }],
    raw: { plays: m("Plays") },
  });

  const domain = g.provider("domain", {
    loader: g.loader({ ...viaDb, id: "domains", keyedBy: "email", load: f.domains.load }),
    temporal: "current",
    rows: "one",
    project: (v) => [{ domain: v.domain }],
    raw: { domain: m("Domain") },
  });

  const graph = g.graph(
    g.route("track", listeners, g.path(performer)),
    g.route("track", onDb, g.itself("track")),
    g.route("track", onWh, g.itself("track")),
    g.route("track", onApi, g.itself("track")),
    g.route("shelf", shelfLabel, g.itself("shelf")),
    g.route("slot", slotLabel, g.itself("slot")),
    g.route("session", sessionLog, g.itself("session")),
    g.route("email", domain, g.itself("email")),
  );
  return { g, graph, f, listeners, onDb, sessionLog };
}

/** What holds for the process in these tests. */
const env = () => ({
  cache: new MemoryCache(),
  limits: { db: 4, wh: 4, api: 4 },
  clock: () => NOW,
  digest,
});

const noKeyIn = (error: unknown) => (error as DefinitionError).code;

describe("createRunner: run", () => {
  it("reads with the env's options and the call's, as run does with both, and every call shares the env's cache", async () => {
    const { graph, f } = build();
    const process = env();
    const runner = createRunner(graph, process);
    const call = { refs: refs("track", "t1", "t4"), providers: ["listeners"], ctx: CTX };
    const first = await runner.run(call);
    const alone = await run(graph, { ...env(), ...call });

    for (const row of ["t1", "t4"])
      expect(providerOf(first, row, "listeners")).toEqual(providerOf(alone, row, "listeners"));
    expect(providerOf(first, "t4", "listeners").unknown).toEqual([{ reason: "failed" }]);
    const loads = f.listeners.calls.length;
    await runner.run(call);
    expect(f.listeners.calls).toHaveLength(loads);
    expect(process.cache.gets.length).toBeGreaterThan(0);
  });

  it("a connector is readable when the env and the call both say so, the env's reason first", async () => {
    const { graph } = build();
    const runner = createRunner(graph, {
      ...env(),
      readable: (c) => (c === "wh" ? "not_configured" : true),
    });
    const providers = ["onDb", "onWh", "onApi"];
    const narrowed = await runner.run({
      refs: refs("track", "t1"),
      providers,
      ctx: CTX,
      readable: (c) => (c === "api" ? true : "forbidden"),
    });
    const envOnly = await runner.run({ refs: refs("track", "t1"), providers, ctx: CTX });

    const why = (r: typeof narrowed, p: string) => providerOf(r, "t1", p).unknown;
    expect(why(narrowed, "onDb")).toEqual([
      { reason: "unread", why: "forbidden", connectors: ["db"] },
    ]);
    expect(why(narrowed, "onWh")).toEqual([
      { reason: "unread", why: "not_configured", connectors: ["wh"] },
    ]);
    expect(providerOf(narrowed, "t1", "onApi").outcome).toBe("found");
    expect(providerOf(envOnly, "t1", "onDb").outcome).toBe("found");
    expect(why(envOnly, "onWh")).toEqual([
      { reason: "unread", why: "not_configured", connectors: ["wh"] },
    ]);
  });

  it("each cap is the smaller of the env's and the call's", async () => {
    const { graph } = build();
    const runner = createRunner(graph, { ...env(), caps: { rows: 2 } });
    const rowsWith = async (caps?: { readonly rows: number }) => {
      const result = await runner.run({
        refs: refs("track", "t1"),
        providers: ["listeners"],
        ctx: CTX,
        ...(caps ? { caps } : {}),
      });
      return providerOf(result, "t1", "listeners").rows.length;
    };

    expect(await rowsWith()).toBe(2);
    expect(await rowsWith({ rows: 1 })).toBe(1);
    expect(await rowsWith({ rows: 3 })).toBe(2);
  });

  it("a call's caps that are not whole numbers from 1 reject the call, even under smaller ones", async () => {
    const { graph, f } = build();
    const runner = createRunner(graph, { ...env(), caps: { rows: 1 } });
    const error = await runner
      .run({ refs: refs("track", "t1"), providers: ["listeners"], ctx: CTX, caps: { rows: 1.5 } })
      .catch((e: unknown) => e);

    expect(noKeyIn(error)).toBe("HG_SPEC");
    expect(f.lineup.calls).toEqual([]);
  });

  it("a call never replaces the env's cache, health or loads in flight", async () => {
    const { graph } = build();
    const process = env();
    const runner = createRunner(graph, process);
    const theirs = new MemoryCache();
    // a call object that carries env options, as a spread of something else may
    const call = {
      refs: refs("track", "t1"),
      providers: ["onDb"],
      ctx: CTX,
      cache: theirs,
      health: {} as Health,
      inflight: {} as Inflight,
    };
    const result = await runner.run(call);

    expect(providerOf(result, "t1", "onDb").outcome).toBe("found");
    expect(theirs.gets).toEqual([]);
    expect(process.cache.written().size).toBe(1);
  });

  it("an env the run would refuse is refused when the runner is made", () => {
    const { graph } = build();
    for (const wrong of [
      { caps: { refs: 0 } },
      { limits: { db: Number.NaN } },
      { limits: { db: 0 } },
      { health: {} as Health },
      { inflight: {} as Inflight },
    ])
      expect(() => createRunner(graph, wrong), JSON.stringify(wrong)).toThrow(
        expect.objectContaining({ code: "HG_SPEC" }),
      );
  });

  it("types the providers asked as run does: as declared, typed fields; by id, any name", async () => {
    const { graph, listeners, onDb } = build();
    const runner = createRunner(graph, env());
    const typed = await runner.run({ refs: refs("track", "t1"), providers: [listeners], ctx: CTX });
    const byId = await runner.run({
      refs: refs("track", "t1"),
      providers: ["listeners"],
      ctx: CTX,
    });
    const either = (pick: boolean) => (pick ? listeners : onDb);
    const maybe = await runner.run({
      refs: refs("track", "t1"),
      providers: [either(true)],
      ctx: CTX,
    });

    const row = typed.rows.get("t1");
    if (!row) throw new Error("no row");
    expectTypeOf(row.providers.listeners.rows[0]?.fields.streams).toEqualTypeOf<
      number | undefined
    >();
    // @ts-expect-error: no field "price" on listeners
    expect(row.providers.listeners.rows[0]?.fields.price).toBeUndefined();
    expectTypeOf(byId.rows.get("t1")?.providers.listeners?.rows[0]?.fields).toEqualTypeOf<
      Readonly<Record<string, unknown>> | undefined
    >();
    expectTypeOf(maybe.rows.get("t1")?.providers.onDb).toBeNullable();
    expect(row.providers.listeners.rows.map((r) => r.fields.market)).toEqual(["a", "b", "c"]);
  });

  it("a call must give ctx when the graph's Ctx does not admit undefined, and may leave it out when it does", async () => {
    const { graph } = build();
    const runner = createRunner(graph);
    // @ts-expect-error: the graph's runs carry a Ctx
    const missing = runner.run({ refs: [], providers: [] });
    // @ts-expect-error: read needs the call, for its ctx
    const unread = runner.read("track", "t1", ["onDb"]);
    await Promise.allSettled([missing, unread]);

    const bare = hopgraph<undefined, Meta>().entities({ track });
    const loader = bare.loader({
      id: "totals",
      keyedBy: "track",
      connectors: { allOf: ["db"] },
      batch: { by: "partition" },
      load: fake<{ readonly total: number }>({ found: { t1: { total: 5 } } }).load,
    });
    const total = bare.provider("total", {
      loader,
      temporal: "historical",
      rows: "one",
      project: (v) => [{ total: v.total }],
      raw: { total: m("Total") },
    });
    const carriesNothing = bare.graph(bare.route("track", total, bare.itself("track")));
    const result = await createRunner(carriesNothing).read("track", "t1", ["total"]);
    expect(result.rows.get("t1")?.providers.total?.rows[0]?.fields).toEqual({ total: 5 });
  });
});

describe("createRunner: read", () => {
  it("reads the providers for keys of one entity, each row under its key's id, unknowns as run gives them", async () => {
    const { graph, listeners } = build();
    const runner = createRunner(graph, env());
    const result = await runner.read("track", ["t1", "t4"], [listeners], { ctx: CTX });
    const alone = await run(graph, {
      ...env(),
      refs: refs("track", "t1", "t4"),
      providers: [listeners],
      ctx: CTX,
    });

    expect([...result.rows.keys()]).toEqual(["t1", "t4"]);
    for (const row of ["t1", "t4"])
      expect(providerOf(result, row, "listeners")).toEqual(providerOf(alone, row, "listeners"));
    expect(result.rows.get("t4")?.providers.listeners.outcome).toBe("unknown");
    expectTypeOf(result.rows.get("t1")?.providers.listeners.rows[0]?.fields.market).toEqualTypeOf<
      string | undefined
    >();
  });

  it("takes one key alone", async () => {
    const { graph } = build();
    const result = await createRunner(graph, env()).read("track", "t1", ["onDb"], { ctx: CTX });

    expect([...result.rows.keys()]).toEqual(["t1"]);
    expect(providerOf(result, "t1", "onDb").outcome).toBe("found");
  });

  it("an object key's row is under the entity's id of it", async () => {
    const { graph } = build();
    const result = await createRunner(graph, env()).read(
      "shelf",
      { shop: "it", aisle: 3 },
      ["shelfLabel"],
      { ctx: CTX },
    );

    expect(providerOf(result, "it/3", "shelfLabel").rows[0]?.fields).toEqual({ label: "aisle 3" });
  });

  it("a key that is itself an array is given in a list: one key is never read as several", async () => {
    const { graph } = build();
    const runner = createRunner(graph, env());
    const result = await runner.read(
      "slot",
      [
        ["a", 1],
        ["b", 2],
      ],
      ["slotLabel"],
      { ctx: CTX },
    );

    expect([...result.rows.keys()]).toEqual(["a#1", "b#2"]);
    // @ts-expect-error: a key that is an array is given in a list
    const alone = runner.read("slot", ["a", 1], ["slotLabel"], { ctx: CTX });
    await alone.catch(() => undefined);
  });

  it("an entity with context attributes takes each key with them, and its loads read them", async () => {
    const { graph, f, sessionLog } = build();
    const runner = createRunner(graph, env());
    const result = await runner.read(
      "session",
      [
        { key: "s1", carries: { day: "2026-11-01" } },
        { key: "s2", carries: { day: "2026-10-31", device: "ios" } },
      ],
      [sessionLog],
      { ctx: CTX },
    );

    expect(f.sessions.calls.flatMap((c) => c.refs)).toEqual([
      { key: "s1", day: "2026-11-01" },
      { key: "s2", day: "2026-10-31" },
    ]);
    expect(result.rows.get("s1")?.providers.sessionLog.rows[0]?.fields.plays).toBe(4);
    expect(result.rows.get("s2")?.providers.sessionLog.rows[0]?.fields.plays).toBe(7);

    const call = { ctx: CTX };
    const refused = [
      // @ts-expect-error: a session's day comes only with the row that names it
      runner.read("session", "s1", [sessionLog], call),
      // @ts-expect-error: every context attribute is required
      runner.read("session", { key: "s1", carries: { device: "ios" } }, [sessionLog], call),
      // @ts-expect-error: a carried attribute is typed by its schema
      runner.read("session", { key: "s1", carries: { day: 20261101 } }, [sessionLog], call),
    ];
    await Promise.allSettled(refused);
  });

  it("g.ref asks a base row of an entity with context attributes for every one of them", async () => {
    const { g, graph, sessionLog } = build();
    const days = new Map([
      ["s1", "2026-11-01"],
      ["s2", "2026-10-31"],
    ]);
    const refs = [...days].map(([key, day]) => g.ref("session", key, { day }));
    const result = await createRunner(graph, env()).run({
      refs,
      providers: [sessionLog],
      ctx: CTX,
    });

    expect(result.rows.get("s1")?.providers.sessionLog.rows[0]?.fields.plays).toBe(4);
    expect(result.rows.get("s2")?.providers.sessionLog.rows[0]?.fields.plays).toBe(7);
    // @ts-expect-error: a session's day comes only with the row that names it
    g.ref("session", "s1");
    // @ts-expect-error: every context attribute is required
    g.ref("session", "s1", { device: "ios" });
  });

  it("a key that fails its schema rejects the read, named by its place, never by its value", async () => {
    const { graph, f } = build();
    const secret = "zz-not-an-address-zz";
    const error = await createRunner(graph, env())
      .read("email", ["ada@example.com", secret], ["domain"], { ctx: CTX })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).rows).toEqual([
      { row: "keys[1]", entity: "email", field: "key" },
    ]);
    expect(String(error)).not.toContain(secret);
    expect(f.domains.calls).toEqual([]);
  });

  it("a personal key's row is under the key the caller gave; the result shows it nowhere else", async () => {
    const { graph } = build();
    const result = await createRunner(graph, env()).read("email", "ada@example.com", ["domain"], {
      ctx: CTX,
    });

    expect(providerOf(result, "ada@example.com", "domain").rows[0]?.ref).toBe(
      digest("email", "ada@example.com"),
    );
    const unkeyed = new Map([...result.rows.values()].map((row, i) => [`row ${i}`, row]));
    expect(dump({ ...result, rows: unkeyed })).not.toContain("ada@example.com");
  });

  it("a provider with no route from the entity does not compile, and the run refuses it before anything is read, keys or none", async () => {
    const { graph, f, onDb } = build();
    const runner = createRunner(graph, env());
    for (const keys of ["a1", []]) {
      const error = await runner
        // @ts-expect-error: provider "onDb" has no route from "artist"
        .read("artist", keys, ["onDb"], { ctx: CTX })
        .catch((e: unknown) => e);
      expect(noKeyIn(error), JSON.stringify(keys)).toBe("HG_NO_ROUTE");
    }
    // @ts-expect-error: as declared too
    const declared = runner.read("artist", "a1", [onDb], { ctx: CTX });
    expect(noKeyIn(await declared.catch((e: unknown) => e))).toBe("HG_NO_ROUTE");
    // an id the compiler cannot know is the run's to refuse
    const picked: string = "onDb";
    const error = await runner
      .read("artist", "a1", [picked], { ctx: CTX })
      .catch((e: unknown) => e);
    expect(noKeyIn(error)).toBe("HG_NO_ROUTE");
    expect(f.onDb.calls).toEqual([]);
    expect((await runner.read("track", [], ["onDb"], { ctx: CTX })).rows.size).toBe(0);
  });

  it("one key read with different carried attributes is refused, by its places, before anything is read", async () => {
    const { graph, f, sessionLog } = build();
    const error = await createRunner(graph, env())
      .read(
        "session",
        [
          { key: "s1", carries: { day: "2026-11-01" } },
          { key: "s2", carries: { day: "2026-10-31" } },
          { key: "s1", carries: { day: "2026-10-31" } },
        ],
        [sessionLog],
        { ctx: CTX },
      )
      .catch((e: unknown) => e);

    expect(noKeyIn(error)).toBe("HG_DUPLICATE");
    expect(String(error)).toContain("keys[0] and keys[2]");
    for (const value of ["s1", "s2", "2026-11-01", "2026-10-31"])
      expect(String(error)).not.toContain(value);
    expect(f.sessions.calls).toEqual([]);
  });

  it("one key given twice with the same carried attributes is one row", async () => {
    const { graph, sessionLog } = build();
    const s1 = { key: "s1", carries: { day: "2026-11-01" } };
    const result = await createRunner(graph, env()).read("session", [s1, s1], [sessionLog], {
      ctx: CTX,
    });

    expect([...result.rows.keys()]).toEqual(["s1"]);
    expect(result.rows.get("s1")?.providers.sessionLog.rows[0]?.fields.plays).toBe(4);
  });

  it("names an entity of the graph and takes keys of its type", async () => {
    const { graph } = build();
    const runner = createRunner(graph, env());
    const call = { ctx: CTX };
    const refused = [
      // @ts-expect-error: no entity "invoice" in the graph
      runner.read("invoice", "i1", ["onDb"], call),
      // @ts-expect-error: an track's key is a string
      runner.read("track", 1, ["onDb"], call),
      // @ts-expect-error: a shelf's key is { shop, aisle }
      runner.read("shelf", "it/3", ["shelfLabel"], call),
    ];
    const errors = await Promise.all(refused.map((p) => p.catch((e: unknown) => e)));
    expect(errors.map(noKeyIn)).toEqual(["HG_UNKNOWN_ENTITY", "HG_INVALID", "HG_INVALID"]);
  });

  it("takes no key for a name that may be one of several entities, nor over a graph that does not type its entities", async () => {
    const { graph } = build();
    const call = { ctx: CTX };
    const either = (pick: boolean): "track" | "shelf" => (pick ? "track" : "shelf");
    const person = (pick: boolean): "track" | "artist" => (pick ? "track" : "artist");
    const untyped: GraphDef<Meta> = graph;
    const reads = [
      // @ts-expect-error: an track's key and a shelf's are not one type
      createRunner(graph, env()).read(either(true), "t1", ["onDb"], call),
      // @ts-expect-error: one of two entities, even of one key type: say which
      createRunner(graph, env()).read(person(true), "t1", ["onDb"], call),
      // @ts-expect-error: a graph typed as a GraphDef says nothing of its entities' keys
      createRunner(untyped, env()).read("track", "t1", ["onDb"]),
    ];
    await Promise.allSettled(reads);
  });

  it("types the keys from the entity's declaration", () => {
    type Graph = {
      readonly tag: Entity<string | readonly string[], Record<never, never>>;
      readonly plain: Entity<string, { readonly day: string }>;
      readonly session: Entity<string, { readonly day: string }, "day">;
    };
    // a key that may be an array is given in a list, so that the list is never read as one key
    expectTypeOf<ReadKeys<Graph, "tag">>().toEqualTypeOf<readonly (string | readonly string[])[]>();
    // so is a key whose type an array fits: the runtime takes an array for a list
    type Wide = {
      readonly anything: Entity<unknown, Record<never, never>>;
      readonly something: Entity<object, Record<never, never>>;
      // biome-ignore lint/complexity/noBannedTypes: `{}` is the type under test
      readonly empty: Entity<{}, Record<never, never>>;
    };
    expectTypeOf<ReadKeys<Wide, "anything">>().toEqualTypeOf<readonly unknown[]>();
    expectTypeOf<ReadKeys<Wide, "something">>().toEqualTypeOf<readonly object[]>();
    // biome-ignore lint/complexity/noBannedTypes: `{}` is the type under test
    expectTypeOf<ReadKeys<Wide, "empty">>().toEqualTypeOf<readonly {}[]>();
    // an entity written Entity<K, C> has no context: bare keys
    expectTypeOf<ReadKey<Graph, "plain">>().toEqualTypeOf<string>();
    expectTypeOf<ReadKey<Graph, "session">>().toEqualTypeOf<{
      readonly key: string;
      readonly carries: { readonly day: string };
    }>();
  });
});

describe("createRunner: given no cache", () => {
  /** Order totals from a warehouse priced at 1e9 bytes a key, under an auto cap of 1.5e9: one key
   *  runs without approval, three wait for one. Each load takes 20 ms; `started()` resolves when
   *  the next one starts. */
  function metered() {
    const g = hopgraph<Ctx, Meta, Conn>().entities({ track });
    const loads: string[][] = [];
    let onLoad: (() => void) | undefined;
    const totals = g.loader({
      ...free,
      id: "totals",
      keyedBy: "track",
      connectors: { allOf: ["wh"] },
      cost: { metered: { auto: 1.5e9, approve: 1e10 } },
      price: async (refs) => refs.length * 1e9,
      load: async (refs) => {
        loads.push(refs.map((r) => r.key));
        onLoad?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
        return envelope(
          refs.map((r) => [r.key, found({ total: 1 })]),
          refs.length * 1e9,
        );
      },
    });
    const total = g.provider("total", {
      loader: totals,
      temporal: "historical",
      rows: "one",
      project: (v) => [{ total: v.total }],
      raw: { total: m("Total") },
    });
    const started = () =>
      new Promise<void>((resolve) => {
        onLoad = resolve;
      });
    return { graph: g.graph(g.route("track", total, g.itself("track"))), loads, started };
  }

  const ASKED = ["t1", "t2", "t3"];
  const call = { ctx: CTX };

  it("keeps the scopes of its gates: an approval covers the part of its keys another call is not loading", async () => {
    const { graph, loads, started } = metered();
    const runner = createRunner(graph, { inflight: createInflight() });
    const first = await runner.read("track", ASKED, ["total"], call);
    expect(first.status).toBe("gated");
    const approved = Object.fromEntries(first.gates.map((gate) => [gate.id, gate.bytes]));

    // another call reads t1 alone, under the auto cap; the resume finds it loading and borrows it
    const o1Loading = started();
    const other = runner.read("track", "t1", ["total"], call);
    await o1Loading;
    const resumed = await runner.read("track", ASKED, ["total"], { ...call, approved });
    await other;

    expect(resumed.status).toBe("complete");
    expect(loads).toEqual([["t1"], ["t2", "t3"]]);
    // and nothing else: the answers are read again
    await runner.read("track", "t2", ["total"], call);
    expect(loads.at(-1)).toEqual(["t2"]);
  });

  it("keeps a gate's scope for an hour, the time it is written for", async () => {
    const { graph, started } = metered();
    let now = NOW;
    const runner = createRunner(graph, { inflight: createInflight(), clock: () => now });
    const first = await runner.read("track", ASKED, ["total"], call);
    const approved = Object.fromEntries(first.gates.map((gate) => [gate.id, gate.bytes]));
    now += 3_600_000;

    const o1Loading = started();
    const other = runner.read("track", "t1", ["total"], call);
    await o1Loading;
    const resumed = await runner.read("track", ASKED, ["total"], { ...call, approved });
    await other;

    // the scope is gone: the part the approval covered stops at a gate of its own
    expect(resumed.status).toBe("gated");
    expect(resumed.gates).toMatchObject([{ keys: 2, bytes: 2e9 }]);
  });
});
