// The answer per base row (types.ts RowResult): for every requested provider, its rows with their
// lineage and its outcome, and every row step on the way. Keys are shown here and only here: a
// personal key becomes its digest.

import type { Attrs } from "../core/index.ts";
import { stableJson } from "./ids.ts";
import type { Ledger, Link, StepRecord } from "./ledger.ts";
import type { PlannedRoute } from "./plan.ts";
import { keyText, type RefNode, type Show } from "./refs.ts";
import { outcomeOf } from "./tally.ts";
import type { LinkStep, ProviderResult, ProviderRow, RowResult, RowStep } from "./types.ts";
import { walkRoute } from "./walk.ts";

export function attribute(
  ledger: Ledger,
  routes: readonly PlannedRoute[],
  start: RefNode,
  show: Show,
): RowResult {
  const steps = new Map<string, RowStep>();
  const providers: Record<string, ProviderResult> = {};
  for (const route of routes) {
    const rows = new Rows(show);
    const tally = walkRoute(ledger, route, start, {
      step: (record) => {
        const step = rowStep(record, show);
        steps.set(stableJson(step), step);
      },
      row: (ref, index, fields, chain) => rows.add(ref, index, fields, chain),
    });
    providers[route.provider.id] = {
      rows: rows.list(),
      outcome: outcomeOf(tally),
      unknown: tally.unknown,
      cut: tally.cut,
      coverage: tally.coverage,
    };
  }
  return { providers, steps: [...steps.values()] };
}

/**
 * A provider's rows for one base row, with every distinct chain to each. One row per key, index and
 * fields: refs of one key read with different values (two windows) give different rows.
 */
class Rows {
  private readonly rows = new Map<
    string,
    { readonly row: Omit<ProviderRow, "lineage">; readonly lineage: Map<string, LinkStep[]> }
  >();

  constructor(private readonly show: Show) {}

  add(ref: RefNode, index: number, fields: Attrs, chain: readonly Link[]): void {
    const id = `${keyText(ref)}␟${index}␟${stableJson(fields)}`;
    let entry = this.rows.get(id);
    if (!entry) {
      entry = { row: { ref: this.show(ref), index, fields }, lineage: new Map() };
      this.rows.set(id, entry);
    }
    const steps = chain.map((link) => linkStep(link, this.show));
    entry.lineage.set(stableJson(steps), steps);
  }

  list(): ProviderRow[] {
    return [...this.rows.values()].map(({ row, lineage }) => ({
      ...row,
      lineage: [...lineage.values()],
    }));
  }
}

function rowStep(record: StepRecord, show: Show): RowStep {
  const { ref, ...rest } = record;
  return { ...rest, ref: show(ref) };
}

function linkStep(link: Link, show: Show): LinkStep {
  return {
    relation: link.relation,
    strategy: link.strategy,
    from: show(link.from),
    to: show(link.to),
    attrs: link.attrs,
  };
}
