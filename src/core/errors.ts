// The errors Hopgraph throws (DESIGN.md §5.4). One base class with a stable `code`, so a caller
// switches on the code and never parses a message, and every message starts with "hopgraph: ". A
// message holds no key, no value and no source's error message: a base row is named by its row id,
// a gate by its id, a failure by its class and code.
//
// A load that fails is not an error of the run: its keys are `unknown: failed` and the failure is
// data in the trace (`LoadError`). What is here rejects a declaration or a whole run.

/** A declaration the builder, the plan or `checkGraph` refuses. */
export type DefinitionCode =
  /** a name that is not a declared entity */
  | "HG_UNKNOWN_ENTITY"
  /** a provider id that is not declared */
  | "HG_UNKNOWN_PROVIDER"
  /** a route names a relation that is not declared */
  | "HG_UNKNOWN_RELATION"
  /** a loader, relation, provider, route or hydrator declared twice; a key a read is given twice
   *  with different carried attributes */
  | "HG_DUPLICATE"
  /** a loader, provider or route declared on another graph */
  | "HG_FOREIGN"
  /** a loader keyed by another entity than its place needs (hydrator, strategy, verification) */
  | "HG_KEYED_BY"
  /** a declaration that contradicts itself: metered without price, merge with hints, a retry
   *  policy that cannot be followed, no strategy, strategies without combine, a derived field on a
   *  non-raw input or a raw name, an empty path or union, a union of paths with different ends */
  | "HG_SPEC"
  /** a route's path does not chain or does not end at the provider's entity (`itself` for a
   *  provider keyed by another entity) */
  | "HG_PATH"
  /** a (base, provider) pair with no route */
  | "HG_NO_ROUTE"
  /** requested routes that order two relations both ways */
  | "HG_CYCLE"
  /** checkGraph: a route from an entity that is not among the bases */
  | "HG_NOT_A_BASE"
  /** checkGraph: a loader nothing uses */
  | "HG_UNUSED_LOADER"
  /** checkGraph: an entity whose needed attributes have no hydrator */
  | "HG_NO_HYDRATOR";

/** Every code a `HopgraphError` may have. A caller switches on the code; the words may change. */
export type HopgraphCode =
  | DefinitionCode
  /** a value does not match its schema (base rows: `ValidationError`; a link or a hydration:
   *  the trace's failure code of the keys it failed) */
  | "HG_INVALID"
  /** an approved gate priced higher on resume */
  | "HG_COST_CHANGED"
  /** what a load's signal says when the run aborted it on its own: deadline or failure */
  | "HG_ABORTED"
  /** an invariant of the executor broke: a bug in Hopgraph */
  | "HG_INTERNAL";

/** Every error the library throws: a stable `code`, and a message that starts with `hopgraph: `
 *  and holds no key, value or source message. */
export class HopgraphError extends Error {
  /** the class's name, also on a subclass */
  override name = "HopgraphError";
  /** what went wrong, stable across versions */
  readonly code: HopgraphCode;

  constructor(code: HopgraphCode, message: string, options?: { readonly cause?: unknown }) {
    super(`hopgraph: ${message}`, options);
    this.code = code;
  }
}

/** The builder, the plan of a run, or `checkGraph` refuses the declared graph. */
export class DefinitionError extends HopgraphError {
  /** "DefinitionError" */
  override name = "DefinitionError";
  /** what the declaration does wrong */
  declare readonly code: DefinitionCode;

  constructor(code: DefinitionCode, message: string) {
    super(code, message);
  }
}

/** One part of a base row that does not match its entity's schemas: `key`, or `carries.<name>`
 *  (an attribute the entity does not declare is refused too). */
export interface InvalidRow {
  /** the base row's id, as the caller gave it */
  readonly row: string;
  /** the entity the row said it is of */
  readonly entity: string;
  /** `key`, or `carries.<attribute>` */
  readonly field: string;
}

/** Base rows the run refused before reading anything. Named by row id and field, never by value:
 *  a schema's own issue messages may quote the value, so they are not kept. */
export class ValidationError extends HopgraphError {
  /** "ValidationError" */
  override name = "ValidationError";
  /** `HG_INVALID` */
  declare readonly code: "HG_INVALID";

  constructor(
    /** every part of every base row that did not match, in the order of the rows */
    readonly rows: readonly InvalidRow[],
  ) {
    const ids = [...new Set(rows.map((r) => r.row))];
    const shown = rows.slice(0, 5).map((r) => `"${r.row}" (${r.entity} ${r.field})`);
    const more = rows.length > shown.length ? `, and ${rows.length - shown.length} more` : "";
    super(
      "HG_INVALID",
      `${ids.length} base row${ids.length === 1 ? "" : "s"} do not match their entity's schemas: ` +
        `${shown.join(", ")}${more}`,
    );
  }
}

/** One approval a resumed run refused: the gate, what was approved, what it is priced at now. */
export interface RefusedGate {
  /** the gate's id, as the run that stopped at it gave it */
  readonly gate: string;
  /** the bytes approved for it */
  readonly approved: number;
  /** the bytes it is priced at now, more than approved */
  readonly priced: number;
}

/**
 * Gated reads priced again on resume cost more than was approved: nothing of them is billed.
 * `gates` lists every gate the run refused, by gate id, so that they can all be approved again in
 * one round; `gate`, `approved` and `priced` are the first of them.
 */
export class CostChangedError extends HopgraphError {
  /** "CostChangedError" */
  override name = "CostChangedError";
  /** `HG_COST_CHANGED` */
  declare readonly code: "HG_COST_CHANGED";
  /** every gate the run refused, by gate id */
  readonly gates: readonly RefusedGate[];

  constructor(
    /** the first refused gate's id */
    readonly gate: string,
    /** the bytes approved for the first refused gate */
    readonly approved: number,
    /** the bytes the first refused gate is priced at now */
    readonly priced: number,
    gates?: readonly RefusedGate[],
  ) {
    const all = gates ?? [{ gate, approved, priced }];
    const more =
      all.length > 1 ? `, and ${all.length - 1} more gate${all.length > 2 ? "s" : ""}` : "";
    super("HG_COST_CHANGED", `gate ${gate}: approved ${approved} bytes, priced ${priced}${more}`);
    this.gates = all;
  }
}

/**
 * The reason on a load's or a dry run's signal when the run aborted it on its own: its deadline
 * passed, or the run failed (`cause` is what failed it). When the caller's own signal aborts, the
 * loads see the caller's reason instead, and the run rejects with it, as `fetch` does.
 */
export class AbortedError extends HopgraphError {
  /** "AbortedError" */
  override name = "AbortedError";
  /** `HG_ABORTED` */
  declare readonly code: "HG_ABORTED";

  constructor(
    /** `deadline`: the run passed its deadline; `failed`: the run failed */
    readonly why: "deadline" | "failed",
    options?: { readonly cause?: unknown },
  ) {
    super(
      "HG_ABORTED",
      why === "deadline" ? "the run passed its deadline" : "the run failed",
      options,
    );
  }
}
