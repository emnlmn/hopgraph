// What a read says about each key (DESIGN.md §3.1, §3.4): found, absent within a coverage, or
// unknown with a reason. "Not found" and "not read" never share a value.

/** What was searched when nothing was found: a window, a look-back. Words for the trace and the
 *  UI. */
export interface Coverage {
  /** what was searched, in the application's words ("tracks, last 6 months") */
  readonly label: string;
  /** how many days were searched */
  readonly days?: number;
  /** the first day searched, an ISO date, inclusive */
  readonly from?: string;
  /** the last day searched, an ISO date, inclusive */
  readonly to?: string;
}

/** A found value that is not the whole answer. */
export type Cut =
  /** a per-ref cap inside the query (`QUALIFY ROW_NUMBER() <= limit`) */
  | { readonly kind: "cap"; readonly limit: number }
  /** fewer days read than asked */
  | { readonly kind: "days"; readonly days: number }
  /** the statement's LIMIT was reached: rows past it exist and were not read */
  | { readonly kind: "truncated"; readonly limit: number }
  /** a `oneOf` loader answered from some of its sources; these were unread or failed */
  | { readonly kind: "sources"; readonly missing: readonly string[] }
  /** a cap the run or the graph set (`caps`) was reached: past `limit` refs read by one step,
   *  links of one ref, or rows of one ref, the rest was not followed */
  | { readonly kind: "capped"; readonly cap: "refs" | "links" | "rows"; readonly limit: number };

/** Why a source was not read at all for this viewer or deployment. */
export type Unread = "disabled" | "forbidden" | "not_configured";

/** Why a key or a branch was not read: the reason of an `unknown` outcome. */
export type UnknownReason =
  | { readonly reason: "unread"; readonly why: Unread; readonly connectors: readonly string[] }
  /** the source failed; `why: "open"` when it was not called because the circuit of these
   *  `connectors` is open after their failures (`RunOptions.health`) */
  | {
      readonly reason: "failed";
      readonly why?: "open";
      readonly connectors?: readonly string[];
    }
  | { readonly reason: "too_heavy"; readonly bytes: number }
  | { readonly reason: "awaiting_approval"; readonly bytes: number }
  | { readonly reason: "deadline" }
  /** a need of the strategy or loader was itself unknown (its hydration was not read) */
  | { readonly reason: "unmet"; readonly needs: readonly string[] }
  /** a verification could not decide between candidates, or a relation that says one target
   *  (`1:1`, `N:1`) found two */
  | { readonly reason: "ambiguous" };

/**
 * Why a load could not read a key: its source failed it, or the load knows the source is not
 * readable for this caller. The other reasons are the run's to give: a load that claimed one
 * (an approval awaited, a deadline) would stop a fallback at a gate nobody can approve. A run reads
 * any other reason an envelope gives as `failed`.
 */
export type LoadReason =
  | { readonly reason: "failed" }
  | { readonly reason: "unread"; readonly why: Unread; readonly connectors: readonly string[] };

/** A failure of a load, for the trace: a class or a code, never a driver's message (it may
 *  contain the values it read). A load reports its failed statements with a code of its own; for
 *  a load or a dry run that threw, the executor keeps the error's own `code` (`ECONNRESET`) with
 *  its class beside it, or its class alone when it has no code. Codes the executor itself reports
 *  start with `HG_`. */
export interface LoadError {
  /** a short identifier: the statement's or the error's own code, or the error's class */
  readonly code: string;
  /** the class of a thrown error that had a code of its own */
  readonly class?: string;
  /** how many keys it took with it */
  readonly keys: number;
}

/**
 * What one `load` returns, per key and per call. A load never throws for a key it could not read:
 * it reports it. Every key it was given appears in exactly one of `values`, `absent`, `unknown`;
 * a key in `values` may also appear in `cut`, more than once (1000 events and 7 days of 30).
 */
export interface Envelope<K, V> {
  /** the keys found, each with its value */
  readonly values: ReadonlyArray<readonly [K, V]>;
  /** the keys searched to the end and not there */
  readonly absent: readonly K[];
  /** the keys not read, each with why (`{ reason: "failed" }` for a failed statement's) */
  readonly unknown: ReadonlyArray<readonly [K, LoadReason]>;
  /** the found keys whose value is not the whole answer, each with how it was cut */
  readonly cut: ReadonlyArray<readonly [K, Cut]>;
  /** what was searched, per key, when it depends on the key (a look-back escalated to 180 days):
   *  for found keys as for absent ones */
  readonly coverage?: ReadonlyArray<readonly [K, Coverage]>;
  /** what the call billed its source, in bytes; 0 for a free source */
  readonly billedBytes: number;
  /** the call's failed statements, by code and the keys each took; never a driver's message */
  readonly errors: readonly LoadError[];
}

/** How long a key's answer is kept: the application maps these to durations (cache port). An
 *  unknown is never kept. `hour`: an answer that cannot change before the source's next load (a
 *  table loaded at night found nothing) but may then. */
export type Retention = "day" | "hour" | "brief" | "none";

/** What `keep` decides on: found (maybe cut) or absent. Not the value: retention never depends on
 *  it, and leaving it out keeps the loader's value type inferred from `load` alone. */
export type Kept =
  | { readonly found: true; readonly absent: false; readonly cut?: Cut }
  | { readonly found: false; readonly absent: true };

/** The bytes a metered load may bill: what is left of its wave's budget (the priced or approved
 *  bytes, less what the wave's calls before it billed). Free loaders get `undefined`. */
export interface Budget {
  /** the most this call may bill: hand it to the source as its byte limit */
  readonly maxBytes: number | undefined;
}

/** One key's answer, as a load decides it: `envelope` gathers them. A found key may carry several
 *  cuts (in the order a retention reads them: the first decides) and what it searched. */
export type Answer<V> =
  | {
      readonly kind: "found";
      readonly value: V;
      readonly cuts?: readonly Cut[];
      readonly coverage?: Coverage;
    }
  | { readonly kind: "absent"; readonly coverage?: Coverage }
  | { readonly kind: "unknown"; readonly reason: LoadReason };

/** A key's value was read: its cuts, when the read stopped short of the whole answer (a cap, fewer
 *  days than asked), in the order a retention reads them; what it searched, when it depends on the
 *  key. Typed by its value, so that `envelope` infers the loader's value type. */
export function found<V>(
  value: V,
  extras: { readonly cuts?: readonly Cut[]; readonly coverage?: Coverage } = {},
): Answer<V> {
  const { cuts, coverage } = extras;
  return {
    kind: "found",
    value,
    ...(cuts && cuts.length > 0 ? { cuts } : {}),
    ...(coverage ? { coverage } : {}),
  };
}

/** A key searched to the end and not there, within what was searched (a window, a look-back). */
export function absent(coverage?: Coverage): Answer<never> {
  return coverage ? { kind: "absent", coverage } : { kind: "absent" };
}

/** A key that was not read, and why: `{ reason: "failed" }` for a source that failed it. */
export function unknown(reason: LoadReason): Answer<never> {
  return { kind: "unknown", reason };
}

/**
 * The envelope of per-key answers, each key once, its cuts and coverage beside it. Built from
 * `found`, `absent` and `unknown`, its value type is the loader's:
 *
 *   envelope(refs.map((r) => {
 *     const row = rows.get(r.key);
 *     return [r.key, row ? found(row) : absent()];
 *   }));
 */
export function envelope<K, V>(
  answers: Iterable<readonly [K, Answer<V>]>,
  billedBytes = 0,
  errors: readonly LoadError[] = [],
): Envelope<K, V> {
  const values: (readonly [K, V])[] = [];
  const absent: K[] = [];
  const unknown: (readonly [K, LoadReason])[] = [];
  const cut: (readonly [K, Cut])[] = [];
  const coverage: (readonly [K, Coverage])[] = [];
  for (const [key, a] of answers) {
    if (a.kind === "unknown") {
      unknown.push([key, a.reason]);
      continue;
    }
    if (a.kind === "found") {
      values.push([key, a.value]);
      for (const c of a.cuts ?? []) cut.push([key, c]);
    } else absent.push(key);
    if (a.coverage) coverage.push([key, a.coverage]);
  }
  return {
    values,
    absent,
    unknown,
    cut,
    ...(coverage.length > 0 ? { coverage } : {}),
    billedBytes,
    errors,
  };
}
