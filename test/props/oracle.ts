// What a run should answer, computed the plain way from the rules the design states (DESIGN.md
// §3.3, §3.4, §5.2, §5.3, §5.5). First, per loader and key, what the run read: an unreadable source
// is unread, a passed deadline is a deadline, a key loaded is what its last call said, a key priced
// and not loaded is what its price decided (or failed, when its wave loaded others: their calls
// spent the budget), any other key is what the cache held when the run started.
// Then, per base row and provider, a walk along the route's paths: each step's answer for each
// ref, links followed one by one, branches merged by the one rule, rows with every chain that
// reaches them. It knows nothing of waves, plan nodes or memos: the executor's meaning without its
// machinery, so the two can be compared.

import {
  CostChangedError,
  type Coverage,
  type Cut,
  type LinkStep,
  type RowResult,
  type RowStep,
  type RunResult,
  type UnknownReason,
} from "hopgraph";
import { type Event, type LoadEvent, type Played, type PriceEvent, partsOf } from "./harness.ts";
import {
  decide,
  keyOf,
  type LoaderSpec,
  type ProviderSpec,
  type RelationSpec,
  type Request,
  rowsOf,
  type Scenario,
  type StrategySpec,
  targetsOf,
  type Value,
} from "./scenario.ts";

// ---------------------------------------------------------------- what a read answered

export type Answer =
  | {
      readonly kind: "found";
      readonly value: Value;
      readonly cuts: readonly Cut[];
      readonly coverage?: Coverage;
    }
  | { readonly kind: "absent"; readonly coverage?: Coverage }
  | { readonly kind: "unknown"; readonly reason: UnknownReason };

const FAILED: Answer = { kind: "unknown", reason: { reason: "failed" } };
const DEADLINE: Answer = { kind: "unknown", reason: { reason: "deadline" } };

/** What a run read, per loader and key. */
export type Reads = (loader: string, key: string) => Answer;

const idOf = (loader: string, key: string) => `${loader}␟${key}`;

/** The cache as the runs leave it: per loader and key, the answer kept. */
export class CacheModel {
  readonly entries = new Map<string, Answer>();

  /** What a run wrote: every found or absent answer a call gave, unless its retention is none. */
  writes(s: Scenario, played: Played): Map<string, { answer: Answer; retention: string }> {
    const out = new Map<string, { answer: Answer; retention: string }>();
    for (const call of loads(played)) {
      const spec = loaderOf(s, call.loader);
      for (const [key, answer] of answersOf(spec, call)) {
        if (answer.kind === "unknown") continue;
        const retention = answer.kind === "found" ? spec.keep.found : spec.keep.absent;
        if (retention !== "none") out.set(idOf(spec.id, key), { answer, retention });
      }
    }
    return out;
  }

  apply(s: Scenario, played: Played): void {
    for (const [id, { answer }] of this.writes(s, played)) this.entries.set(id, answer);
  }
}

export function loaderOf(s: Scenario, id: string): LoaderSpec {
  const spec = s.loaders.find((l) => l.id === id);
  if (!spec) throw new Error(`oracle: no loader ${id}`);
  return spec;
}

export const loads = (p: Played): LoadEvent[] =>
  p.events.filter((e): e is LoadEvent => e.kind === "load");
export const prices = (p: Played): PriceEvent[] =>
  p.events.filter((e): e is PriceEvent => e.kind === "price");

/** A refused gate's loader: its id up to the digest (`<loader id>:<D>`, DESIGN.md §5.4). */
export const gateLoader = (gate: string): string => gate.slice(0, gate.lastIndexOf(":"));

/**
 * Where in the record the dry run that refused a gate is: the last one of the gate's own loader
 * that priced what the refusal says, or -1. Not the last dry run of any loader at that price: in
 * the refused wave another loader's job may price the same bytes, pass its approval and load
 * before the refusal is known, which the design allows (DESIGN.md §5.4: the loads already running
 * are aborted).
 */
export function refusingDryRun(
  events: readonly Event[],
  refused: { readonly gate: string; readonly priced: number },
): number {
  const loader = gateLoader(refused.gate);
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.kind === "price" && e.loader === loader && e.bytes === refused.priced) return i;
  }
  return -1;
}

/** A call's answer per key, as the design says an envelope is read: a call that threw, or that
 *  reported a failed statement under `partial: "drop"`, fails every key; a key it left out failed. */
export function answersOf(spec: LoaderSpec, call: LoadEvent): Map<string, Answer> {
  const out = new Map<string, Answer>();
  const end = call.end;
  const env = end?.kind === "done" ? end.envelope : undefined;
  const voided = !env || (spec.partial === "drop" && env.errors.length > 0);
  for (const key of call.keys) {
    if (voided) {
      out.set(key, FAILED);
      continue;
    }
    const coverage = env.coverage?.find(([k]) => k === key)?.[1];
    const covered = coverage ? { coverage } : {};
    const value = env.values.find(([k]) => k === key);
    const unknown = env.unknown.find(([k]) => k === key);
    if (value)
      out.set(key, {
        kind: "found",
        value: value[1],
        cuts: env.cut.filter(([k]) => k === key).map(([, c]) => c),
        ...covered,
      });
    else if (unknown) out.set(key, { kind: "unknown", reason: unknown[1] });
    else if (env.absent.includes(key)) out.set(key, { kind: "absent", ...covered });
    else out.set(key, FAILED);
  }
  return out;
}

/** Why a viewer may not read a loader: `allOf` needs every connector, `oneOf` one. */
export function unreadOf(s: Scenario, spec: LoaderSpec): UnknownReason | undefined {
  const refused = spec.connectors.names.flatMap((name) => {
    const r = s.readable[name] ?? true;
    return r === true ? [] : [{ name, why: r }];
  });
  const blocked =
    spec.connectors.mode === "allOf"
      ? refused.length > 0
      : refused.length === spec.connectors.names.length;
  const first = refused[0];
  if (!blocked || !first) return undefined;
  return { reason: "unread", why: first.why, connectors: refused.map((r) => r.name) };
}

/**
 * What the run read, rebuilt from its record and the cache it started from. A key it neither
 * loaded, priced nor found in that cache was answered from nothing: that throws, and the property
 * that asked fails with it.
 */
export function readsOf(
  s: Scenario,
  played: Played,
  cache: CacheModel,
  deadline = s.deadline,
): Reads {
  const loaded = new Map<string, Answer>();
  for (const call of loads(played))
    for (const [key, answer] of answersOf(loaderOf(s, call.loader), call))
      loaded.set(idOf(call.loader, key), answer);
  // a key priced and not loaded is what its gate decided
  const refused = new Map<string, Answer>();
  for (const dry of prices(played)) {
    const spec = loaderOf(s, dry.loader);
    const caps = spec.metered;
    const bytes = dry.bytes;
    const answer: Answer =
      bytes === "threw" || !Number.isFinite(bytes) || bytes < 0 || !caps
        ? FAILED
        : bytes > caps.approve
          ? { kind: "unknown", reason: { reason: "too_heavy", bytes } }
          : { kind: "unknown", reason: { reason: "awaiting_approval", bytes } };
    for (const key of dry.keys) refused.set(idOf(dry.loader, key), answer);
  }
  // a wave that was admitted loads every key it priced, until its calls spent its budget
  for (const part of partsOf(played)) {
    if (part.loads.length === 0) continue;
    const called = new Set(part.loads.flatMap((c) => c.keys));
    for (const dry of part.prices)
      for (const key of dry.keys) if (!called.has(key)) refused.set(idOf(dry.loader, key), FAILED);
  }
  return (loader, key) => {
    const spec = loaderOf(s, loader);
    const unread = unreadOf(s, spec);
    if (unread) return { kind: "unknown", reason: unread };
    if (deadline === "passed") return DEADLINE;
    const id = idOf(loader, key);
    const answer = loaded.get(id) ?? refused.get(id) ?? cache.entries.get(id);
    if (!answer)
      throw new Error(
        `${played.label}: ${loader} answered ${key} without loading, pricing or a cache entry`,
      );
    return answer;
  };
}

// ---------------------------------------------------------------- merging branches

interface Tally {
  readonly found: boolean;
  readonly unknown: readonly UnknownReason[];
  readonly cut: readonly Cut[];
  readonly coverage: readonly Coverage[];
}

type Said =
  | {
      readonly outcome: "found" | "absent";
      readonly cuts?: readonly Cut[];
      readonly coverage?: Coverage;
    }
  | { readonly outcome: "unknown"; readonly reason: UnknownReason };

const AMBIGUOUS: UnknownReason = { reason: "ambiguous" };

const nonEmpty = (cuts: readonly Cut[] = [], coverage?: Coverage) => ({
  ...(cuts.length > 0 ? { cuts } : {}),
  ...(coverage ? { coverage } : {}),
});
const found = (cuts?: readonly Cut[], coverage?: Coverage): Said => ({
  outcome: "found",
  ...nonEmpty(cuts, coverage),
});
const absent = (coverage?: Coverage, cuts?: readonly Cut[]): Said => ({
  outcome: "absent",
  ...nonEmpty(cuts, coverage),
});

function saidOf(a: Answer): Said {
  if (a.kind === "found") return found(a.cuts, a.coverage);
  if (a.kind === "absent") return absent(a.coverage);
  return { outcome: "unknown", reason: a.reason };
}

function tallyOf(said: Said): Tally {
  if (said.outcome === "unknown")
    return { found: false, unknown: [said.reason], cut: [], coverage: [] };
  return {
    found: said.outcome === "found",
    unknown: [],
    cut: said.cuts ?? [],
    // what a found branch searched is not an absence's coverage
    coverage: said.outcome === "absent" && said.coverage ? [said.coverage] : [],
  };
}

/** Every branch ran: found if one found; everything the others met stays listed. */
function union(branches: readonly Tally[]): Tally {
  return {
    found: branches.some((b) => b.found),
    unknown: distinct(branches.flatMap((b) => b.unknown)),
    cut: distinct(branches.flatMap((b) => b.cut)),
    coverage: distinct(branches.flatMap((b) => b.coverage)),
  };
}

/** A fallback: the first branch that found, with the reasons and the cuts of the branches before
 *  it (those that could not be read, or read under a cut and found nothing); when none found,
 *  every branch. */
function fallback(branches: readonly Tally[]): Tally {
  const at = branches.findIndex((b) => b.found);
  const answer = branches[at];
  if (!answer) return union(branches);
  const before = branches.slice(0, at);
  return {
    ...answer,
    unknown: distinct([...before.flatMap((b) => b.unknown), ...answer.unknown]),
    cut: distinct([...before.flatMap((b) => b.cut), ...answer.cut]),
  };
}

/** Found if any branch found; absent only if every branch ran to the end, uncut, and found
 *  nothing; unknown otherwise. */
export function outcomeOf(t: Tally): "found" | "absent" | "unknown" {
  if (t.found) return "found";
  return t.unknown.length > 0 || t.cut.length > 0 ? "unknown" : "absent";
}

// ---------------------------------------------------------------- the walk

interface Link {
  readonly relation: string;
  readonly strategy: string;
  readonly from: string;
  readonly to: string;
  readonly attrs: { readonly n: number };
  readonly ambiguous: boolean;
}

type Record = Said & {
  readonly step: string;
  readonly loader: string;
  readonly ref: string;
  readonly links?: number;
};

interface Evaluated {
  readonly links: readonly Link[];
  readonly tally: Tally;
  readonly steps: readonly Record[];
}

interface Rows {
  readonly rows: readonly { [k: string]: unknown }[];
  readonly tally: Tally;
  readonly steps: readonly Record[];
}

/** The expected answer of every base row of a request. */
export function expected(
  s: Scenario,
  request: Request,
  reads: Reads,
  show: (entity: string, key: string) => string,
) {
  const relations = new Map(s.relations.map((r) => [r.id, r]));
  const record = (
    step: string,
    loader: string,
    entity: string,
    key: string,
    said: Said,
    links?: number,
  ): Record => ({
    ...said,
    step,
    loader,
    ref: show(entity, key),
    ...(links === undefined ? {} : { links }),
  });

  // a strategy on one ref, before verification
  const draft = (r: RelationSpec, st: StrategySpec, key: string) => {
    const a = reads(st.loader, key);
    if (a.kind === "unknown")
      return { st, said: saidOf(a), candidates: [] as Link[], links: undefined };
    const searched = a.coverage ?? st.coverage;
    if (a.kind === "absent")
      return { st, said: absent(searched), candidates: [] as Link[], links: 0 };
    const candidates = targetsOf(st.pick, a.value).map(
      (i): Link => ({
        relation: r.id,
        strategy: st.loader,
        from: key,
        to: keyOf(r.to, i),
        attrs: { n: i },
        ambiguous: false,
      }),
    );
    const said = candidates.length > 0 ? found(a.cuts, a.coverage) : absent(searched, a.cuts);
    return { st, said, candidates, links: candidates.length };
  };
  type Draft = ReturnType<typeof draft>;

  const relation = memo((r: RelationSpec, key: string): Evaluated => {
    const answered: { record: Record; links: Link[]; tally: Tally; checks: Record[] }[] = [];
    const rounds = r.combine === "union" ? [r.strategies] : r.strategies.map((st) => [st]);
    for (const round of rounds) {
      const last = answered.at(-1);
      if (
        last &&
        (last.tally.found || last.tally.unknown.some((u) => u.reason === "awaiting_approval"))
      )
        break;
      const drafts: Draft[] = round.map((st) => draft(r, st, key));
      // the verification judges every candidate of this ref in this round at once
      const candidates = drafts.flatMap((d) => d.candidates);
      const verdicts = new Map<Link, { verdict: string; record: Record }>();
      const v = r.verify;
      if (v) {
        const seen = candidates.map((c) => reads(v.loader, c.to));
        const judged = decide(
          v.rule,
          seen.map((a) => ({
            state: saidOf(a).outcome,
            value: a.kind === "found" ? a.value : undefined,
          })),
        );
        candidates.forEach((c, i) => {
          const verdict = judged[i] ?? "undecided";
          const target = saidOf(seen[i] as Answer);
          const said: Said =
            verdict === "keep"
              ? found()
              : verdict === "drop"
                ? absent()
                : target.outcome === "unknown"
                  ? target
                  : { outcome: "unknown", reason: AMBIGUOUS };
          verdicts.set(c, {
            verdict,
            record: record(`verify:${r.id}`, v.loader, r.to, c.to, said),
          });
        });
      }
      for (const d of drafts) {
        const own = record(r.id, d.st.loader, r.from, key, d.said, d.links);
        if (!v || d.said.outcome !== "found") {
          answered.push({ record: own, links: d.candidates, tally: tallyOf(d.said), checks: [] });
          continue;
        }
        const kept: Link[] = [];
        const checks: Record[] = [];
        for (const c of d.candidates) {
          const judged = verdicts.get(c);
          if (!judged) throw new Error("oracle: a candidate was not judged");
          checks.push(judged.record);
          if (judged.verdict === "keep") kept.push(c);
          if (judged.verdict === "undecided") kept.push({ ...c, ambiguous: true });
        }
        // every candidate dropped: the strategy found nothing, within what it searched
        const tally =
          kept.length > 0
            ? tallyOf(d.said)
            : tallyOf(absent(d.said.coverage ?? d.st.coverage, d.said.cuts));
        answered.push({ record: own, links: kept, tally, checks });
      }
    }
    const tallies = answered.map((a) => a.tally);
    return {
      links: answered.flatMap((a) => a.links),
      tally: r.combine === "union" ? union(tallies) : fallback(tallies),
      steps: answered.flatMap((a) => [a.record, ...a.checks]),
    };
  });

  const provider = memo((p: ProviderSpec, key: string): Rows => {
    const a = reads(p.loader, key);
    let said = saidOf(a);
    let rows: { [k: string]: unknown }[] = [];
    if (a.kind === "found") {
      rows = rowsOf(p, a.value).map((row) => ({
        a: row.a,
        ...(row.b === undefined ? {} : { b: row.b }),
        ...(p.derived ? { twice: row.a * 2 } : {}),
      }));
      said = rows.length > 0 ? found(a.cuts, a.coverage) : absent(a.coverage, a.cuts);
    }
    return {
      rows,
      tally: tallyOf(said),
      steps: [record(`provider:${p.id}`, p.loader, p.entity, key, said)],
    };
  });

  const answers = new Map<string, NormalRow>();
  for (const base of request.rows) {
    const steps: Record[] = [];
    const providers: { [id: string]: NormalProvider } = {};
    for (const id of request.providers) {
      const p = s.providers.find((x) => x.id === id) as ProviderSpec;
      const route = s.routes.find((r) => r.base === base.entity && r.provider === id);
      if (!route) throw new Error(`oracle: no route ${base.entity} › ${id}`);
      const rows = new Map<
        string,
        { ref: string; index: number; fields: unknown; lineage: Map<string, LinkStep[]> }
      >();
      const walk = (
        path: readonly RelationSpec[],
        depth: number,
        entity: string,
        key: string,
        chain: readonly Link[],
      ): Tally => {
        const r = path[depth];
        if (!r) {
          const answer = provider(p, key);
          steps.push(...answer.steps);
          answer.rows.forEach((fields, index) => {
            const id = `${entity}␟${key}␟${index}␟${canonical(fields)}`;
            const row = rows.get(id) ?? {
              ref: show(entity, key),
              index,
              fields,
              lineage: new Map(),
            };
            const shown = chain.map((l) => ({
              relation: l.relation,
              strategy: l.strategy,
              from: show(relations.get(l.relation)?.from ?? "", l.from),
              to: show(relations.get(l.relation)?.to ?? "", l.to),
              attrs: l.attrs,
            }));
            row.lineage.set(canonical(shown), shown);
            rows.set(id, row);
          });
          return answer.tally;
        }
        const result = relation(r, key);
        steps.push(...result.steps);
        if (!result.tally.found) return result.tally;
        // the relation found links: whether rows are found is decided below them
        const below = result.links.map((l) => {
          const t = walk(path, depth + 1, r.to, l.to, [...chain, l]);
          return l.ambiguous ? { ...t, unknown: distinct([...t.unknown, AMBIGUOUS]) } : t;
        });
        return union([{ ...result.tally, found: false }, ...below]);
      };
      const paths =
        route.paths === "itself"
          ? [[]]
          : route.paths.map((ids) => ids.map((rid) => relations.get(rid) as RelationSpec));
      const tally = union(paths.map((path) => walk(path, 0, base.entity, base.key, [])));
      providers[id] = normalProvider({
        outcome: outcomeOf(tally),
        rows: [...rows.values()].map((r) => ({
          ref: r.ref,
          index: r.index,
          fields: r.fields,
          lineage: [...r.lineage.values()],
        })),
        unknown: tally.unknown,
        cut: tally.cut,
        coverage: tally.coverage,
      });
    }
    answers.set(base.row, { providers, steps: sortedDistinct(steps) });
  }
  return answers;
}

function memo<A extends { readonly id: string }, T>(
  compute: (a: A, key: string) => T,
): (a: A, key: string) => T {
  const done = new Map<string, T>();
  return (a, key) => {
    const id = `${a.id}␟${key}`;
    let value = done.get(id);
    if (value === undefined) {
      value = compute(a, key);
      done.set(id, value);
    }
    return value;
  };
}

// ---------------------------------------------------------------- comparing

/** JSON with object keys sorted at every level: equal values, equal text. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    x && typeof x === "object" && !Array.isArray(x) && !(x instanceof Map)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : x instanceof Map
        ? [...x.entries()]
        : x,
  );
}

function distinct<T>(items: readonly T[]): T[] {
  return [...new Map(items.map((i) => [canonical(i), i])).values()];
}

/** Distinct, in canonical order: what the contract leaves unordered, compared as a set. */
export function sortedDistinct<T>(items: readonly T[]): T[] {
  return [...new Map(items.map((i) => [canonical(i), i])).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([, i]) => i);
}

export interface NormalProvider {
  readonly outcome: string;
  readonly rows: readonly unknown[];
  readonly unknown: readonly unknown[];
  readonly cut: readonly unknown[];
  readonly coverage: readonly unknown[];
}

export interface NormalRow {
  readonly providers: { readonly [id: string]: NormalProvider };
  readonly steps: readonly unknown[];
}

function normalProvider(p: {
  readonly outcome: string;
  readonly rows: readonly {
    readonly ref: string;
    readonly index: number;
    readonly fields: unknown;
    readonly lineage: readonly (readonly LinkStep[])[];
  }[];
  readonly unknown: readonly unknown[];
  readonly cut: readonly unknown[];
  readonly coverage: readonly unknown[];
}): NormalProvider {
  return {
    outcome: p.outcome,
    rows: sortedDistinct(p.rows.map((r) => ({ ...r, lineage: sortedDistinct(r.lineage) }))),
    unknown: sortedDistinct(p.unknown),
    cut: sortedDistinct(p.cut),
    coverage: sortedDistinct(p.coverage),
  };
}

/** A row result with every list the contract leaves unordered sorted. */
export function normalRow(r: RowResult): NormalRow {
  const providers: { [id: string]: NormalProvider } = {};
  for (const [id, p] of Object.entries(r.providers)) providers[id] = normalProvider(p);
  return { providers, steps: sortedDistinct(r.steps as readonly RowStep[]) };
}

/** A whole result, comparable across runs: unordered lists sorted, time left out. */
export function normalResult(r: RunResult): unknown {
  return {
    status: r.status,
    gates: sortedDistinct(r.gates),
    rows: [...r.rows.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([row, result]) => [row, normalRow(result)]),
    trace: r.trace
      .map(({ ms: _ms, ...rest }) => ({ ...rest, errors: sortedDistinct(rest.errors) }))
      .sort((a, b) => (`${a.step}␟${a.loader}` < `${b.step}␟${b.loader}` ? -1 : 1)),
    billedBytes: r.billedBytes,
    prices: [...r.prices.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  };
}

/** How a run ended, comparable across runs: its normal result, or its error by name, a refused
 *  approval with the gates it names. */
export function normalOutcome(p: Played | undefined): unknown {
  if (p?.outcome.kind === "result") return normalResult(p.outcome.result);
  const error = p?.outcome.error;
  return error instanceof CostChangedError
    ? { name: error.name, gate: error.gate, gates: error.gates }
    : (error as Error | undefined)?.name;
}
