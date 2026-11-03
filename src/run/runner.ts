// A runner (README, "The runner"; DESIGN.md §5.9): a graph and what holds for the process, given
// once at startup, then at each call site what holds for that call. `run(call)` is `run(graph,
// options)` with the env's options; `read(entity, keys, providers)` makes the base rows from keys of
// one entity, one row per key, and gives back the result with each row under its key's id.
//
// Which options a call gives is the split of `RunEnv` and `RunCall` (types.ts). Where both give one,
// the call narrows the env and never widens it: a connector is readable when both say so, and the
// smaller cap wins. Every option is taken from its own side by name, so a call object that carries
// an env option (through a spread, a cast, plain JavaScript) never replaces the env's: the cache,
// the health and the loads in flight are the process's.

import {
  type AnyRoute,
  DefinitionError,
  type Entities,
  type Graph,
  type GraphDef,
  type Unread,
} from "../core/index.ts";
import { gateScopes } from "./cache.ts";
import { runCaps, tighter } from "./caps.ts";
import { type RowNaming, run, runWith } from "./executor.ts";
import { flightsOf } from "./flights.ts";
import { healthOf } from "./health.ts";
import { runLimits } from "./limits.ts";
import { plan } from "./plan.ts";
import type {
  BaseRef,
  Caps,
  ProviderRef,
  ReadCall,
  RunCall,
  RunEnv,
  Runner,
  RunOptions,
  RunResult,
} from "./types.ts";

/**
 * A runner over `graph` with what holds for the process: create it once at startup, then `read` or
 * `run` at each call site. An env the run would refuse (caps or limits that are not whole numbers
 * from 1, a health or an inflight object not made by `createHealth` or `createInflight`) is refused
 * here, with a `DefinitionError`, rather than at the first call. Given no cache, the runner keeps
 * the scopes of the gates its runs stop at, and nothing else, so that an approval still covers a
 * part of its keys on resume.
 */
export function createRunner<E extends Entities, Ctx, Meta, R extends AnyRoute>(
  graph: Graph<E, Ctx, Meta, R>,
  env: RunEnv = {},
): Runner<E, Ctx, R> {
  runCaps(env.caps);
  runLimits(env.limits);
  healthOf(env.health);
  flightsOf(env.inflight);
  const held: RunEnv = { ...env, cache: env.cache ?? gateScopes(env.clock ?? Date.now) };
  // the graph read without its types: the runner's own signatures carry them
  const def: GraphDef<Meta> = graph;

  const runOne = async (call: RunCall<unknown, readonly ProviderRef[]>): Promise<RunResult> =>
    run(def, optionsOf(held, call));

  const read = async (
    entity: string,
    keys: unknown,
    providers: readonly ProviderRef[],
    call: ReadCall<unknown> = {},
  ): Promise<RunResult> => {
    const known = Object.hasOwn(def.entities, entity) ? def.entities[entity] : undefined;
    // an entity with context attributes takes `{ key, carries }`: only the base row brings them
    const withCarries = (known?.context.length ?? 0) > 0;
    const refs = (Array.isArray(keys) ? keys : [keys]).map((given: unknown, i): BaseRef => {
      const { key, carries } = withCarries
        ? (given as { readonly key: unknown; readonly carries?: BaseRef["carries"] })
        : { key: given, carries: undefined };
      // a row is named by its place, so that an error naming it never holds the key
      return { row: `keys[${i}]`, entity, key, ...(carries === undefined ? {} : { carries }) };
    });
    // with no key the run would plan no route from the entity: refused all the same
    if (refs.length === 0) plan(def, [entity], providers.map(providerId));
    // each row under its key's id, as the caller looks it up: the id of the key as the run parsed
    // it (the key given, with validation off)
    return runWith(def, optionsOf(held, { ...call, refs, providers }), "plan", byKeyId());
  };

  // the implementations read erased types; `Runner<E, Ctx, R>` gives each call site the graph's
  return { run: runOne, read } as unknown as Runner<E, Ctx, R>;
}

const providerId = (provider: ProviderRef): string =>
  typeof provider === "string" ? provider : provider.id;

/**
 * How `read` names its rows: by their keys' ids. Keys of one id that bring different carried
 * attributes are two refs, both read, and would be one row: refused, by their places, before
 * anything is read.
 */
function byKeyId(): RowNaming {
  const first = new Map<string, { readonly row: string; readonly ref: string }>();
  return (row, ref) => {
    const seen = first.get(ref.keyId);
    if (!seen) first.set(ref.keyId, { row, ref: ref.id });
    else if (seen.ref !== ref.id)
      throw new DefinitionError(
        "HG_DUPLICATE",
        `read: ${seen.row} and ${row} are one key with different carried attributes`,
      );
    return ref.keyId;
  };
}

/** One call's options: the call's own, the env's, and the two a call narrows. Each is named on the
 *  side it belongs to, and `satisfies` makes a new option be placed here. */
function optionsOf(
  env: RunEnv,
  call: RunCall<unknown, readonly ProviderRef[]>,
): RunOptions<unknown, readonly ProviderRef[]> {
  const { refs, providers, ctx, restriction, approved, prices, deadline, signal, validate } = call;
  const { cache, health, inflight, tracer, limits, digest, fatal, retryable, clock } = env;
  return {
    refs,
    providers,
    ctx,
    restriction,
    approved,
    prices,
    deadline,
    signal,
    validate,
    cache,
    health,
    inflight,
    tracer,
    limits,
    digest,
    fatal,
    retryable,
    clock,
    readable: both(env.readable, call.readable),
    caps: smaller(env.caps, runCaps(call.caps)),
  } satisfies Record<keyof RunOptions<unknown, readonly ProviderRef[]>, unknown>;
}

type Readable = (connector: string) => true | Unread;

/** Readable when the env and the call both say so, the env's reason first: what the deployment
 *  cannot read, no viewer of it reads. */
function both(env: Readable | undefined, call: Readable | undefined): Readable | undefined {
  if (!env || !call) return env ?? call;
  return (connector) => {
    const deployed = env(connector);
    return deployed === true ? call(connector) : deployed;
  };
}

/** Each cap the smaller of the env's and the call's. */
function smaller(env: Caps | undefined, call: Caps): Caps {
  return {
    refs: tighter(env?.refs, call.refs),
    links: tighter(env?.links, call.links),
    rows: tighter(env?.rows, call.rows),
  };
}
