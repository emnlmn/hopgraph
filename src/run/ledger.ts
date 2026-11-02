// What the evaluation leaves for the walk and the attribution (DESIGN.md §5.5): per step and ref,
// what it said, the links a relation found, the rows a provider projected. Keys stay ids here; they
// are shown, a personal one by its digest, only when a row result is built.

import type { Attrs, Coverage, Cut, UnknownReason } from "../core/index.ts";
import type { KeyAnswer } from "./envelope.ts";
import type { RefId, RefNode } from "./refs.ts";
import { absentTally, cutOff, foundTally, type Tally, unknownTally } from "./tally.ts";

/** What one step said about one ref. */
export type Said =
  | { readonly outcome: "found"; readonly cuts?: readonly Cut[]; readonly coverage?: Coverage }
  | { readonly outcome: "absent"; readonly cuts?: readonly Cut[]; readonly coverage?: Coverage }
  | { readonly outcome: "unknown"; readonly reason: UnknownReason }
  /** not read: the ref was past a cap of the run (caps.ts) */
  | { readonly outcome: "unknown"; readonly reason?: undefined; readonly cuts: readonly Cut[] };

const extras = (cuts: readonly Cut[] = [], coverage?: Coverage) => ({
  ...(cuts.length > 0 && { cuts }),
  ...(coverage && { coverage }),
});

export const say = {
  found: (cuts?: readonly Cut[], coverage?: Coverage): Said => ({
    outcome: "found",
    ...extras(cuts, coverage),
  }),
  absent: (coverage?: Coverage, cuts?: readonly Cut[]): Said => ({
    outcome: "absent",
    ...extras(cuts, coverage),
  }),
  unknown: (reason: UnknownReason): Said => ({ outcome: "unknown", reason }),
  unmet: (needs: readonly string[]): Said => ({
    outcome: "unknown",
    reason: { reason: "unmet", needs },
  }),
  capped: (cut: Cut): Said => ({ outcome: "unknown", cuts: [cut] }),
};

/** A loader's answer for a key, as the step that read it says it. */
export function saidOf(answer: KeyAnswer): Said {
  if (answer.kind === "found") return say.found(answer.cuts, answer.coverage);
  if (answer.kind === "absent") return say.absent(answer.coverage);
  return say.unknown(answer.reason);
}

export function tallyOf(said: Said): Tally {
  if (said.outcome === "found") return foundTally(said.cuts);
  if (said.outcome === "absent") return absentTally(said.coverage, said.cuts);
  return said.reason ? unknownTally(said.reason) : cutOff(...said.cuts);
}

/** A row step (types.ts RowStep) whose ref is not shown yet. */
export type StepRecord = Said & {
  readonly step: string;
  readonly loader: string;
  readonly ref: RefId;
  /** relation strategies: the links the projection produced, before verification */
  readonly links?: number;
};

export function recordOf(
  step: string,
  loader: string,
  ref: RefId,
  said: Said,
  links?: number,
): StepRecord {
  return { ...said, step, loader, ref, ...(links === undefined ? {} : { links }) };
}

export interface Link {
  readonly relation: string;
  /** the loader of the strategy that produced it */
  readonly strategy: string;
  readonly from: RefNode;
  readonly to: RefNode;
  readonly attrs: Attrs;
  /** a verification could not decide it: it stays, and what is read through it says so */
  readonly ambiguous: boolean;
}

/** A relation's answer for one ref: its strategies combined, after verification. */
export interface RelationResult {
  readonly links: readonly Link[];
  readonly tally: Tally;
  /** one per strategy that ran, then the verification of its candidates */
  readonly steps: readonly StepRecord[];
}

/** A provider's answer for one ref. */
export interface ProviderAnswer {
  /** raw and derived fields, in the projection's order */
  readonly rows: readonly Attrs[];
  readonly tally: Tally;
  readonly steps: readonly StepRecord[];
}

/** Read access to what was evaluated. Asking for a step the run did not evaluate is a bug. */
export interface Ledger {
  relation(relation: string, ref: RefNode): RelationResult;
  provider(provider: string, ref: RefNode): ProviderAnswer;
  /** the hydration of the ref's key, when it was hydrated */
  hydration(ref: RefId): StepRecord | undefined;
}
