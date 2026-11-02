// Runs the plan (DESIGN.md §5.1): a node starts as soon as the nodes it depends on are done, over
// the refs they hand it; nodes that do not depend on each other run side by side. What a node
// computes per ref is kept by the evaluators, so a node only decides when it runs, over which refs,
// and in which wave (schedule.ts): the latest its inputs ended in, so that its reads come after
// theirs.

import { HopgraphError } from "../core/index.ts";
import type { Plan, PlanNode, Work } from "./plan.ts";
import type { Providers } from "./providers.ts";
import type { Reads } from "./reads.ts";
import { distinctRefs, type RefNode } from "./refs.ts";
import type { Relations } from "./relations.ts";
import { Lane } from "./schedule.ts";

export interface Evaluators {
  readonly relations: Relations;
  readonly providers: Providers;
  readonly reads: Reads;
}

/** What a node hands on: its refs, and the wave its last read was in. */
interface Output {
  readonly refs: readonly RefNode[];
  readonly wave: number;
}

export async function execute(
  plan: Plan,
  evaluators: Evaluators,
  base: readonly RefNode[],
): Promise<void> {
  const nodes = new Map(plan.nodes.map((node) => [node.id, node]));
  const outputs = new Map<string, Promise<Output>>();

  // the plan is acyclic, so asking for a node's inputs before it starts always ends
  const output = (id: string): Promise<Output> => {
    let out = outputs.get(id);
    if (!out) {
      const node = nodes.get(id);
      out = node
        ? start(node)
        : Promise.reject(new HopgraphError("HG_INTERNAL", `no plan node "${id}"`));
      outputs.set(id, out);
    }
    return out;
  };

  const start = async (node: PlanNode): Promise<Output> => {
    const feeds = node.feeds.map(output);
    // each feed's refs are offered to the reads of the node's loaders, so that a job of a wave
    // after the feed's and up to the node's own takes them along (DESIGN.md §3.1: one job). Every
    // feed offers, the last one done too: the last in time need not be the one of the latest wave
    if (feeds.length > 1)
      for (const feed of feeds)
        feed.then(
          (out) => {
            try {
              anticipate(node, out, evaluators);
            } catch {
              // an offer only saves a job: the node reads its refs itself, and fails there
            }
          },
          () => undefined,
        );
    const fed = await Promise.all(feeds);
    const lane = new Lane(node.id, Math.max(0, ...fed.map((f) => f.wave)));
    evaluators.reads.withdraw(node.id, lane.wave);
    const refs = distinctRefs(fed.flatMap((f) => f.refs));
    return { refs: await perform(node.work, refs, lane, evaluators, base), wave: lane.wave };
  };

  await Promise.all(plan.nodes.map((node) => output(node.id)));
}

function anticipate(node: PlanNode, out: Output, evaluators: Evaluators): void {
  if (node.work.kind === "relation")
    evaluators.relations.anticipate(node.id, node.work.relation, out.refs, out.wave);
  if (node.work.kind === "provider")
    evaluators.providers.anticipate(node.id, node.work.provider, out.refs, out.wave);
}

/** Does a node's work over the refs fed to it, and returns the refs it hands on. */
async function perform(
  work: Work,
  refs: readonly RefNode[],
  lane: Lane,
  { relations, providers }: Evaluators,
  base: readonly RefNode[],
): Promise<readonly RefNode[]> {
  switch (work.kind) {
    case "base":
      return distinctRefs(base.filter((ref) => ref.entity === work.entity));
    case "relation": {
      const results = await relations.evaluate(lane, work.relation, refs);
      return distinctRefs([...results.values()].flatMap((r) => r.links.map((link) => link.to)));
    }
    case "provider":
      await providers.evaluate(lane, work.provider, refs);
      return [];
  }
}
