// The texts a run builds from values: a serialisation in which equal values give equal text (to
// deduplicate reasons and chains, to name a ref), and the ids it hands to the cache port and to the
// person who approves a gate (DESIGN.md §5.2, §5.4).
//
// An id names what it covers by its SHA-256, so two requests never share an answer or an approval,
// and it is the same in every process, on every runtime and in every version of the library that
// writes the same format. Format 1, where json is `stableJson` and sha256 is in hex:
//
//   answer entry  hopgraph:1:answer:<loader id, URI-encoded>:<loader version>:<sha256 of
//                 json(["answer", loader id, version, key id, needs and hints, ctx data, restriction])>
//   key token     the first 32 hex digits of the sha256 of
//                 json(["key", loader id, version, restriction, key id, shown key, needs and hints])
//   gate id       <loader id>:<sha256 of json(["gate", loader id, version, restriction, tokens sorted])>
//   gate scope    hopgraph:1:gate:<gate id, URI-encoded>
//   digest        sha256 of json(["digest", entity, key id]): how a personal key is shown when the
//                 application gives no digest of its own
//
// The loader id and version stay readable at the head of an answer entry, so an operator can drop
// a loader's entries by prefix. A key id is in no id as it is: a key token also hashes the key as
// the result shows it (a personal key by the application's digest), so a gate id, which people see
// and pass around, cannot be recomputed from a guessed key without the digest's secret.

import type { LoaderDef } from "../core/index.ts";
import { sha256 } from "./sha256.ts";

/** JSON with object keys sorted at every level and bigints spelled out. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (typeof v === "bigint") return `${v}n`;
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
  });
}

/**
 * Whether a value is data (primitives, dates, arrays and plain objects of data) rather than a
 * service (a function, a client, any other class instance). A run value a loader declares is part
 * of its cache key only when it is data: another `today` is another answer, another client is not.
 */
export function isData(value: unknown): boolean {
  if (value === null || typeof value !== "object") return typeof value !== "function";
  if (value instanceof Date) return true;
  if (Array.isArray(value)) return value.every(isData);
  const proto = Object.getPrototypeOf(value);
  return (proto === Object.prototype || proto === null) && Object.values(value).every(isData);
}

type Versioned = Pick<LoaderDef, "id" | "version">;

/**
 * The cache entry of one loader key (types.ts CachePort): the loader and its version, the key id,
 * what else the load reads (`read`: the json of its needs' and hints' values; `data`: the json of
 * its declared ctx values that are data) and the viewer's restriction.
 */
export function answerKey(
  loader: Versioned,
  keyId: string,
  read: string,
  data: string,
  restriction: string,
): string {
  const digest = sha256(
    stableJson(["answer", loader.id, loader.version, keyId, read, data, restriction]),
  );
  return `hopgraph:1:answer:${encodeURIComponent(loader.id)}:${loader.version}:${digest}`;
}

/** One loader key as a gate covers it. `shown` is the key as results show it: a personal key's
 *  digest. 128 bits: a gate's scope lists one per key. */
export function keyToken(
  loader: Versioned,
  restriction: string,
  keyId: string,
  shown: string,
  read: string,
): string {
  const text = stableJson(["key", loader.id, loader.version, restriction, keyId, shown, read]);
  return sha256(text).slice(0, 32);
}

/**
 * A gate's id: the loader, its version, the restriction and the loader keys to load, in any order.
 * Not the steps that asked: the same keys are the same request whichever steps a wave gathered.
 */
export function gateId(loader: Versioned, restriction: string, tokens: readonly string[]): string {
  const request = ["gate", loader.id, loader.version, restriction, [...tokens].sort()];
  return `${loader.id}:${sha256(stableJson(request))}`;
}

/** A personal key as a run shows it when the application gives no digest (`RunOptions.digest`):
 *  never the key, but anyone who guesses the key can compute it, hence the advice of a keyed
 *  HMAC. */
export function keyDigest(entity: string, keyId: string): string {
  return sha256(stableJson(["digest", entity, keyId]));
}

const SCOPE = "hopgraph:1:gate:";

/** Where the cache port keeps a gate's scope: the tokens of the keys an approval of it covers. */
export function scopeKey(gate: string): string {
  return `${SCOPE}${encodeURIComponent(gate)}`;
}

/** Whether a cache entry key is a gate's scope. */
export function isScopeKey(key: string): boolean {
  return key.startsWith(SCOPE);
}
