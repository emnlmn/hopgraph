// Relations (DESIGN.md §3.3): a relation's strategies project its loaders' values into links,
// combined as `fallback` (strategy n + 1 on the refs strategy n did not find) or `union` (every
// strategy on every ref). A verification, when declared, reads the candidate targets and its rule
// judges all the candidates of one ref at once: kept, dropped, or undecided (they stay, marked
// ambiguous); a strategy whose candidates were all dropped found nothing. A relation whose
// cardinality says one target (`1:1`, `N:1`) and whose strategies leave two for a ref is
// `unknown: ambiguous` for it: two targets are not the answer it declares, and nothing is read
// through them. A relation is evaluated once per ref per run, refs of one key that agree on what
// the relation reads being one.

import type { Attrs, Cut, LinkOut, RelationDef, StrategyDef, Verdict } from "../core/index.ts";
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
import { Memo, Memoized } from "./memo.ts";
import { distinctRefs, identity, keyText, type RefNode } from "./refs.ts";
import type { Lane } from "./schedule.ts";
import { answerOf, loaderOf, type StepContext, statsOf, strategiesOf, timedRead } from "./step.ts";
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
  /** each ref it was run on, with what it said of it */
  readonly answers: readonly (readonly [Asked, Projected])[];
}

/** A ref a relation reads, and what its strategies answered for it so far, in their order. */
interface Asked {
  readonly ref: RefNode;
  readonly answered: Answered[];
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

/** What a verification says of a candidate. */
type Judge = (candidate: Candidate) => Check;

const AMBIGUOUS = { reason: "ambiguous" } as const;

/** A strategy's answer for a ref whose links failed their schemas. */
const INVALID: Projected = { said: say.unknown({ reason: "failed" }), candidates: [] };

export class Relations extends Memoized<RelationResult> {
  evaluate(
    lane: Lane,
    relation: RelationDef,
    refs: readonly RefNode[],
  ): Promise<ReadonlyMap<string, RelationResult>> {
    // a relation is one plan node, evaluated once per run: its attributes and memo are new here
    const read = relation.strategies.flatMap((s) => {
      const loader = loaderOf(this.ctx.graph, s.loader);
      return [...loader.needs, ...loader.hints, ...s.needs, ...s.hints];
    });
    const attrs = [...new Set(read)].sort();
    this.attrs.set(relation.id, attrs);
    const memo = new Memo<RelationResult>();
    this.memos.set(relation.id, memo);
    const keyOf = (ref: RefNode) => identity(ref, attrs);
    return memo.resolve(refs, keyOf, (claimed) => this.compute(lane, relation, claimed, keyOf));
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
    return this.peek(relation, ref);
  }

  private async compute(
    lane: Lane,
    relation: RelationDef,
    all: readonly RefNode[],
    keyOf: (ref: RefNode) => string,
  ): Promise<Map<string, RelationResult>> {
    // refs past the run's cap are not read: cut, never absent
    const { read: refs, past } = withinRefs(all, this.ctx.caps.refs);
    const asked = refs.map((ref): Asked => ({ ref, answered: [] }));
    // union: one round with every strategy on every ref; fallback: a round per strategy, each on
    // the refs the rounds before fell through
    const declared = strategiesOf(relation);
    const rounds = relation.combine === "union" ? [declared] : declared.map((s) => [s]);
    let pending = asked;
    for (const strategies of rounds) {
      if (pending.length === 0) break;
      await this.round(lane, relation, strategies, pending);
      pending = pending.filter(({ answered }) => {
        const latest = answered.at(-1);
        return latest !== undefined && fallsThrough(latest.tally);
      });
    }
    const fanOut = tighter(this.ctx.caps.links, relation.caps.links);
    const results = asked.map(({ ref, answered }): [string, RelationResult] => {
      const tallies = answered.map((a) => a.tally);
      const result = toOne(relation, {
        links: answered.flatMap((a) => a.links),
        tally: relation.combine === "union" ? union(tallies) : fallback(tallies),
        steps: answered.flatMap((a) => [a.record, ...a.checks]),
      });
      return [keyOf(ref), withinLinks(result, fanOut)];
    });
    // the refs past the cap: not read, cut, each with a row step under the first strategy's loader
    const skipped = notRead(this.ctx, relation.id, declared[0].loader, past).map(
      ({ ref, record }): [string, RelationResult] => [
        keyOf(ref),
        { links: [], tally: tallyOf(record), steps: [record] },
      ],
    );
    return new Map([...results, ...skipped]);
  }

  /** Strategies side by side on the same refs, a lane each; their candidates verified in one
   *  read, once they all are done. Each ref's answers are added to what it was answered. */
  private async round(
    lane: Lane,
    relation: RelationDef,
    strategies: readonly StrategyDef[],
    refs: readonly Asked[],
  ): Promise<void> {
    const lanes: Lane[] = [];
    const drafts = await Promise.all(
      strategies.map((strategy) => {
        const own = lane.fork();
        lanes.push(own);
        return this.draft(own, relation, strategy, refs);
      }),
    );
    lane.join(lanes);
    const candidates = drafts.flatMap((d) => d.answers.flatMap(([, p]) => p.candidates));
    const judge = await this.verify(lane, relation, candidates);
    // per ref, an answer per strategy, in the strategies' order
    for (const draft of drafts)
      for (const [asked, projected] of draft.answers)
        asked.answered.push(finish(relation.id, draft, asked.ref, projected, judge));
  }

  /** One strategy on the refs: hydrated for its needs, read, projected. */
  private async draft(
    lane: Lane,
    relation: RelationDef,
    strategy: StrategyDef,
    asked: readonly Asked[],
  ): Promise<Draft> {
    const refs = asked.map((a) => a.ref);
    const loader = loaderOf(this.ctx.graph, strategy.loader);
    const needs = [...new Set([...loader.needs, ...strategy.needs])];
    const { ready, refused } = await this.hydration.prepare(lane, relation.from, refs, needs);
    const read = await timedRead(this.ctx, lane, relation.id, loader, ready, needs);
    // a validator may be asynchronous: until the links are checked, they may still be read
    const answers = await this.ctx.reads.busy(
      lane,
      Promise.all(
        asked.map(async (a): Promise<readonly [Asked, Projected]> => {
          const refusal = refused.get(a.ref.id);
          const projected = refusal
            ? { said: refusal, candidates: [] }
            : await this.project(relation, strategy, a.ref, answerOf(read, a.ref), needs);
          return [a, projected];
        }),
      ),
    );
    const said = answers.map(([, p]) => p.said);
    const invalid = answers.filter(([, p]) => p === INVALID).length;
    this.ctx.trace.record(relation.id, loader.id, statsOf(refs.length, read, invalid), said);
    return { strategy, loader: loader.id, answers };
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

  /** Reads every candidate target once; the rule judges the candidates of each ref together.
   *  Nothing to judge when the relation verifies nothing or found no candidate. */
  private async verify(
    lane: Lane,
    relation: RelationDef,
    candidates: readonly Candidate[],
  ): Promise<Judge | undefined> {
    const verification = relation.verify;
    if (!verification || candidates.length === 0) return undefined;
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

    // what the rule said of the candidates it was shown
    const verdicts = new Map<Candidate, Verdict>();
    const judged = candidates.filter((c) => !skipped.has(c.link.to.id));
    for (const siblings of groupBy(judged, (c) => c.link.from.id)) {
      const given = verification.decide(
        siblings.map((c) => {
          const { said, value } = seen(c.link.to);
          return { link: c.out, state: said.outcome, value };
        }),
      );
      siblings.forEach((candidate, i) => {
        const verdict = given[i];
        if (verdict !== undefined) verdicts.set(candidate, verdict);
      });
    }
    return (candidate) => {
      const target = candidate.link.to;
      const skip = skipped.get(target.id);
      if (skip) return { verdict: "drop", record: skip.record, cut: skip.cut };
      // a candidate the rule gave no verdict (it answered short) stays, undecided
      const verdict = verdicts.get(candidate) ?? "undecided";
      const record = recordOf(step, loader.id, target, verdictSaid(verdict, seen(target).said));
      return { verdict, record };
    };
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
  projected: Projected,
  judge: Judge | undefined,
): Answered {
  const { said, candidates } = projected;
  const record = recordOf(step, draft.loader, ref, said, projected.links);
  if (!judge || said.outcome !== "found")
    return { record, links: candidates.map((c) => c.link), tally: tallyOf(said), checks: [] };

  const kept: Link[] = [];
  const records: StepRecord[] = [];
  const cuts: Cut[] = [];
  for (const candidate of candidates) {
    const check = judge(candidate);
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
