// Caps (DESIGN.md §5.8): bounds the application sets on what a run follows, so that a key with a
// million tracks, or a request with a million rows, costs what the application allows and no
// more. Three of them, each a whole number from 1:
// - refs: the most refs one step reads. The step's refs are taken in key order and those past the
//   cap are not read: they are cut, never absent.
// - links: the most links one ref follows through a relation (its fan-out), the run's or the
//   relation's own, the smaller. The ref keeps the first links, in the order the strategies gave
//   them, and is cut.
// - rows: the most rows one ref gets from a provider, the run's or the provider's own, the
//   smaller. The ref keeps the first rows, and is cut.
//
// A cap counts per step, not across the run: steps on separate branches run side by side, and a
// count shared between them would make which ref is cut depend on which branch ran first.

import { type Cut, DefinitionError } from "../core/index.ts";
import { recordOf, type StepRecord, say } from "./ledger.ts";
import type { RefNode } from "./refs.ts";
import type { StepContext } from "./step.ts";
import type { Caps } from "./types.ts";

/** The run's caps, refused when one is not a whole number from 1. */
export function runCaps(caps: Caps = {}): Caps {
  for (const [name, cap] of Object.entries(caps))
    if (cap !== undefined && !(Number.isInteger(cap) && cap >= 1))
      throw new DefinitionError("HG_SPEC", `caps.${name} must be a whole number from 1`);
  return caps;
}

/** The smaller of two caps, either of which may be missing. */
export function tighter(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined ? b : b === undefined ? a : Math.min(a, b);
}

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** What a step records of the refs past its cap: a row step each, unknown and cut, and their count
 *  in its trace, as if they had come in and nothing had been read. */
export function notRead(
  ctx: StepContext,
  step: string,
  loader: string,
  past: readonly { readonly ref: RefNode; readonly cut: Cut }[],
): { readonly ref: RefNode; readonly cut: Cut; readonly record: StepRecord }[] {
  const records = past.map(({ ref, cut }) => ({
    ref,
    cut,
    record: recordOf(step, loader, ref, say.capped(cut)),
  }));
  if (records.length > 0)
    ctx.trace.record(
      step,
      loader,
      { ...NOTHING_READ, keysIn: records.length },
      records.map((r) => r.record),
    );
  return records;
}

const NOTHING_READ = { keysIn: 0, cached: 0, billedBytes: 0, ms: 0, retries: 0, errors: [] };

/** The cut a ref meets at a cap. */
export function capped(cap: "refs" | "links" | "rows", limit: number): Cut {
  return { kind: "capped", cap, limit };
}

/** A step's refs within the cap, in the order of their key ids (refs of one key by the values
 *  they carry), and those past it with the cut they met. */
export function withinRefs(
  refs: readonly RefNode[],
  limit: number | undefined,
): {
  readonly read: readonly RefNode[];
  readonly past: readonly { readonly ref: RefNode; readonly cut: Cut }[];
} {
  if (limit === undefined || refs.length <= limit) return { read: refs, past: [] };
  const ordered = [...refs].sort((a, b) => compare(a.keyId, b.keyId) || compare(a.id, b.id));
  const cut = capped("refs", limit);
  return { read: ordered.slice(0, limit), past: ordered.slice(limit).map((ref) => ({ ref, cut })) };
}
