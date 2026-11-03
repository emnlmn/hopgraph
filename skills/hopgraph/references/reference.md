# Hopgraph reference

Every option with its default. Contents: Entities · Loaders · Hydrators · Relations · Providers ·
Routes · Runner (env) · Call · Result · Outcomes and reasons · Caps · Cancellation · Resilience ·
Validation · Errors · Tracing.

## Entities

`entity({ key, carries, context, personal, id })`

| Option | Default | Meaning |
| --- | --- | --- |
| `key` | required | Schema (Standard Schema: Zod, Valibot…) of the key; base keys and link targets are checked against it. |
| `carries` | none | Schemas of attributes a ref may bring besides its key (a track's date). |
| `context` | none | Carried attributes only a base row or a link brings, never a hydrator; `read` then takes `{ key, carries }`. |
| `personal` | `false` | The key shows in results only as `digest(entity, keyId)` (pass a keyed HMAC as env `digest` for guessable keys). |
| `id` | `String` | The key's stable text; required for a key that is not a string or a number. |

## Loaders

`g.loader({...})`. `load(refs, ctx, budget, signal)` returns `envelope(answers, billedBytes?, errors?)`
built from `[key, found(value, { cuts, coverage }) | absent(coverage?) | unknown({ reason: "failed" })]`.

| Option | Default | Meaning |
| --- | --- | --- |
| `id` | required | Unique; head of its cache entries and gate ids. |
| `version` | `1` | Part of every cache key: bump when the value changes shape or meaning. |
| `keyedBy` | required | The entity whose keys it reads. |
| `connectors` | required | `{ allOf: [...] }` (all readable) or `{ oneOf: [...] }` (a primary and its replica). |
| `batch` | required | `{ by: "keys", max }` row stores; `{ by: "partition" }` one call for every key (warehouses); `{ by: "one", concurrency }` APIs without a batch endpoint. |
| `needs` | none | Carried attributes the load reads besides the key (hydrated if missing). |
| `hints` | none | Carried attributes it reads when present; never a reason to hydrate. |
| `ctx` | none | Keys of the run's `ctx` it reads; data ones (`today`) are part of its cache keys, services are not. |
| `keep` | found whole: `"day"`, else `"brief"` | `(outcome) => "day" \| "hour" \| "brief" \| "none"`: cache retention. Unknown is never kept. |
| `partial` | `"keep"` | On a failed statement in `errors`: keep the keys that answered, or `"drop"` the call. |
| `cost`, `price` | free | `cost: { metered: { auto, approve } }` + dry run `price(refs, ctx, signal)` → bytes. |
| `retry` | none | `{ attempts, initialMs?, maxMs?, factor?, jitter? }`, for errors env `retryable` accepts. |
| `merge` | none | `{ needs, narrow, empty }`: refs of one key with different needs read once. |

A per-key cap belongs in the query; report it as `found(value, { cuts: [{ kind: "cap", limit: 50 }] })`.

## Hydrators

`g.hydrator(entity, loader, project)`: the loader that gives an entity's carried attributes, read by
key, once per key, when a step needs one the ref did not bring.

## Relations

`g.relation(from, to, name, spec)` declares `from › to:name`.

| Option | Default | Meaning |
| --- | --- | --- |
| `cardinality` | required | `"1:1"`, `"1:N"`, `"N:1"`, `"N:N"`; to-one finding two targets → `unknown: ambiguous`. |
| `strategies` | required | `(s) => [s(loader, { project, needs, hints, coverage })]`; loader keyed by `from`; `project(ref, value)` → `[{ to, attrs?, carries? }]`. |
| `combine` | `"fallback"` | `"fallback"`: strategy n+1 on refs n did not find or read; `"union"`: all strategies on every ref. |
| `link` | none | Schema of the links' attributes (checked). |
| `verify` | none | `(v) => v(loader, decide)`: read candidate targets, keep/drop/leave undecided. |
| `caps` | none | `{ links }`: most links one ref follows. |

## Providers

`g.provider(id, { loader, temporal, rows, project, raw, derived?, caps? })`. `temporal`:
`"current"` or `"historical"`; `rows`: `"one"` or `"many"`; `project(value, key)` → rows of one
named shape (give it a return type; `any`, unions and index signatures are refused); `raw`: every
field `{ meta, schema? }`; `derived: (d) => ({ x: d(["raw1"], ({ raw1 }) => …, { meta }) })`;
`caps: { rows }`. A field `schema` runs only under `validate: "strict"`. `g.catalog()` lists every
field with its provider, entity and `Meta`.

## Routes

`g.route(base, provider, how?)`: `how` is `g.path(r1, r2, …)`, `g.union(path, …)` (every path on
every row) or omitted for a provider keyed by the base. `g.graph(...routes)` takes all routes. Asking
a provider for an entity with no route doesn't compile (`HG_NO_ROUTE` at run time when asked by id).
`checkGraph(graph, { bases })` → `{ problems, alternatives }`: `problems` are missing pairs, unused
loaders, needs without hydrator; `alternatives` lists, per `base › provider`, paths no route takes,
for a committed file. `g.ref(entity, key, carries?)`
makes a base row for `run`.

## Runner (env): `createRunner(graph, env)`, once per process

| Option | Default | Meaning |
| --- | --- | --- |
| `cache` | none: nothing kept | `CachePort` (`getMany`, `setMany`); `memoryCache({ max, ttl: { day, hour, brief }, clock })` in memory (defaults 10 000 entries; 24 h, 1 h, 60 s). Several processes need a shared port. |
| `readable` | every connector | `(c) => true \| "disabled" \| "not_configured"`. |
| `limits` | none | Concurrent loads per connector (`{ db: 8 }`), per run. |
| `caps` | none | `{ refs, links, rows }`. |
| `health` | none | `createHealth({ conn: { breaker: { failures, windowMs, coolDownMs }, rate: { perSecond, burst } } })`. |
| `inflight` | none | `createInflight()`: concurrent runs share loads of the same cache entry. |
| `tracer` | none | OpenTelemetry-shaped `startSpan(name, attrs, parent?)`. |
| `digest` | SHA-256 | `(entity, keyId) => string` for personal keys. |
| `fatal`, `retryable` | none | Error classifiers: reject the run / retry the call. |
| `clock` | `Date.now` | Time the deadline is read against. |

## Call: `runner.read(entity, keys, providers, call)` / `runner.run({ refs, providers, ...call })`

`ctx`, `readable` (`"forbidden"`), `restriction`, `caps` (smaller wins), `deadline` (epoch ms),
`signal`, `approved` (bytes by gate id), `prices` (a previous run's), `validate`. `refs` for `run`:
`{ row, entity, key, carries? }`.

## Result

`status` (`"complete"` | `"gated"`), `gates` (`{ id, step, loader, keys, bytes }`), `billedBytes`,
`prices` (Map), `rows` (Map by row id → `{ providers, steps }`), `trace` (per step and loader:
`keysIn, cached, found, absent, unknown` by reason, `cut, billedBytes, ms, retries, errors`).
A provider result: `outcome`, `rows[i].fields` and `lineage`, `unknown` (reasons), `cut`, `coverage`.

## Outcomes and reasons

found if any branch found; absent only if every branch ran to the end, uncut, and found nothing;
unknown otherwise. In a fallback, the strategy that found answers. Reasons: `unread` (connector
disabled, forbidden or not configured), `failed` (`why: "open"` when the circuit was open),
`too_heavy`, `awaiting_approval`, `deadline`, `unmet` (a need's hydration was unknown), `ambiguous`.

## Caps

`caps: { refs, links, rows }` on env or call; `{ links }` on a relation, `{ rows }` on a provider;
smaller wins. Past one the ref is cut (`{ kind: "capped" }`): found-but-cut, or unknown if empty.

## Cancellation

Caller's `signal` aborts → the run rejects with its reason. Deadline passes → the run answers, the
rest `unknown: deadline`, loads see `AbortedError` (`why: "deadline"`). What a source billed before
stopping is billed.

## Resilience

`retry` on the loader + env `retryable(error)`; waits up to `initialMs × factor^(n-1)` (defaults
100 ms, 10 s, 2). Breaker: after `failures` throws in `windowMs`, open for `coolDownMs` (keys
`unknown: failed`, `why: "open"`). Rate: token bucket per connector.

## Validation

`"boundaries"` (default): base keys and carried attributes (a failure rejects the run with
`ValidationError`), then link targets, link attributes and hydrations (a failure is
`unknown: failed`, `HG_INVALID`). `"strict"`: also every envelope (a key in two buckets fails) and
provider field schemas. `"off"`: nothing.

## Errors

All are `HopgraphError` with a stable `code`: `DefinitionError` (`HG_NO_ROUTE`, `HG_PATH`, …),
`ValidationError` (`HG_INVALID`), `CostChangedError` (`HG_COST_CHANGED`), `AbortedError`
(`HG_ABORTED`). A load that fails is not an error of the run: its keys are `unknown: failed`.

## Tracing

Spans `hopgraph.run`, `hopgraph.batch`, `hopgraph.price`, `hopgraph.load`; attributes are ids,
counts, bytes, durations, outcomes; never keys.
