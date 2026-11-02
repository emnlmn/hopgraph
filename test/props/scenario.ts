// Random scenarios for the property tests: a graph (entities, loaders, relations with strategies
// and verification, providers, routes), a world (what every loader answers for every key, what a
// dry run says, how slowly), the runs that fill the cache before the one under test, and what a
// resume approves. A scenario is generated as raw numbers and read modulo what exists, so every
// value fast-check shrinks to is still a valid scenario; `describe` prints it for a person.

import fc from "fast-check";
import type { Batch, Coverage, Cut, LoadReason, Unread, Verdict } from "hopgraph";

/** Keys per entity: few, so that rows, links and steps meet on the same keys. */
export const KEYS = 4;
export const CONNECTORS = ["c0", "c1", "c2"] as const;
export const NOW = Date.parse("2026-11-01T09:00:00Z");

/** A key names its entity (`e1-k3`), so a personal key is easy to look for in a result. */
export const keyOf = (entity: string, index: number): string => `${entity}-k${index}`;
export const indexOf = (key: string): number => Number(key.slice(key.lastIndexOf("-k") + 2));

// ---------------------------------------------------------------- the world

export type Row = {
  readonly a: number;
  readonly b?: string;
};

/** Every loader's value has the same shape: relations project `to`, providers `rows`, a
 *  verification reads `ok`. `epoch` tells a value read now from one a stale cache kept. */
export interface Value {
  readonly to: readonly number[];
  readonly rows: readonly Row[];
  readonly ok: boolean;
  readonly epoch: number;
}

/** What a loader says of one key, and what reading it costs. `silent`: the envelope leaves the key
 *  out; `statement`: a failed statement (unknown, and an entry in `errors`); `throws` and `fatal`:
 *  the whole call throws, `fatal` with an error the run declares fatal. */
export type Behaviour = (
  | {
      readonly kind: "found";
      readonly to: readonly number[];
      readonly rows: readonly Row[];
      readonly ok: boolean;
      readonly cuts: readonly Cut[];
      readonly coverage: boolean;
    }
  | { readonly kind: "absent"; readonly coverage: boolean }
  | { readonly kind: "unknown"; readonly reason: LoadReason }
  | { readonly kind: "silent" | "statement" | "throws" | "fatal" }
) & { readonly cost: number };

export const SEARCHED: Coverage = { label: "searched", days: 7 };

/** What the loader answers for a key, now or as a stale cache kept it (rows read before they
 *  changed). */
export function behaviourOf(loader: LoaderSpec, key: string, stale: boolean): Behaviour {
  const b = loader.answers[indexOf(key) % loader.answers.length] ?? ABSENT;
  if (!stale || b.kind !== "found") return b;
  return { ...b, rows: b.rows.map((r) => ({ ...r, a: r.a + 100 })) };
}

const ABSENT: Behaviour = { kind: "absent", coverage: false, cost: 1 };

export function foundValue(b: Behaviour & { readonly kind: "found" }, stale: boolean): Value {
  return { to: b.to, rows: b.rows, ok: b.ok, epoch: stale ? 0 : 1 };
}

// ---------------------------------------------------------------- the graph

export interface Metering {
  readonly auto: number;
  readonly approve: number;
  /** honest: what the jobs will bill; grows: more on every later run (a table that grew);
   *  throws, nan: a dry run that fails or answers nonsense */
  readonly price: "honest" | "grows" | "throws" | "nan";
  /** bytes every job scans whatever its keys (a shared dimension table) */
  readonly overhead: number;
}

export interface LoaderSpec {
  readonly id: string;
  readonly entity: string;
  readonly connectors: {
    readonly mode: "allOf" | "oneOf";
    /** one at least, as a loader's connectors are */
    readonly names: readonly [string, ...string[]];
  };
  readonly batch: Batch;
  readonly metered: Metering | undefined;
  readonly partial: "keep" | "drop";
  readonly keep: { readonly found: "day" | "none"; readonly absent: "brief" | "none" };
  /** per key index */
  readonly answers: readonly Behaviour[];
  /** how slow a call or a dry run is, in macrotask turns */
  readonly ticks: number;
}

/** Which of a value's targets a strategy links to. */
export type Pick = "all" | "first" | "even";
/** How a verification judges the candidates of one ref (rules.ts of a real graph). */
export type Rule = "state" | "ok" | "first" | "undecided";

export interface StrategySpec {
  readonly loader: string;
  readonly pick: Pick;
  readonly coverage: Coverage | undefined;
}

export interface RelationSpec {
  /** `from › to:name`, as the builder names it */
  readonly id: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly combine: "fallback" | "union";
  readonly strategies: readonly StrategySpec[];
  readonly verify: { readonly loader: string; readonly rule: Rule } | undefined;
}

export interface ProviderSpec {
  readonly id: string;
  readonly loader: string;
  readonly entity: string;
  readonly rows: "one" | "many";
  readonly derived: boolean;
}

export interface RouteSpec {
  readonly base: string;
  readonly provider: string;
  /** relation ids per path */
  readonly paths: readonly (readonly string[])[] | "itself";
}

export interface BaseRow {
  readonly row: string;
  readonly entity: string;
  readonly key: string;
}

export interface Request {
  readonly rows: readonly BaseRow[];
  readonly providers: readonly string[];
}

/** A run before the one under test, over part of the request: what it leaves in the cache is the
 *  cache the run under test starts from. `stale`: its sources answered older rows. */
export interface Warmup extends Request {
  readonly stale: boolean;
}

/** What the resume approves of one gate of the run under test: nothing, its price, more, or less
 *  (then the resume must refuse to load). */
export type Approval = "skip" | "exact" | "more" | "less";

export interface Scenario {
  readonly entities: readonly { readonly name: string; readonly personal: boolean }[];
  readonly loaders: readonly LoaderSpec[];
  readonly relations: readonly RelationSpec[];
  readonly providers: readonly ProviderSpec[];
  readonly routes: readonly RouteSpec[];
  readonly request: Request;
  readonly readable: Readonly<Record<string, true | Unread>>;
  readonly limits: Readonly<Record<string, number>>;
  /** passed: the deadline is behind the clock from the start */
  readonly deadline: "none" | "passed";
  readonly warmups: readonly Warmup[];
  /** per gate of the run under test, in order; empty: no resume */
  readonly approvals: readonly Approval[];
  /** seeds of the order slow calls finish in */
  readonly timing: readonly [number, number];
}

// ---------------------------------------------------------------- projections and rules

/** A strategy's links for a value: shared by the graph and the oracle, so both read one rule. */
export function targetsOf(pick: Pick, value: Value): readonly number[] {
  if (pick === "first") return value.to.slice(0, 1);
  if (pick === "even") return value.to.filter((i) => i % 2 === 0);
  return value.to;
}

export function rowsOf(provider: ProviderSpec, value: Value): readonly Row[] {
  return provider.rows === "one" ? value.rows.slice(0, 1) : value.rows;
}

export interface Judged {
  readonly state: "found" | "absent" | "unknown";
  readonly value: Value | undefined;
}

export function decide(rule: Rule, candidates: readonly Judged[]): Verdict[] {
  if (rule === "undecided") return candidates.map(() => "undecided");
  if (rule === "first") {
    const first = candidates.findIndex((c) => c.state === "found");
    return candidates.map((c, i) =>
      c.state === "unknown" ? "undecided" : i === first ? "keep" : "drop",
    );
  }
  return candidates.map((c) => {
    if (c.state === "unknown") return "undecided";
    if (c.state === "absent") return "drop";
    return rule === "ok" && !c.value?.ok ? "drop" : "keep";
  });
}

// ---------------------------------------------------------------- generation

/** What a property lets vary. Off by default: each property turns on what it is about. */
export interface Shape {
  /** metered loaders, their gates, and a resume with approvals */
  readonly metered?: boolean;
  /** failures that take a whole call with them: a throw, a failed statement under "drop" */
  readonly callFailures?: boolean;
  /** an error the run declares fatal */
  readonly fatal?: boolean;
  /** a deadline already passed */
  readonly deadline?: boolean;
  /** a job's fixed scan (`Metering.overhead`): a wave of several calls costs more than its price */
  readonly overhead?: boolean;
}

const cut: fc.Arbitrary<Cut> = fc.oneof(
  fc.record({ kind: fc.constant("cap" as const), limit: fc.integer({ min: 1, max: 3 }) }),
  fc.record({ kind: fc.constant("days" as const), days: fc.integer({ min: 1, max: 29 }) }),
  fc.record({ kind: fc.constant("truncated" as const), limit: fc.constant(10) }),
  fc.record({ kind: fc.constant("sources" as const), missing: fc.constant(["c1"]) }),
);

// the reasons a load may give: the others are the run's
const reported: fc.Arbitrary<LoadReason> = fc.constantFrom<LoadReason>(
  { reason: "failed" },
  { reason: "unread", why: "disabled", connectors: ["c1"] },
  { reason: "unread", why: "forbidden", connectors: ["c2"] },
);

const row: fc.Arbitrary<Row> = fc.record(
  { a: fc.integer({ min: 0, max: 9 }), b: fc.constantFrom("x", "y") },
  { requiredKeys: ["a"] },
);

function behaviour(shape: Shape): fc.Arbitrary<Behaviour> {
  const cost = fc.integer({ min: 1, max: 40 });
  const calls = shape.callFailures ? 1 : 0;
  return fc.oneof(
    {
      weight: 4,
      arbitrary: fc.record({ kind: fc.constant("absent"), coverage: fc.boolean(), cost }),
    },
    {
      weight: 8,
      arbitrary: fc.record({
        kind: fc.constant("found"),
        to: fc.array(fc.nat(KEYS - 1), { maxLength: 3 }),
        rows: fc.array(row, { maxLength: 3 }),
        ok: fc.boolean(),
        cuts: fc.oneof({ weight: 4, arbitrary: fc.constant([]) }, fc.array(cut, { maxLength: 2 })),
        coverage: fc.boolean(),
        cost,
      }),
    },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("unknown"), reason: reported, cost }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("silent"), cost }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("statement"), cost }) },
    { weight: calls, arbitrary: fc.record({ kind: fc.constant("throws"), cost }) },
    { weight: shape.fatal ? 1 : 0, arbitrary: fc.record({ kind: fc.constant("fatal"), cost }) },
  ) as fc.Arbitrary<Behaviour>;
}

function loaderRaw(shape: Shape) {
  const batch: fc.Arbitrary<Batch> = fc.oneof(
    fc.constant({ by: "partition" as const }),
    fc.record({ by: fc.constant("keys" as const), max: fc.integer({ min: 1, max: 3 }) }),
    fc.record({ by: fc.constant("one" as const), concurrency: fc.integer({ min: 1, max: 2 }) }),
  );
  const metering = fc.record({
    auto: fc.integer({ min: 0, max: 80 }),
    above: fc.integer({ min: 0, max: 120 }),
    price: fc.oneof(
      { weight: 6, arbitrary: fc.constant("honest" as const) },
      {
        weight: 1,
        arbitrary: fc.constantFrom("grows" as const, "throws" as const, "nan" as const),
      },
    ),
    overhead: shape.overhead ? fc.constantFrom(0, 5, 20) : fc.constant(0),
  });
  return fc.record({
    entity: fc.nat(3),
    mode: fc.constantFrom("allOf" as const, "oneOf" as const),
    names: fc.subarray([...CONNECTORS], { minLength: 1 }),
    batch,
    metered: shape.metered ? fc.oneof(fc.constant(undefined), metering) : fc.constant(undefined),
    partial: shape.callFailures
      ? fc.constantFrom("keep" as const, "drop" as const)
      : fc.constant("keep" as const),
    found: fc.constantFrom("day" as const, "none" as const),
    absent: fc.constantFrom("brief" as const, "none" as const),
    answers: fc.array(behaviour(shape), { minLength: KEYS, maxLength: KEYS }),
    ticks: fc.nat(2),
  });
}

const relationRaw = fc.record({
  from: fc.nat(3),
  to: fc.nat(3),
  combine: fc.constantFrom("fallback" as const, "union" as const),
  strategies: fc.array(
    fc.record({
      loader: fc.nat(5),
      pick: fc.constantFrom("all" as const, "first" as const, "even" as const),
      coverage: fc.boolean(),
    }),
    { minLength: 1, maxLength: 3 },
  ),
  verify: fc.option(
    fc.record({
      loader: fc.nat(5),
      rule: fc.constantFrom(
        "state" as const,
        "ok" as const,
        "first" as const,
        "undecided" as const,
      ),
    }),
    { nil: undefined, freq: 3 },
  ),
});

const readableRaw: fc.Arbitrary<true | Unread> = fc.oneof(
  { weight: 15, arbitrary: fc.constant(true as const) },
  { weight: 1, arbitrary: fc.constantFrom<Unread>("disabled", "forbidden", "not_configured") },
);

const requestRaw = fc.record({
  rows: fc.array(fc.boolean(), { maxLength: 5 }),
  providers: fc.array(fc.boolean(), { maxLength: 3 }),
  stale: fc.boolean(),
});

export function scenarios(shape: Shape = {}): fc.Arbitrary<Scenario> {
  return raw(shape).map(interpret);
}

function raw(shape: Shape) {
  return fc.record({
    entities: fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }),
    loaders: fc.array(loaderRaw(shape), { minLength: 1, maxLength: 8 }),
    relations: fc.array(relationRaw, { minLength: 1, maxLength: 4 }),
    providers: fc.array(
      fc.record({
        loader: fc.nat(5),
        rows: fc.constantFrom("one" as const, "many" as const),
        derived: fc.boolean(),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    rows: fc.array(fc.record({ entity: fc.nat(3), key: fc.nat(KEYS - 1) }), {
      minLength: 1,
      maxLength: 5,
    }),
    request: fc.array(fc.boolean(), { maxLength: 3 }),
    routes: fc.array(fc.nat(15), { maxLength: 6 }),
    readable: fc.array(readableRaw, { minLength: 3, maxLength: 3 }),
    limits: fc.array(fc.option(fc.integer({ min: 1, max: 3 }), { nil: undefined }), {
      minLength: 3,
      maxLength: 3,
    }),
    deadline: shape.deadline
      ? fc.oneof(
          { weight: 4, arbitrary: fc.constant("none" as const) },
          fc.constant("passed" as const),
        )
      : fc.constant("none" as const),
    warmups: fc.array(requestRaw, { maxLength: 2 }),
    approvals: shape.metered
      ? fc.array(fc.constantFrom<Approval>("exact", "more", "less", "skip"), { maxLength: 3 })
      : fc.constant<Approval[]>([]),
    timing: fc.tuple(fc.nat(), fc.nat()),
  });
}

type Raw = ReturnType<typeof raw> extends fc.Arbitrary<infer R> ? R : never;

/** Reads raw numbers as a scenario: indices modulo what exists, relations from a lower entity to
 *  a higher one (so no two routes order relations both ways), what cannot be built left out. */
function interpret(raw: Raw): Scenario {
  const entities = raw.entities.map((personal, i) => ({ name: `e${i}`, personal }));
  const n = entities.length;
  const entityAt = (i: number) => `e${i % n}`;

  // loaders spread over the entities, so most entities have one to read them by
  const loaders: LoaderSpec[] = raw.loaders.map((l, i) => ({
    id: `L${i}`,
    entity: entityAt(l.entity + i),
    // the generator draws one name at least
    connectors: { mode: l.mode, names: l.names as [string, ...string[]] },
    batch: l.batch,
    metered: l.metered && {
      auto: l.metered.auto,
      approve: l.metered.auto + l.metered.above,
      price: l.metered.price,
      overhead: l.metered.overhead,
    },
    partial: l.partial,
    keep: { found: l.found, absent: l.absent },
    answers: l.answers,
    ticks: l.ticks,
  }));
  const keyedBy = (entity: string, pick: number) => {
    const own = loaders.filter((l) => l.entity === entity);
    return own[pick % Math.max(1, own.length)];
  };

  const relations: RelationSpec[] = [];
  raw.relations.forEach((r, i) => {
    const a = r.from % n;
    const b = r.to % n === a ? (a + 1) % n : r.to % n;
    if (a === b) return;
    const [from, to] = [`e${Math.min(a, b)}`, `e${Math.max(a, b)}`];
    const strategies = r.strategies.flatMap((s, j) => {
      const loader = keyedBy(from, s.loader + j);
      if (!loader) return [];
      return [
        { loader: loader.id, pick: s.pick, coverage: s.coverage ? { label: `s${j}` } : undefined },
      ];
    });
    if (strategies.length === 0) return;
    const checker = r.verify && keyedBy(to, r.verify.loader);
    relations.push({
      id: `${from} › ${to}:r${i}`,
      name: `r${i}`,
      from,
      to,
      combine: r.combine,
      strategies,
      verify: r.verify && checker ? { loader: checker.id, rule: r.verify.rule } : undefined,
    });
  });

  const providers: ProviderSpec[] = raw.providers.map((p, i) => {
    const loader = loaders[p.loader % loaders.length] as LoaderSpec;
    return {
      id: `p${i}`,
      loader: loader.id,
      entity: loader.entity,
      rows: p.rows,
      derived: p.derived,
    };
  });

  // the base rows, and the providers every base entity among them reaches
  let rows = raw.rows.map((r, i) => ({ row: `row${i}`, entity: entityAt(r.entity), key: r.key }));
  const reaches = (base: string, entity: string) =>
    base === entity || pathsBetween(relations, base, entity).length > 0;
  const reachedByAll = () =>
    providers.filter((p) => rows.every((r) => reaches(r.entity, p.entity)));
  if (reachedByAll().length === 0) {
    const first = providers[0] as ProviderSpec;
    rows = rows.map((r) => ({ ...r, entity: first.entity }));
  }
  const reachable = reachedByAll();
  const wanted = reachable.filter((_, i) => raw.request[i] ?? true);
  const requested = (wanted.length > 0 ? wanted : reachable.slice(0, 1)).map((p) => p.id);
  const baseRows = rows.map((r) => ({ row: r.row, entity: r.entity, key: keyOf(r.entity, r.key) }));

  // a route per (base entity, requested provider): "itself", or some of the paths that reach it
  const routes: RouteSpec[] = [];
  let choice = 0;
  for (const base of [...new Set(baseRows.map((r) => r.entity))])
    for (const id of requested) {
      const provider = providers.find((p) => p.id === id) as ProviderSpec;
      if (base === provider.entity) {
        routes.push({ base, provider: id, paths: "itself" });
        continue;
      }
      const all = pathsBetween(relations, base, provider.entity);
      const mask = (raw.routes[choice++] ?? 1) % 2 ** all.length || 1;
      routes.push({ base, provider: id, paths: all.filter((_, i) => mask & (1 << i)) });
    }

  const subset = <T>(items: readonly T[], mask: readonly boolean[]) => {
    const kept = items.filter((_, i) => mask[i] ?? true);
    return kept.length > 0 ? kept : items;
  };
  const warmups = raw.warmups.map((w) => ({
    rows: subset(baseRows, w.rows),
    providers: subset(requested, w.providers),
    stale: w.stale,
  }));

  const scenario: Scenario = {
    entities,
    loaders,
    relations,
    providers,
    routes,
    request: { rows: baseRows, providers: requested },
    readable: Object.fromEntries(CONNECTORS.map((c, i) => [c, raw.readable[i] ?? true])),
    limits: Object.fromEntries(
      CONNECTORS.flatMap((c, i) => (raw.limits[i] === undefined ? [] : [[c, raw.limits[i]]])),
    ),
    deadline: raw.deadline,
    warmups,
    approvals: raw.approvals,
    timing: raw.timing,
  };
  return Object.defineProperty(scenario, fc.toStringMethod, { value: () => describe(scenario) });
}

/** Every simple path of relations from one entity to another, up to three relations. */
export function pathsBetween(
  relations: readonly RelationSpec[],
  from: string,
  to: string,
): string[][] {
  const out: string[][] = [];
  const walk = (at: string, ids: string[]) => {
    if (ids.length > 0 && at === to) {
      out.push(ids);
      return;
    }
    if (ids.length === 3) return;
    for (const r of relations) if (r.from === at) walk(r.to, [...ids, r.id]);
  };
  walk(from, []);
  return out;
}

// ---------------------------------------------------------------- reading a scenario

/** A scenario as a person reads it: what fast-check prints for a counterexample. */
export function describe(s: Scenario): string {
  const lines: string[] = [""];
  const used = new Set([
    ...s.relations.flatMap((r) => [...r.strategies.map((x) => x.loader), r.verify?.loader]),
    ...s.providers.map((p) => p.loader),
  ]);
  lines.push(
    `entities  ${s.entities.map((e) => (e.personal ? `${e.name} (personal)` : e.name)).join(", ")}`,
  );
  const conn = CONNECTORS.map((c) => {
    const r = s.readable[c];
    const limit = s.limits[c];
    return `${c}${r === true ? "" : ` ${r}`}${limit === undefined ? "" : ` limit ${limit}`}`;
  });
  lines.push(`sources   ${conn.join(", ")}${s.deadline === "passed" ? "; deadline passed" : ""}`);
  for (const l of s.loaders) {
    if (!used.has(l.id)) continue;
    const batch =
      l.batch.by === "keys"
        ? `keys/${l.batch.max}`
        : l.batch.by === "one"
          ? `one/${l.batch.concurrency}`
          : "partition";
    const m = l.metered;
    const metered = m
      ? `, metered auto ${m.auto} approve ${m.approve} (price ${m.price}${m.overhead ? `, overhead ${m.overhead}` : ""})`
      : "";
    lines.push(
      `${l.id.padEnd(9)} keyed by ${l.entity}, ${l.connectors.mode} [${l.connectors.names.join(" ")}], ${batch}${metered}, ` +
        `partial ${l.partial}, keep ${l.keep.found}/${l.keep.absent}${l.ticks ? `, ${l.ticks} ticks` : ""}`,
    );
    lines.push(`          ${l.answers.map((b, i) => `k${i} ${said(b, !!m)}`).join("; ")}`);
  }
  for (const r of s.relations) {
    const strategies = r.strategies.map(
      (x) => `${x.loader} ${x.pick}${x.coverage ? ` (${x.coverage.label})` : ""}`,
    );
    const verify = r.verify ? `; verify ${r.verify.loader} by ${r.verify.rule}` : "";
    lines.push(`relation  ${r.id} ${r.combine}: ${strategies.join(", ")}${verify}`);
  }
  for (const p of s.providers)
    lines.push(
      `provider  ${p.id} on ${p.entity} by ${p.loader}, rows ${p.rows}${p.derived ? ", derived" : ""}`,
    );
  for (const r of s.routes) {
    const how = r.paths === "itself" ? "itself" : r.paths.map((p) => p.join(" · ")).join(" | ");
    lines.push(`route     ${r.base} › ${r.provider}: ${how}`);
  }
  const rows = (q: Request) =>
    `${q.rows.map((r) => `${r.row}=${r.key}`).join(" ")} for ${q.providers.join(" ")}`;
  s.warmups.forEach((w) => {
    lines.push(`warm-up   ${rows(w)}${w.stale ? " (stale)" : ""}`);
  });
  lines.push(`run       ${rows(s.request)}`);
  if (s.approvals.length > 0) lines.push(`resume    approve ${s.approvals.join(" ")}`);
  return lines.join("\n");
}

function said(b: Behaviour, metered: boolean): string {
  const cost = metered ? ` $${b.cost}` : "";
  if (b.kind === "found") {
    const extras = [
      b.to.length > 0 ? `→${b.to.join(",")}` : "",
      b.rows.length > 0 ? `rows ${b.rows.map((r) => `${r.a}${r.b ?? ""}`).join(",")}` : "",
      b.ok ? "" : "not ok",
      ...b.cuts.map((c) => `cut ${c.kind}`),
      b.coverage ? "covered" : "",
    ].filter((x) => x !== "");
    return `found${extras.length > 0 ? ` ${extras.join(" ")}` : ""}${cost}`;
  }
  if (b.kind === "absent") return `absent${b.coverage ? " covered" : ""}${cost}`;
  if (b.kind === "unknown") return `unknown ${b.reason.reason}${cost}`;
  return `${b.kind}${cost}`;
}
