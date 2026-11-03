---
name: hopgraph
description: Declares, runs, tests and debugs Hopgraph graphs (the `hopgraph` npm package) that read data across databases, APIs and warehouses by key, with found/absent/unknown outcomes. Use when code imports `hopgraph`, or when adding a loader, relation, provider or route, fixing a wrong outcome (absent vs unknown), adding a cost gate or approval, a deadline, per-viewer access, or writing tests for a graph.
license: MIT
---

# Hopgraph

A graph declared once: **entities** (things with a key), **loaders** (the only code that reads a
source, batched by key), **relations** (edges whose links a loader's value gives), **providers**
(fields of an entity, from one loader) and **routes** (which relations lead from a base entity to a
provider). A run answers per base row and provider: `found`, `absent` (searched, nothing there) or
`unknown` (not read, with a reason). The whole point is that "nothing there" and "couldn't read"
never mix.

This file is enough for most tasks. [references/reference.md](references/reference.md) has every
option with its default; open it only for an option not shown here.

## The shape of a graph

```ts
import { absent, checkGraph, createRunner, entity, envelope, found, hopgraph, memoryCache } from "hopgraph";
import { z } from "zod";

type Meta = { readonly label: string };              // what every field carries; the library never reads it
const g = hopgraph<Meta, "db" | "wh">().entities({     // <Meta, Conn, Ctx>: Ctx last, `undefined` by default
  track: entity({ key: z.string() }),
  artist: entity({ key: z.string() }),
});

const artists = g.loader({
  id: "artists",                          // + `version` (default 1): bump it when the value changes meaning
  keyedBy: "artist",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },        // or { by: "partition" }: one call for all keys; { by: "one", concurrency }
  load: async (refs, _ctx, _budget, signal) => {
    const rows = await db.artistsByIds(refs.map((r) => r.key), { signal }); // throws when the db is down
    return envelope(refs.map((r) => [r.key, rows.has(r.key) ? found(rows.get(r.key)!) : absent()]));
  },
});

const tracks = g.loader({
  id: "tracks", keyedBy: "track", connectors: { allOf: ["db"] }, batch: { by: "keys", max: 100 },
  load: async (refs, _ctx, _budget, signal) => {
    const rows = await db.tracksByIds(refs.map((r) => r.key), { signal });
    return envelope(refs.map((r) => [r.key, rows.has(r.key) ? found(rows.get(r.key)!) : absent()]));
  },
});

const performer = g.relation("track", "artist", "performer", {
  cardinality: "N:1",                      // a to-one relation that finds two targets is unknown: ambiguous
  strategies: (s) => [s(tracks, { project: (_ref, t) => (t.artistId ? [{ to: String(t.artistId) }] : []) })],
});

const profile = g.provider("artistProfile", {
  loader: artists,
  temporal: "current",                     // or "historical"
  rows: "one",                             // or "many"
  project: (a): { name: string }[] => [{ name: a.name }],
  raw: { name: { meta: { label: "Name" } } },
});

export const graph = g.graph(
  g.route("track", profile, g.path(performer)), // a path of relations from the base to the provider's entity
  g.route("artist", profile),                    // a provider keyed by the base needs no path
);

export const runner = createRunner(graph, { cache: memoryCache(), limits: { db: 8 } }); // once per process
const result = await runner.read("track", ["t1", "t2"], [profile], { deadline: Date.now() + 300 });
const p = result.rows.get("t1")?.providers.artistProfile; // keyed by row id, then provider id
p?.outcome;                 // "found" | "absent" | "unknown"
p?.rows[0]?.fields.name;    // typed
p?.unknown;                 // [{ reason: "failed" }, …] when unknown (also listed beside a found that missed a branch)
```

## Rules the types do not check

These decide every outcome. Most wrong outcomes come from breaking one of them.

1. **A load puts every key it was given in the envelope.** A key it leaves out is `unknown: failed`,
   never absent. A source that simply omits ids it doesn't have → answer `absent()` for each of them.
2. **A source that fails throws, or answers `unknown({ reason: "failed" })`.** Never catch an error
   and answer `absent()`: that turns "source down" into "doesn't exist", and the cache keeps it.
   A thrown load makes every key of that call `unknown: failed`; an unknown is never cached.
3. **A relation whose projection gives no link (`[]`) is absent** for that ref: "no label" is a
   projection returning `[]`, not a loader trick.
4. **Every link target is checked against the target entity's key schema** (`validate: "boundaries"`,
   the default). A source that gives `103` for a `z.string()` key fails the link: `unknown: failed`,
   `HG_INVALID` in the trace, the target never read. Convert in the projection (`String(id)`) or
   give the key a schema that accepts it (`z.coerce.string()`).
5. **Absent needs every branch read to the end, uncut.** A cut, a timeout or an unread source makes it
   unknown. Don't post-process `unknown` into `absent` in app code.
6. **A load hands `signal` to its client.** Past the deadline loads are aborted; one that ignores the
   signal keeps its connector slot until it ends.
7. **`deadline` is an epoch time in ms** (`Date.now() + 300`), not a duration.

## Adding a source

```
- [ ] Connector name in the `Conn` type argument, and a limit in createRunner's `limits` if it's rate-limited
- [ ] Entity for the new key (if it's a new kind of thing)
- [ ] Loader keyed by it: right `batch`, every key answered (rules 1-2), `signal` passed on
- [ ] Relation from an existing entity whose loader value holds the key (`project` returns [] when there is none)
- [ ] Provider with explicit row type and every field in `raw`
- [ ] Route from each base entity: g.route(base, provider, g.path(rel1, rel2, ...))
- [ ] checkGraph(graph, { bases: ["track"] }).problems is [] (every pair routed, every loader used)
- [ ] Tests for found, absent and source-down (unknown: failed), each on a fresh runner
```

A relation can read through a loader another relation or provider already uses (an artist row that
holds `labelId` gives the `artist › label` links): one job reads each loader once per wave, whoever
asks.

## Debugging a wrong outcome

Look at what the run says before reading library code:

```ts
const row = result.rows.get("t7")!;
row.providers.artistProfile.unknown;   // why it is unknown: failed | unread | deadline | too_heavy | awaiting_approval | unmet | ambiguous
row.steps;                             // every hop: { step, loader, outcome, reason, cuts }: where the chain broke
result.trace;                          // per step and loader: keysIn, cached, found, absent, unknown by reason, errors [{ code, keys }]
```

| Symptom | Usual cause |
| --- | --- |
| unknown `failed`, no error in the trace | the loader left keys out of the envelope (rule 1) |
| unknown `failed`, `HG_INVALID` in the trace | a link's target key or attributes fail their schema (rule 4) |
| absent while the source was down | the loader caught the error and answered absent (rule 2) |
| unknown `unmet` | a needed carried attribute could not be read (its hydrator's source) |
| unknown `ambiguous` | a to-one relation found two targets, or `verify` left one undecided |
| a fix seems not to work in tests | the shared runner's cache answers from an earlier run: use a fresh runner |

## Cost gates (billed sources)

```ts
const plays = g.loader({
  id: "plays", keyedBy: "track", connectors: { allOf: ["wh"] },
  batch: { by: "partition" },                                   // one query for all keys
  cost: { metered: { auto: 1e9, approve: 50e9 } },              // ≤ auto: runs; ≤ approve: gate; above: too_heavy
  price: (refs, _ctx, signal) => wh.dryRun(refs.map((r) => r.key), { signal }), // bytes, billed nothing
  load: async (refs, _ctx, budget, signal) => {
    const { rows, billedBytes } = await wh.query(refs.map((r) => r.key), { maxBytes: budget.maxBytes, signal });
    return envelope(refs.map((r) => [r.key, rows.has(r.key) ? found(rows.get(r.key)!) : absent()]), billedBytes);
  },
});
```

- A gated run has `status: "gated"` and `gates: [{ id, loader, keys, bytes }]`; the gated keys are
  `unknown: awaiting_approval`, everything not behind the gate is read. Above `approve`:
  `unknown: too_heavy`, never offered.
- To resume, run **the same request** with `approved: { [gate.id]: bytes }` and `prices: first.prices`
  (no second dry run). Approvals accumulate: pass the earlier ones too.
- **Resume needs a cache shared by both rounds** (`cache: memoryCache()` on the runner), or what the
  first round read is billed again. `memoryCache` keeps found answers a day but **absent ones only
  60 s** (`brief`): when a person approves, raise it, `memoryCache({ ttl: { brief: 3_600_000 } })`, or
  the resume re-reads and re-bills them.
- The envelope's second argument is what the call billed; always pass `budget.maxBytes` to the source.
- A price that grew past the approval rejects the run with `CostChangedError`, billing nothing.

## Options of a call

`runner.read(entity, keys, providers, call)` / `runner.run({ refs, providers, ...call })`:

| Option | Meaning |
| --- | --- |
| `ctx` | the run's values and services, typed by `Ctx`; required unless `Ctx` admits `undefined` |
| `deadline` | epoch ms: past it nothing starts, loads abort, unfinished values are `unknown: deadline`, the rest stands |
| `signal` | `AbortSignal`: aborts the loads and rejects the run |
| `readable` | `(connector) => true \| "forbidden"`: this viewer's access; a forbidden loader is not called and its cache not read (`unknown: unread`) |
| `restriction` | a string naming what this viewer may not read; part of every cache key and gate id |
| `approved`, `prices` | approvals by gate id, prices from a previous run (cost gates) |
| `validate` | `"boundaries"` (default), `"strict"` (also envelopes and field schemas), `"off"` |
| `caps` | `{ refs, links, rows }`: past one the ref is cut, never absent |

Env options (`createRunner(graph, env)`, once per process): `cache`, `limits` (concurrent loads per
connector), `readable` (what the deployment can read), `health` (`createHealth`: breakers, rate
limits), `inflight` (`createInflight`: share loads across concurrent runs), `retryable`, `fatal`,
`tracer`, `caps`. A call never widens them.

## Testing a graph

- Build the runner **per test** (`createRunner(graph, { cache: memoryCache() })`): a shared cache
  answers from earlier tests and hides a simulated failure.
- Assert outcomes, not only fields: found, absent and source-down (`unknown`, reason `failed`) for
  each provider you touch.
- Keep `checkGraph(graph, { bases: [...] }).problems` empty in a test.
- `run(graph, options)` runs without a runner (env and call in one object), handy in a test.
