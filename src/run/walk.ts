// One base ref along one route, over what the evaluation left (DESIGN.md §5.5): the provider rows
// it reaches, the chains of links that reach them, the row steps on the way, and the tally that
// says found, absent or unknown. Pure.

import type { Attrs, RelationDef } from "../core/index.ts";
import type { Ledger, Link, StepRecord } from "./ledger.ts";
import type { PlannedRoute } from "./plan.ts";
import type { RefNode } from "./refs.ts";
import { noting, type Tally, union } from "./tally.ts";

const AMBIGUOUS = { reason: "ambiguous" } as const;

export interface Visitor {
  step(record: StepRecord): void;
  row(ref: RefNode, index: number, fields: Attrs, chain: readonly Link[]): void;
}

export function walkPath(
  ledger: Ledger,
  path: readonly RelationDef[],
  provider: string,
  start: RefNode,
  visit?: Visitor,
): Tally {
  const walk = (depth: number, ref: RefNode, chain: readonly Link[]): Tally => {
    const hydrated = ledger.hydration(ref);
    if (hydrated) visit?.step(hydrated);
    const relation = path[depth];
    if (!relation) {
      const answer = ledger.provider(provider, ref);
      for (const record of answer.steps) visit?.step(record);
      answer.rows.forEach((fields, index) => {
        visit?.row(ref, index, fields, chain);
      });
      return answer.tally;
    }
    const result = ledger.relation(relation.id, ref);
    for (const record of result.steps) visit?.step(record);
    if (!result.tally.found) return result.tally;
    // the relation found links: whether rows are found is decided below them; the relation adds
    // what it met on the way (a cut, a strategy it could not read)
    const own: Tally = { ...result.tally, found: false };
    const below = result.links.map((link) => {
      const tally = walk(depth + 1, link.to, [...chain, link]);
      // an undecided candidate may be the wrong target: whatever is read through it says so
      return link.ambiguous ? noting(tally, AMBIGUOUS) : tally;
    });
    return union([own, ...below]);
  };
  return walk(0, start, []);
}

/** A route's tally for a base ref: the union of its paths. */
export function walkRoute(
  ledger: Ledger,
  route: PlannedRoute,
  start: RefNode,
  visit?: Visitor,
): Tally {
  const provider = route.provider.id;
  return union(route.paths.map((path) => walkPath(ledger, path, provider, start, visit)));
}
