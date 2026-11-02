// What every step evaluator (hydration, relations, providers) works with, and what they all do:
// find a loader, read it with a stopwatch, take one ref's answer out of a read.

import {
  DefinitionError,
  type GraphDef,
  HopgraphError,
  type LoaderDef,
  type RelationDef,
  type StrategyDef,
} from "../core/index.ts";
import type { KeyAnswer } from "./envelope.ts";
import type { ReadResult, Reads } from "./reads.ts";
import type { RefNode, RefStore } from "./refs.ts";
import type { Lane } from "./schedule.ts";
import type { StepStats, TraceBook } from "./trace.ts";
import type { Caps } from "./types.ts";
import type { Validation } from "./validate.ts";

export interface StepContext {
  readonly graph: GraphDef<unknown>;
  /** what the run caps (caps.ts) */
  readonly caps: Caps;
  readonly refs: RefStore;
  readonly reads: Reads;
  readonly trace: TraceBook;
  readonly clock: () => number;
  /** which schemas run on what a projection gives (validate.ts) */
  readonly validate: Validation;
}

/** The graph's loader of an id; one a graph built by hand names but does not hold is refused. */
export function loaderOf(graph: GraphDef<unknown>, id: string): LoaderDef {
  const loader = graph.loaders.get(id);
  if (!loader)
    throw new DefinitionError("HG_FOREIGN", `loader "${id}" was not declared on this graph`);
  return loader;
}

/** A relation's strategies, at least one; a relation a graph built by hand left without one is
 *  refused, as the builder refuses it. */
export function strategiesOf(relation: RelationDef): readonly [StrategyDef, ...StrategyDef[]] {
  const [first, ...rest] = relation.strategies;
  if (!first) throw new DefinitionError("HG_SPEC", `relation "${relation.id}" has no strategy`);
  return [first, ...rest];
}

export interface TimedRead extends ReadResult {
  readonly ms: number;
}

export async function timedRead(
  ctx: StepContext,
  lane: Lane,
  step: string,
  loader: LoaderDef,
  refs: readonly RefNode[],
  stepNeeds?: readonly string[],
): Promise<TimedRead> {
  const started = ctx.clock();
  const read = await ctx.reads.read(lane, step, loader, refs, stepNeeds);
  return { ...read, ms: ctx.clock() - started };
}

/** A ref's answer in a read: a read answers every ref it was asked. */
export function answerOf(read: ReadResult, ref: RefNode): KeyAnswer {
  const answer = read.answers.get(ref.id);
  if (!answer) throw new HopgraphError("HG_INTERNAL", "a read left one of its refs unanswered");
  return answer;
}

/** A step's stats for the trace; `invalid` keys failed because what they projected failed its
 *  schemas (validate.ts). */
export function statsOf(keysIn: number, read: TimedRead, invalid = 0): StepStats {
  return {
    keysIn,
    cached: read.cached,
    billedBytes: read.billedBytes,
    ms: read.ms,
    retries: read.retries,
    errors: invalid > 0 ? [...read.errors, { code: "HG_INVALID", keys: invalid }] : read.errors,
  };
}
