// How the answers of several branches make one (DESIGN.md §3.3, §3.4). A branch is a strategy of a
// relation, a target a link fans out to, or a path of a route. Each is found, absent within a
// coverage, or unknown with a reason, and may have met a cut. One rule turns merged branches into
// an outcome: found if any branch found; absent only if every branch ran to the end, uncut, and
// found nothing; unknown otherwise.

import type { Coverage, Cut, UnknownReason } from "../core/index.ts";
import { stableJson } from "./ids.ts";
import type { RowStep } from "./types.ts";

export interface Tally {
  readonly found: boolean;
  /** why a branch could not be read: on a found answer too, when another branch was not read */
  readonly unknown: readonly UnknownReason[];
  /** caps and truncations met on the way: an empty answer under a cut is not an absence */
  readonly cut: readonly Cut[];
  /** what the absent branches searched */
  readonly coverage: readonly Coverage[];
}

const NOTHING: Tally = { found: false, unknown: [], cut: [], coverage: [] };

export const foundTally = (cuts: readonly Cut[] = []): Tally => ({
  ...NOTHING,
  found: true,
  cut: cuts,
});

export const absentTally = (coverage?: Coverage, cuts: readonly Cut[] = []): Tally => ({
  ...NOTHING,
  coverage: coverage ? [coverage] : [],
  cut: cuts,
});

export const unknownTally = (reason: UnknownReason): Tally => ({ ...NOTHING, unknown: [reason] });

export function outcomeOf(tally: Tally): RowStep["outcome"] {
  if (tally.found) return "found";
  return tally.unknown.length > 0 || tally.cut.length > 0 ? "unknown" : "absent";
}

/** Every branch ran: found if one found, and what the others could not read stays listed. */
export function union(branches: readonly Tally[]): Tally {
  return {
    found: branches.some((b) => b.found),
    unknown: distinct(branches.flatMap((b) => b.unknown)),
    cut: distinct(branches.flatMap((b) => b.cut)),
    coverage: distinct(branches.flatMap((b) => b.coverage)),
  };
}

/**
 * Branch n + 1 ran only where branch n fell through. The branch that found is the answer, and what
 * kept the branches before it from being read whole stays beside it: the reasons of those that
 * could not be read, the cuts of those that read under one and found nothing. One of them might
 * have led elsewhere, so whatever is read through the answer is never absent (the walk unions them
 * into what lies below). Branches before it that read the whole and found nothing add nothing.
 * When none found, every branch counts.
 */
export function fallback(branches: readonly Tally[]): Tally {
  const at = branches.findIndex((b) => b.found);
  const answer = branches[at];
  if (!answer) return union(branches);
  const before = branches.slice(0, at);
  const unread = before.flatMap((b) => b.unknown);
  const cut = before.flatMap((b) => b.cut);
  if (unread.length === 0 && cut.length === 0) return answer;
  return {
    ...answer,
    unknown: distinct([...unread, ...answer.unknown]),
    cut: distinct([...cut, ...answer.cut]),
  };
}

/**
 * Whether the next fallback branch runs after this one: not when it found, and not while it waits
 * for an approval, since the next branch depends on its answer and the approval may make it
 * unnecessary.
 */
export function fallsThrough(tally: Tally): boolean {
  return !tally.found && !tally.unknown.some((r) => r.reason === "awaiting_approval");
}

/** A branch not followed past a cap: cut, so never absent. */
export const cutOff = (...cuts: readonly Cut[]): Tally => ({ ...NOTHING, cut: cuts });

/** The same tally with one more cut. */
export function cutting(tally: Tally, cut: Cut): Tally {
  return { ...tally, cut: distinct([...tally.cut, cut]) };
}

/** The same tally with one more reason. */
export function noting(tally: Tally, reason: UnknownReason): Tally {
  return { ...tally, unknown: distinct([...tally.unknown, reason]) };
}

function distinct<T>(items: readonly T[]): T[] {
  const byText = new Map<string, T>();
  for (const item of items) {
    const text = stableJson(item);
    if (!byText.has(text)) byText.set(text, item);
  }
  return [...byText.values()];
}
