// Relations (DESIGN.md §3.3): a relation's strategies project its loaders' values into links,
// combined as `fallback` (strategy n + 1 on the refs strategy n did not find) or `union` (every
// strategy on every ref). A verification, when declared, reads the candidate targets and its rule
// judges all the candidates of one ref at once: kept, dropped, or undecided (they stay, marked
// ambiguous); a strategy whose candidates were all dropped found nothing. A relation whose
// cardinality says one target (`1:1`, `N:1`) and whose strategies leave two for a ref is
// `unknown: ambiguous` for it: two targets are not the answer it declares, and nothing is read
// through them. A relation is evaluated once per ref per run, refs of one key that agree on what
// the relation reads being one.

import {
  type Attrs,
  type Cut,
  HopgraphError,
  type LinkOut,
  type RelationDef,
  type StrategyDef,
  type Verdict,
} from "../core/index.ts";
import { capped, notRead, tighter, withinRefs } from "./caps.ts";
import type { KeyAnswer } from "./envelope.ts";
import type { Hydration } from "./hydration.ts";
import {
  type Link,
  type RelationResult,
  recordOf,
  type Said,
  type StepRecord,
  saidOf,
  say,
  tallyOf,
} from "./ledger.ts";
import { Memo } from "./memo.ts";
import { distinctRefs, identity, keyText, type RefNode } from "./refs.ts";
import type { Lane } from "./schedule.ts";
import { answerOf, loaderOf, type StepContext, statsOf, timedRead } from "./step.ts";
import {
  absentTally,
  cutting,
  fallback,
  fallsThrough,
  noting,
  type Tally,
  union,
} from "./tally.ts";
import { validLinks } from "./validate.ts";

/** A link a strategy projected, before verification. */
interface Candidate {
  readonly link: Link;
  /** as the projection returned it: what the verification rule sees */
  readonly out: LinkOut<unknown, Attrs, Attrs>;
}

/** What one strategy said about one ref before verification. */
interface Projected {
  readonly said: Said;
  readonly candidates: readonly Candidate[];
  /** how many links the projection produced, when the loader answered */
  readonly links?: number;
}

interface Draft {
  readonly strategy: StrategyDef;
  readonly loader: string;
  /** by ref id */
  readonly byRef: ReadonlyMap<string, Projected>;
}

/** One strategy's answer for one ref, verification included. */
interface Answered {
  /** the strategy's row step: what its projection said, before verification */
  readonly record: StepRecord;
  readonly links: readonly Link[];
  readonly tally: Tally;
  /** the verification's row steps for this ref's candidates */
  readonly checks: readonly StepRecord[];
}

interface Check {
  readonly verdict: Verdict;
  readonly record: StepRecord;
  /** its target was past a cap and not read: the candidate is dropped, and the ref is cut */
  readonly cut?: Cut;
}

const AMBIGUOUS = { reason: "ambiguous" } as const;

/** A strategy's answer for a ref whose links failed their schemas. */
const INVALID: Projected = { said: say.unknown({ reason: "failed" }), candidates: [] };

export class Relations {
  private readonly memos = new Map<string, Memo<RelationResult>>();
  /** per relation: the carried attributes its strategies and their loaders read */
  private readonly attrs = new Map<string, readonly string[]>();

  constructor(
    private readonly ctx: StepContext,
    private readonly hydration: Hydration,
  ) {}

  evaluate(
    lane: Lane,
    relation: RelationDef,
    refs: readonly RefNode[],
  ): Promise<ReadonlyMap<string, RelationResult>> {
    const attrs = this.attrsOf(relation);
    const keyOf = (ref: RefNode) => identity(ref, attrs);
    return this.memoOf(relation.id).resolve(refs, keyOf, (claimed) =>
      this.compute(lane, relation, claimed, keyOf),
    );
  }

  /**
   * Offers refs that reached a node still waiting for its other inputs to the reads of the
   * relation's first round (every strategy of a union, the first of a fallback): what another
   * step reads of those loaders in a wave after `wave` takes them too.
   */
  anticipate(node: string, relation: RelationDef, refs: readonly RefNode[], wave: number): void {
    // under a refs cap a step reads only its own refs, which it knows once every input is in
    if (this.ctx.caps.refs !== undefined) return;
    const first =
      relation.combine === "union" ? relation.strategies : relation.strategies.slice(0, 1);
    for (const strategy of first) {
      const loader = loaderOf(this.ctx.graph, strategy.loader);
      const needs = [...new Set([...loader.needs, ...strategy.needs])];
      this.ctx.reads.anticipate(node, relation.id, loader, refs, needs, wave);
    }
  }

  result(relation: string, ref: RefNode): RelationResult | undefined {
    const attrs = this.attrs.get(relation);
    return attrs && this.memos.get(relation)?.peek(identity(ref, attrs));
  }

  private attrsOf(relation: RelationDef): readonly string[] {
    let attrs = this.attrs.get(relation.id);
    if (!attrs) {
      const read = relation.strategies.flatMap((s) => {
        const loader = loaderOf(this.ctx.graph, s.loader);
        return [...loader.needs, ...loader.hints, ...s.needs, ...s.hints];
      });
      attrs = [...new Set(read)].sort();
      this.attrs.set(relation.id, attrs);
    }
    return attrs;
  }

  private memoOf(relation: string): Memo<RelationResult> {
    let memo = this.memos.get(relation);
    if (!memo) {
      memo = new Memo<RelationResult>();
      this.memos.set(relation, memo);
    }
    return memo;
  }

  private async compute(
    lane: Lane,
    relation: RelationDef,
    all: readonly RefNode[],
    keyOf: (ref: RefNode) => string,
  ): Promise<Map<string, RelationResult>> {
    // refs past the run's cap are not read: cut, never absent
    const { read: refs, past } = withinRefs(all, this.ctx.caps.refs);
    const answered = new Map<string, Answered[]>(refs.map((ref) => [ref.id, []]));
    // union: one round with every strategy on every ref; fallback: a round per strategy, each on
    // the refs the rounds before fell through
    const rounds =
      relation.combine === "union" ? [relation.strategies] : relation.strategies.map((s) => [s]);
    let pending = refs;
    for (const strategies of rounds) {
      if (pending.length === 0) break;
      const round = await this.round(lane, relation, strategies, pending);
      for (const ref of pending) answered.get(ref.id)?.push(...(round.get(ref.id) ?? []));
      pending = pending.filter((ref) => {
        const latest = answered.get(ref.id)?.at(-1);
        return latest !== undefined && fallsThrough(latest.tally);
      });
    }
    const fanOut = tighter(this.ctx.caps.links, relation.caps.links);
    const results = refs.map((ref): [string, RelationResult] => {
      const list = answered.get(ref.id) ?? [];
      const tallies = list.map((a) => a.tally);
      const result = toOne(relation, {
        links: list.flatMap((a) => a.links),
        tally: relation.combine === "union" ? union(tallies) : fallback(tallies),
        steps: list.flatMap((a) => [a.record, ...a.checks]),
      });
      return [keyOf(ref), withinLinks(result, fanOut)];
    });
    // the refs past the cap: not read, cut, each with a row step under the first strategy's loader
    const first = relation.strategies[0]?.loader ?? "";
    const skipped = notRead(this.ctx, relation.id, first, past).map(
      ({ ref, record }): [string, RelationResult] => [
        keyOf(ref),
        { links: [], tally: tallyOf(record), steps: [record] },
      ],
    );
    return new Map([...results, ...skipped]);
  }

  /** Strategies side by side on the same refs, a lane each; their candidates verified in one
   *  read, once they all are done. */
  private async round(
    lane: Lane,
    relation: RelationDef,
    strategies: readonly StrategyDef[],
    refs: readonly RefNode[],
  ): Promise<Map<string, Answered[]>> {
    const lanes: Lane[] = [];
    const drafts = await Promise.all(
      strategies.map((strategy) => {
        const own = lane.fork();
        lanes.push(own);
        return this.draft(own, relation, strategy, refs);
      }),
    );
    lane.join(lanes);
    const candidates = drafts.flatMap((d) => [...d.byRef.values()].flatMap((p) => p.candidates));
    const checks = await this.verify(lane, relation, candidates);
    return new Map(
      refs.map((ref) => [ref.id, drafts.map((d) => finish(relation.id, d, ref, checks))]),
    );
  }

  /** One strategy on the refs: hydrated for its needs, read, projected. */
  private async draft(
    lane: Lane,
    relation: RelationDef,
    strategy: StrategyDef,
    refs: readonly RefNode[],
  ): Promise<Draft> {
    const loader = loaderOf(this.ctx.graph, strategy.loader);
    const needs = [...new Set([...loader.needs, ...strategy.needs])];
    const { ready, refused } = await this.hydration.prepare(lane, relation.from, refs, needs);
    const read = await timedRead(this.ctx, lane, relation.id, loader, ready, needs);
    // a validator may be asynchronous: until the links are checked, they may still be read
    const projected = await this.ctx.reads.busy(
      lane,
      Promise.all(
        refs.map((ref) => {
          const refusal = refused.get(ref.id);
          return refusal
            ? { said: refusal, candidates: [] }
            : this.project(relation, strategy, ref, answerOf(read, ref), needs);
        }),
      ),
    );
    const byRef = new Map(refs.map((ref, i) => [ref.id, projected[i] ?? INVALID]));
    const said = [...byRef.values()].map((p) => p.said);
    const invalid = projected.filter((p) => p === INVALID).length;
    this.ctx.trace.record(relation.id, loader.id, statsOf(refs.length, read, invalid), said);
    return { strategy, loader: loader.id, byRef };
  }

  /** What a strategy says of a ref from the loader's answer: its links, checked against their
   *  schemas unless the run validates nothing (validate.ts). */
  private async project(
    relation: RelationDef,
    strategy: StrategyDef,
    ref: RefNode,
    answer: KeyAnswer,
    stepNeeds: readonly string[],
  ): Promise<Projected> {
    if (answer.kind === "unknown") return { said: saidOf(answer), candidates: [] };
    // what the load searched for this key, else what the strategy declares it searches
    const searched = answer.coverage ?? strategy.coverage;
    if (answer.kind === "absent") return { said: say.absent(searched), candidates: [], links: 0 };
    const view = this.ctx.refs.view(ref, strategy.needs, strategy.hints, stepNeeds);
    const projected = strategy.project(view, answer.value);
    const target = this.ctx.graph.entities[relation.to];
    const outs =
      this.ctx.validate === "off" || !target
        ? projected
        : await validLinks(relation, target, projected);
    // a link that fails its schemas is the source's: nothing this strategy said of the ref holds
    if (!outs) return INVALID;
    const candidates = outs.map((out) => ({
      out,
      link: {
        relation: relation.id,
        strategy: strategy.loader,
        from: ref,
        to: this.ctx.refs.intern(relation.to, out.to, out.carries),
        attrs: out.attrs ?? {},
        ambiguous: false,
      },
    }));
    // a value that projects to no link is an absence for this strategy, within what it searched
    const said =
      candidates.length > 0
        ? say.found(answer.cuts, answer.coverage)
        : say.absent(searched, answer.cuts);
    return { said, candidates, links: candidates.length };
  }

  /** Reads every candidate target once; the rule judges the candidates of each ref together. */
  private async verify(
    lane: Lane,
    relation: RelationDef,
    candidates: readonly Candidate[],
  ): Promise<ReadonlyMap<Candidate, Check> | undefined> {
    const verification = relation.verify;
    if (!verification) return undefined;
    const checks = new Map<Candidate, Check>();
    if (candidates.length === 0) return checks;
    const step = `verify:${relation.id}`;
    const loader = loaderOf(this.ctx.graph, verification.loader);
    // targets past the run's cap are not read: their candidates are dropped, cut
    const { read: targets, past } = withinRefs(
      distinctRefs(candidates.map((c) => c.link.to)),
      this.ctx.caps.refs,
    );
    const skipped = new Map(notRead(this.ctx, step, loader.id, past).map((p) => [p.ref.id, p]));
    const { ready, refused } = await this.hydration.prepare(
      lane,
      relation.to,
      targets,
      loader.needs,
    );
    const read = await timedRead(this.ctx, lane, step, loader, ready);
    const seen = (target: RefNode): { readonly said: Said; readonly value?: unknown } => {
      const refusal = refused.get(target.id);
      if (refusal) return { said: refusal };
      const answer = answerOf(read, target);
      return { said: saidOf(answer), value: answer.kind === "found" ? answer.value : undefined };
    };
    const said = targets.map((t) => seen(t).said);
    this.ctx.trace.record(step, loader.id, statsOf(targets.length, read), said);

    for (const candidate of candidates) {
      const skip = skipped.get(candidate.link.to.id);
      if (skip) checks.set(candidate, { verdict: "drop", record: skip.record, cut: skip.cut });
    }
    const judged = candidates.filter((c) => !skipped.has(c.link.to.id));
    for (const siblings of groupBy(judged, (c) => c.link.from.id)) {
      const targetsSeen = siblings.map((c) => seen(c.link.to));
      const verdicts = verification.decide(
        siblings.map((c, i) => ({
          link: c.out,
          state: targetsSeen[i]?.said.outcome ?? "unknown",
          value: targetsSeen[i]?.value,
        })),
      );
      siblings.forEach((candidate, i) => {
        const verdict = verdicts[i] ?? "undecided";
        const target = targetsSeen[i]?.said ?? say.unknown(AMBIGUOUS);
        const record = recordOf(step, loader.id, candidate.link.to, verdictSaid(verdict, target));
        checks.set(candidate, { verdict, record });
      });
    }
    return checks;
  }
}

/**
 * A relation's answer for a ref, held to its cardinality: one that says one target (`1:1`, `N:1`)
 * and found two is unknown, ambiguous, with no link, so that neither target is read. Two links to
 * one target are one target. The strategies' row steps still say what each found.
 */
function toOne(relation: RelationDef, result: RelationResult): RelationResult {
  if (relation.cardinality !== "1:1" && relation.cardinality !== "N:1") return result;
  const targets = new Set(result.links.map((link) => keyText(link.to)));
  if (targets.size < 2) return result;
  return { ...result, links: [], tally: noting({ ...result.tally, found: false }, AMBIGUOUS) };
}

/** A relation's answer for a ref, its links within the fan-out cap: the first ones, cut. */
function withinLinks(result: RelationResult, limit: number | undefined): RelationResult {
  if (limit === undefined || result.links.length <= limit) return result;
  return {
    ...result,
    links: result.links.slice(0, limit),
    tally: cutting(result.tally, capped("links", limit)),
  };
}

/**
 * How a verdict reads as a row step: kept is found, dropped is absent, undecided is unknown (why
 * the target could not be read, when it could not; ambiguous otherwise).
 */
function verdictSaid(verdict: Verdict, target: Said): Said {
  if (verdict === "keep") return say.found();
  if (verdict === "drop") return say.absent();
  return target.outcome === "unknown" ? target : say.unknown(AMBIGUOUS);
}

/** A strategy's answer for a ref once its candidates are judged. */
function finish(
  step: string,
  draft: Draft,
  ref: RefNode,
  checks: ReadonlyMap<Candidate, Check> | undefined,
): Answered {
  const projected = draft.byRef.get(ref.id);
  if (!projected)
    throw new HopgraphError("HG_INTERNAL", "a strategy left one of its refs unanswered");
  const { said, candidates } = projected;
  const record = recordOf(step, draft.loader, ref, said, projected.links);
  if (!checks || said.outcome !== "found")
    return { record, links: candidates.map((c) => c.link), tally: tallyOf(said), checks: [] };

  const kept: Link[] = [];
  const records: StepRecord[] = [];
  const cuts: Cut[] = [];
  for (const candidate of candidates) {
    const check = checks.get(candidate);
    if (!check)
      throw new HopgraphError("HG_INTERNAL", "a verification left one of its candidates unjudged");
    records.push(check.record);
    if (check.cut) cuts.push(check.cut);
    if (check.verdict === "keep") kept.push(candidate.link);
    if (check.verdict === "undecided") kept.push({ ...candidate.link, ambiguous: true });
  }
  // every candidate dropped: the strategy found nothing, within what it searched; a candidate
  // dropped at a cap leaves the ref cut, never absent
  const tally =
    kept.length > 0
      ? tallyOf(said)
      : absentTally(said.coverage ?? draft.strategy.coverage, said.cuts);
  return {
    record,
    links: kept,
    tally: cuts[0] ? cutting(tally, cuts[0]) : tally,
    checks: records,
  };
}

function groupBy<T>(items: readonly T[], keyOf: (item: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return [...groups.values()];
}
