// What a read says per key (DESIGN.md §3.1, §3.4): found (maybe cut, maybe with what was searched),
// absent within what was searched, or unknown with a reason. How one load call's envelope becomes
// those answers, and what of them the cache keeps.

import type {
  Coverage,
  Cut,
  Envelope,
  Kept,
  LoadError,
  Retention,
  UnknownReason,
  Unread,
} from "../core/index.ts";
import type { CachedAnswer } from "./types.ts";

/** A key's answer as the run keeps it: a load's `Answer`, its cuts always a list. */
export type KeyAnswer =
  | {
      readonly kind: "found";
      readonly value: unknown;
      readonly cuts: readonly Cut[];
      readonly coverage?: Coverage;
    }
  | { readonly kind: "absent"; readonly coverage?: Coverage }
  | { readonly kind: "unknown"; readonly reason: UnknownReason };

export const FAILED: KeyAnswer = { kind: "unknown", reason: { reason: "failed" } };
export const DEADLINE: KeyAnswer = { kind: "unknown", reason: { reason: "deadline" } };

/**
 * The answer per key id the call was asked for (a call never holds one key twice). A call that
 * threw (`undefined`), or that reported a failed statement under `partial: "drop"`, fails every key
 * it was asked for. A key the envelope does not mention failed too: a load reports every key, so
 * silence is not an absence.
 */
export function answersOf(
  asked: readonly string[],
  idOf: (key: unknown) => string,
  envelope: Envelope<unknown, unknown> | undefined,
  partial: "keep" | "drop",
): Map<string, KeyAnswer> {
  const answers = new Map<string, KeyAnswer>();
  if (envelope && !(partial === "drop" && envelope.errors.length > 0)) {
    const wanted = new Set(asked);
    const put = (key: unknown, answer: KeyAnswer) => {
      const id = idOf(key);
      if (wanted.has(id) && !answers.has(id)) answers.set(id, answer);
    };
    const cuts = new Map<string, Cut[]>();
    for (const [key, cut] of envelope.cut)
      cuts.set(idOf(key), [...(cuts.get(idOf(key)) ?? []), cut]);
    const searched = new Map((envelope.coverage ?? []).map(([key, c]) => [idOf(key), c]));
    const coverageOf = (key: unknown) => {
      const coverage = searched.get(idOf(key));
      return coverage ? { coverage } : {};
    };
    for (const [key, value] of envelope.values)
      put(key, { kind: "found", value, cuts: cuts.get(idOf(key)) ?? [], ...coverageOf(key) });
    for (const [key, reason] of envelope.unknown)
      put(key, { kind: "unknown", reason: loadReason(reason) });
    for (const key of envelope.absent) put(key, { kind: "absent", ...coverageOf(key) });
  }
  for (const id of asked) if (!answers.has(id)) answers.set(id, FAILED);
  return answers;
}

/**
 * A reason a load gave, as the run takes it: `unread` with its why and connectors, else `failed`.
 * The types allow no other; one that comes all the same (from plain JavaScript, through a cast) is
 * not trusted: a load that claimed an approval awaited would stop a fallback at a gate nobody can
 * approve.
 */
function loadReason(given: unknown): UnknownReason {
  const r = (given ?? {}) as { reason?: unknown; why?: unknown; connectors?: unknown };
  const why = r.why === "disabled" || r.why === "forbidden" || r.why === "not_configured";
  const named = Array.isArray(r.connectors) && r.connectors.every((c) => typeof c === "string");
  return r.reason === "unread" && why && named
    ? { reason: "unread", why: r.why as Unread, connectors: r.connectors as string[] }
    : { reason: "failed" };
}

/**
 * What a strict run (validate.ts) finds wrong with an envelope: keys it names that the call did not
 * ask, keys it puts in two buckets (or twice in one), keys it does not mention. A key in two
 * buckets is failed instead of trusted (`conflicted`); one not mentioned is failed in any run. Each
 * finding is a failure code for the trace, counting the keys it concerns.
 */
export function audit(
  asked: readonly string[],
  idOf: (key: unknown) => string,
  envelope: Envelope<unknown, unknown>,
): { readonly conflicted: ReadonlySet<string>; readonly errors: readonly LoadError[] } {
  const wanted = new Set(asked);
  const mentions = new Map<string, number>();
  const unasked = new Set<string>();
  const named = (key: unknown) => {
    const id = idOf(key);
    if (!wanted.has(id)) unasked.add(id);
    return id;
  };
  for (const key of [
    ...envelope.values.map(([k]) => k),
    ...envelope.absent,
    ...envelope.unknown.map(([k]) => k),
  ]) {
    const id = named(key);
    if (wanted.has(id)) mentions.set(id, (mentions.get(id) ?? 0) + 1);
  }
  for (const [key] of [...envelope.cut, ...(envelope.coverage ?? [])]) named(key);
  const conflicted = new Set([...mentions].filter(([, n]) => n > 1).map(([id]) => id));
  const missing = asked.filter((id) => !mentions.has(id)).length;
  const errors: LoadError[] = [];
  if (unasked.size > 0) errors.push({ code: "HG_ENVELOPE_UNASKED", keys: unasked.size });
  if (conflicted.size > 0) errors.push({ code: "HG_ENVELOPE_CONFLICT", keys: conflicted.size });
  if (missing > 0) errors.push({ code: "HG_ENVELOPE_MISSING", keys: missing });
  return { conflicted, errors };
}

export function fromCache(answer: CachedAnswer): KeyAnswer {
  const coverage = answer.coverage ? { coverage: answer.coverage } : {};
  if (answer.kind === "absent") return { kind: "absent", ...coverage };
  return { kind: "found", value: answer.value, cuts: answer.cuts ?? [], ...coverage };
}

/** What the cache keeps of an answer, and for how long: never an unknown, nothing on "none". */
export function keepable(
  answer: KeyAnswer,
  keep: (kept: Kept) => Retention,
): { readonly answer: CachedAnswer; readonly retention: Exclude<Retention, "none"> } | undefined {
  if (answer.kind === "unknown") return undefined;
  const coverage = answer.coverage ? { coverage: answer.coverage } : {};
  if (answer.kind === "absent") {
    const retention = keep({ found: false, absent: true });
    return retention === "none"
      ? undefined
      : { answer: { kind: "absent", ...coverage }, retention };
  }
  const [first] = answer.cuts;
  // `Kept` shows one cut: the first is enough for a retention to tell a whole answer from a cut one
  const retention = keep(
    first ? { found: true, absent: false, cut: first } : { found: true, absent: false },
  );
  if (retention === "none") return undefined;
  const cuts = answer.cuts.length > 0 ? { cuts: answer.cuts } : {};
  return { answer: { kind: "found", value: answer.value, ...cuts, ...coverage }, retention };
}
