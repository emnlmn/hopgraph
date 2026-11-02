// Gates on metered loaders (DESIGN.md §5.3, §5.4). A metered load is priced before it runs: under
// its `auto` cap it runs with the price as budget; up to `approve` it waits for an approval; above
// it, it is too heavy to run. An approval names a gate by id, and the id is the same for the same
// loader keys (ids.ts), so resuming is the same run again.

import { CostChangedError, type LoaderDef, type Metered } from "../core/index.ts";
import { scopeKey } from "./ids.ts";
import type { CachedAnswer, CachePort, Gate } from "./types.ts";

export type Decision =
  | { readonly kind: "run"; readonly maxBytes: number }
  | { readonly kind: "gate" }
  | { readonly kind: "too_heavy" };

/**
 * What a priced load may do. An approval holds for the price it was given: a price that grew past
 * it throws before anything is billed, one that did not runs with the approval as budget.
 */
export function decide(
  caps: Metered["metered"],
  bytes: number,
  gate: string,
  approval: number | undefined,
): Decision {
  if (approval !== undefined && bytes > approval) throw new CostChangedError(gate, approval, bytes);
  if (bytes > caps.approve) return { kind: "too_heavy" };
  if (approval !== undefined) return { kind: "run", maxBytes: Math.min(approval, caps.approve) };
  if (bytes <= caps.auto) return { kind: "run", maxBytes: bytes };
  return { kind: "gate" };
}

/**
 * The approvals a run was given, and what each has covered so far.
 *
 * An approval covers the request of its own gate id. It also covers a later request for a subset
 * of its keys, at no higher price than what is left of it: on resume the cache answers what was
 * read, waves gather steps otherwise, and the keys one wave asked together may come in two. A
 * subset runs with its own price as its budget and spends it, so the subsets of one approval never
 * get more than its bytes between them. To know a gate's keys on resume, the run that stops at a
 * gate keeps its scope (the tokens of its keys) in the cache port; an approval whose scope the
 * cache no longer holds covers its own id only, and a subset stops at a gate of its own: a second
 * approval round, never a load nobody approved.
 */
export class Approvals {
  private readonly spent = new Map<string, number>();
  private scopes: Promise<ReadonlyMap<string, ReadonlySet<string>>> | undefined;

  constructor(
    private readonly approved: Readonly<Record<string, number>>,
    private readonly cache: CachePort,
  ) {}

  /** The bytes approved for exactly this gate, if any. */
  exact(gate: string): number | undefined {
    return Object.hasOwn(this.approved, gate) ? this.approved[gate] : undefined;
  }

  /** Whether an approval of more keys of this loader covers these at this price; if so it is
   *  spent by that much. */
  async cover(
    loader: Pick<LoaderDef, "id">,
    tokens: readonly string[],
    bytes: number,
  ): Promise<boolean> {
    const approvals = Object.entries(this.approved)
      .filter(([id]) => id.startsWith(`${loader.id}:`))
      .sort(([a], [b]) => (a < b ? -1 : 1));
    if (approvals.length === 0) return false;
    this.scopes ??= this.load(Object.keys(this.approved));
    const scopes = await this.scopes;
    for (const [id, approved] of approvals) {
      const scope = scopes.get(id);
      const left = approved - (this.spent.get(id) ?? 0);
      if (!scope || bytes > left || !tokens.every((t) => scope.has(t))) continue;
      this.spent.set(id, (this.spent.get(id) ?? 0) + bytes);
      return true;
    }
    return false;
  }

  /** Keeps what a gate covers where a resumed run finds it: for an hour, a person's time. */
  async remember(gate: string, tokens: readonly string[]): Promise<void> {
    const answer: CachedAnswer = { kind: "found", value: [...tokens].sort() };
    await this.cache.setMany([{ key: scopeKey(gate), answer, retention: "hour" }]);
  }

  private async load(ids: readonly string[]): Promise<Map<string, ReadonlySet<string>>> {
    const stored = await this.cache.getMany(ids.map(scopeKey));
    const scopes = new Map<string, ReadonlySet<string>>();
    for (const id of ids) {
      const entry = stored.get(scopeKey(id));
      const tokens = entry?.kind === "found" ? entry.value : undefined;
      // an entry the run did not write is no scope
      if (Array.isArray(tokens) && tokens.every((t) => typeof t === "string"))
        scopes.set(id, new Set(tokens));
    }
    return scopes;
  }
}

/** The gates a run stopped at, each once. */
export class Gates {
  private readonly byId = new Map<string, Gate>();

  /** True when the gate is new to the run. */
  add(gate: Gate): boolean {
    if (this.byId.has(gate.id)) return false;
    this.byId.set(gate.id, gate);
    return true;
  }

  list(): Gate[] {
    return [...this.byId.values()];
  }
}
