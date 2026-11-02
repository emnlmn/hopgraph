// When a loader's job may start (DESIGN.md §5.2).
//
// Every read has a wave: one more than the wave its step has reached, the reads of the steps that
// fed it included. The reads of one loader in one wave are one job: one cache lookup, one price,
// one set of calls. A job may start once nothing behind it can still add keys to it: no work of a
// lower wave is running or waiting for a read in a step that may still read the job's loader,
// itself or through the steps after it in the plan. So a step behind a fast read goes on while an
// unrelated slow read runs, and a job never starts without keys that would have reached it: which
// reads share a job depends on the plan and on what the sources answer, never on which call ended
// first.
//
// The rule used to be a barrier: a wave started once every read of the wave before had ended, so
// every step waited for the slowest read of its wave. The barrier is this rule with every step
// behind every loader (`everything`); the property tests run both and compare their jobs.

import type { GraphDef } from "../core/index.ts";
import type { PlanNode, Work } from "./plan.ts";
import { loaderOf } from "./step.ts";

/**
 * A line of work in a run: a step, or one strategy of a union round, and the wave its last read
 * was in. Work that runs side by side has a lane each; where it meets again, the lane is as far as
 * the furthest.
 */
export class Lane {
  constructor(
    readonly node: string,
    public wave: number,
  ) {}

  /** A lane for work that runs beside this one. */
  fork(): Lane {
    return new Lane(this.node, this.wave);
  }

  /** This lane once the work beside it is done. */
  join(lanes: readonly Lane[]): void {
    for (const lane of lanes) this.wave = Math.max(this.wave, lane.wave);
  }
}

/** Whether work in plan node `node` may still read `loader`, itself or through the nodes after it. */
export type Reach = (node: string, loader: string) => boolean;

/** The barrier: every step may read every loader, so a wave waits for every read before it. */
export const everything: Reach = () => true;

/** Work that holds back the jobs of later waves: a lane waiting for a read of `wave`, or busy
 *  after one (an asynchronous validator). */
export interface Behind {
  readonly node: string;
  readonly wave: number;
}

export class Schedule {
  private readonly behind = new Set<Behind>();

  constructor(private readonly reach: Reach) {}

  /** Work of `node` that will go on from `wave`: until it leaves, it holds back the jobs of later
   *  waves on the loaders it may read. */
  enter(node: string, wave: number): Behind {
    const entry = { node, wave };
    this.behind.add(entry);
    return entry;
  }

  leave(entry: Behind): void {
    this.behind.delete(entry);
  }

  /** Whether a job of `loader` in `wave` may start: nothing behind it can add keys to it. */
  clear(loader: string, wave: number): boolean {
    for (const entry of this.behind)
      if (entry.wave < wave && this.reach(entry.node, loader)) return false;
    return true;
  }

  /** Whether any work is still behind `wave`, whatever it may read. */
  before(wave: number): boolean {
    for (const entry of this.behind) if (entry.wave < wave) return true;
    return false;
  }
}

/**
 * What each plan node may read, itself or through the nodes after it: its strategies', its
 * verification's and its provider's loaders, and the hydrator of an entity whose attributes they
 * need. A node that turns out not to read one (a fallback that found, a need the base row gave)
 * only holds a job back longer than it had to.
 */
export function reachOf(graph: GraphDef<unknown>, nodes: readonly PlanNode[]): Reach {
  const after = new Map<string, string[]>();
  for (const node of nodes)
    for (const feed of node.feeds) after.set(feed, [...(after.get(feed) ?? []), node.id]);
  const own = new Map(nodes.map((node) => [node.id, readsOf(graph, node.work)]));
  const reach = new Map<string, Set<string>>();
  // the plan is acyclic: a node's set is complete once the nodes after it are
  const visit = (id: string): Set<string> => {
    let loaders = reach.get(id);
    if (loaders) return loaders;
    loaders = new Set(own.get(id));
    for (const next of after.get(id) ?? []) for (const loader of visit(next)) loaders.add(loader);
    reach.set(id, loaders);
    return loaders;
  };
  return (node, loader) => visit(node).has(loader);
}

function readsOf(graph: GraphDef<unknown>, work: Work): string[] {
  switch (work.kind) {
    case "base":
      return [];
    case "relation": {
      const { relation } = work;
      const out: string[] = [];
      for (const strategy of relation.strategies) {
        const loader = loaderOf(graph, strategy.loader);
        out.push(
          loader.id,
          ...hydratorOf(graph, relation.from, [...loader.needs, ...strategy.needs]),
        );
      }
      if (relation.verify) {
        const loader = loaderOf(graph, relation.verify.loader);
        out.push(loader.id, ...hydratorOf(graph, relation.to, loader.needs));
      }
      return out;
    }
    case "provider": {
      const loader = loaderOf(graph, work.provider.loader);
      return [loader.id, ...hydratorOf(graph, work.provider.entity, loader.needs)];
    }
  }
}

/** The hydrator a step of `entity` reading `needs` may read: none when every need is context. */
function hydratorOf(graph: GraphDef<unknown>, entity: string, needs: readonly string[]): string[] {
  const hydrator = graph.hydrators.get(entity);
  const context = graph.entities[entity]?.context ?? [];
  return hydrator && needs.some((need) => !context.includes(need)) ? [hydrator.loader] : [];
}
