# Hopgraph guide

Every option with its default. The [README](../README.md) is the short version.

Hopgraph reads the fields of a list of rows when those fields live in several sources, each read by
its own key. The application declares the graph once: entities are the nodes and relations the
directed edges (a track has a performer, a performer is signed to a label), each read by a loader
over one source. Fields hang on entities as providers, and a route names the hops from each kind of
base row to each provider.

The application then asks for providers over a set of base rows. For every row it gets one of
three answers per provider, with the chain of hops behind it:
- **found**: what was read;
- **absent**: what was searched and not found;
- **unknown**: what could not be read, and why.

On the way, the executor batches the reads of each loader into one job, caches answers per key,
and enforces per-connector limits, cost gates and a deadline. A slow branch never holds up a fast
one.

It has no runtime dependencies and does no I/O of its own: every read is a function the
application hands it. It runs on Node 20 or later, Deno, Bun and workers.

[DESIGN.md](../DESIGN.md) is the reference: why it is built this way, every
rule the executor follows, the error codes, the span attributes and the id formats.
[docs/api](api/hopgraph.md) is the API reference, generated from the doc comments.

Status: version 0.2.0. The API may change before 1.0 ([Versioning](#versioning));
every change is in [CHANGELOG.md](../CHANGELOG.md), and every change a consumer has to apply, with its
code before and after, in [MIGRATION.md](../MIGRATION.md).

## Contents

[Install](#install) · [Problem](#problem) · [Example](#example) ·
[Model](#model) · [Declaring a graph](#declaring-a-graph) · [Running](#running) ·
[Outcomes](#outcomes) · [Cost gates and approvals](#cost-gates-and-approvals) · [Caps](#caps) ·
[Cancellation and the deadline](#cancellation-and-the-deadline) · [Resilience](#resilience) ·
[Validation](#validation) · [Tracing and metrics](#tracing-and-metrics) · [Errors](#errors) ·
[What it does not do](#what-it-does-not-do) · [Examples](#examples) · [Versioning](#versioning) ·
[License](#license)

## Install

```sh
npm install hopgraph
```

ESM only. The types need TypeScript 5.4 or later. Key and attribute schemas are
[Standard Schema](https://standardschema.dev) values, so any validator that implements it works;
the examples use Zod.

## Problem

To show fields from several sources for a list of rows, an application must walk, for every
field, from the row's key to the key the field's source is read by: from a track to its performer,
from the performer to the performer's label. Written by hand, that walk is repeated in every
feature, each copy picks its own batching, limits and fallbacks, and nothing tells "this track has
no performer" from "the artist database was down". Hopgraph declares the walk once, reads it the
same way for every consumer, and makes every answer say which of the two happened.

## Example

Tracks and their performers' profiles, from two tables: the graph declared once, a runner made at
startup, and a read by key where the profiles are needed. The whole program compiles and runs as
it is.

```ts
import {
  absent,
  type CachedAnswer,
  type CachePort,
  createRunner,
  entity,
  envelope,
  found,
  hopgraph,
} from "hopgraph";
import { z } from "zod";

// The sources: two tables in memory. A real loader queries a database or calls an API.
const TRACKS = new Map([
  ["t1", { artist: "a1", plays: 120 }],
  ["t2", { artist: "a2", plays: 40 }],
]);
const ARTISTS = new Map([["a1", { name: "Mira Volk", country: "IT" }]]);

type Meta = { readonly label: string }; // the metadata every field must carry
// `undefined`: the runs of this graph carry no values or services, so a call gives no `ctx`
const g = hopgraph<undefined, Meta, "db">().entities({
  track: entity({ key: z.string() }),
  artist: entity({ key: z.string() }),
});

// A loader is the unit of I/O: it reads one source by keys of one entity, in batches, and says per
// key what it found.
const tracks = g.loader({
  id: "tracks", // with its version (1 unless given), the head of every cache entry it writes
  keyedBy: "track",
  connectors: { allOf: ["db"] }, // what a run limits, switches off and watches it by
  batch: { by: "keys", max: 100 },
  load: async (refs) =>
    envelope(
      refs.map((r) => {
        const row = TRACKS.get(r.key);
        return [r.key, row ? found(row) : absent()];
      }),
    ),
});
const artists = g.loader({
  id: "artists",
  keyedBy: "artist",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },
  load: async (refs) =>
    envelope(
      refs.map((r) => {
        const row = ARTISTS.get(r.key);
        return [r.key, row ? found(row) : absent()];
      }),
    ),
});

// A relation projects a loader's value into links; it reads nothing itself.
const performer = g.relation("track", "artist", "performer", {
  cardinality: "N:1",
  strategies: (s) => [s(tracks, { project: (_ref, track) => [{ to: track.artist }] })],
});

// A provider projects a loader's value into rows of fields, each with its meaning.
const profile = g.provider("artistProfile", {
  loader: artists,
  temporal: "current",
  rows: "one",
  project: (a) => [{ name: a.name, country: a.country }],
  raw: { name: { meta: { label: "Name" } }, country: { meta: { label: "Country" } } },
});

// The graph, with its routes: how rows of a base entity reach a provider (here, through the
// track's performer). Its type knows them: asking `profile` for rows of an artist does not compile.
const graph = g.graph(g.route("track", profile, g.path(performer)));

// Once, at startup: the graph and what holds for the process. Here a cache every call shares (a
// real one maps each retention to a time to live) and a limit of concurrent loads per connector.
const store = new Map<string, CachedAnswer>();
const cache: CachePort = {
  getMany: async (keys) => new Map(keys.flatMap((k) => (store.has(k) ? [[k, store.get(k)!]] : []))),
  setMany: async (entries) => {
    for (const e of entries) store.set(e.key, e.answer);
  },
};
const runner = createRunner(graph, { cache, limits: { db: 8 } });

// At each call site: keys of one entity, the providers, and what holds for this call.
const result = await runner.read("track", ["t1", "t2"], [profile], {
  deadline: Date.now() + 2_000, // past it, loads are aborted and the read answers with what it has
});

const t1 = result.rows.get("t1")?.providers.artistProfile; // each row under its key
t1?.outcome; // "found"
t1?.rows[0]?.fields.name; // "Mira Volk", typed string
result.rows.get("t2")?.providers.artistProfile.outcome; // "absent": ARTISTS has no a2
```

Every option has a default, so `createRunner(graph)` alone reads every connector, keeps nothing
and bounds nothing. [Running](#running) says what goes in the runner and what in each call.
[Examples](#examples) has three complete programs, each run by a test.

## Model

Two graphs. The schema graph is what the application declares: entities as nodes, relations as
named, directed edges. The instance graph is what a run reads: refs (one track, one artist)
joined by the links the relations found. A route is a path in the schema graph, written down and
checked, never searched for at run time; the executor follows it through the instance graph, and
every provider row keeps its lineage, the chains of links from the base row to it. The run itself
is planned as a DAG of steps, so steps that do not depend on each other read side by side.

| Concept      | What it is                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Entity**   | A kind of thing with a key other sources are read by: its key schema, the attributes a ref of it may carry, and whether its key is personal.                       |
| **Ref**      | One entity instance during a run: its key and the attributes that came with it.                                                                                    |
| **Loader**   | The unit of I/O. Reads one source by keys of one entity, in batches, with a cache entry per key, a retention, a failure policy and, when the source bills, a cost. |
| **Relation** | A named, directed `from › to:name` between two entities, made of strategies that project loaders' values into links, combined as `fallback` or `union`.            |
| **Provider** | A set of fields keyed by one entity: a projection of one loader's value into rows. Every field carries the application's `Meta`.                                   |
| **Route**    | For one (base entity, provider) pair, the relation paths that reach the provider's entity. Declared, never searched.                                               |
| **Outcome**  | Per ref, step and provider: `found`, `absent` within a stated coverage, or `unknown` with a reason.                                                                |

## Declaring a graph

A graph starts with its type arguments, then its entities, then one statement per loader,
hydrator, relation and provider, and ends with `g.graph(...routes)`. The compiler checks each
statement where it is written (DESIGN.md §7): a strategy's loader keyed by another entity, a path
that does not chain, a projected value with no field, a connector the graph does not have, are
compile errors; and a run or a read that asks a provider for rows of an entity no route joins it
to.

```ts
const g = hopgraph<Ctx, Meta, Conn>().entities({ track, artist, email });
```

`Ctx` is what a run carries (`{ today: string; db: Pool }`; `undefined` for a graph whose runs
carry nothing, and then a call leaves `ctx` out), `Meta` the metadata every field must carry (a
label, a description; the library never reads it), `Conn` the connector names.

### Entities

`entity({ key, carries, context, personal, id })`.

| Option     | Default  | Meaning                                                                                                             |
| ---------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `key`      | required | The key's schema: base rows' keys and links' targets are checked against it.                                        |
| `carries`  | none     | Schemas of the attributes a ref may bring besides its key (a track's date).                                         |
| `context`  | none     | Carried attributes only a base row or a link brings, never a hydrator (a window around the referring track's date). |
| `personal` | `false`  | A personal key appears in results only as `digest(entity, keyId)`.                                                  |
| `id`       | `String` | The key's stable text, for maps, cache entries and digests. Required for a key that is not a string or a number.    |

### Loaders

`g.loader({...})`. A loader is the only code that touches a source. `load(refs, ctx, budget,
signal)` returns an envelope that puts every key it was given in exactly one of `values`, `absent`
and `unknown`; it never throws for a key it could not read, and a key it does not mention is
failed, never absent. Build the envelope from per-key answers with `found(value, { cuts,
coverage })`, `absent(coverage)` and `unknown(reason)`, which type it by its value. A load's reason
is `{ reason: "failed" }`, or `unread` when it knows its source is not readable; the other reasons
are the run's to give.

```ts
load: async (refs, ctx, budget, signal) => {
  const rows = await ctx.db.byIds(refs.map((r) => r.key), { signal }); // hand `signal` to the client
  return envelope(refs.map((r) => [r.key, rows.has(r.key) ? found(rows.get(r.key)!) : absent()]));
},
```

| Option          | Default                                  | Meaning                                                                                                                                                                                      |
| --------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`            | required                                 | Unique in the graph; the head of its cache entries and gate ids.                                                                                                                             |
| `version`       | `1`                                      | Part of every cache key: bump it when the value changes shape or meaning.                                                                                                                    |
| `keyedBy`       | required                                 | The entity whose keys it reads.                                                                                                                                                              |
| `connectors`    | required                                 | `{ allOf: [...] }`: it runs when every one is readable; `{ oneOf: [...] }`: when one is (a primary and its replica). A run's `readable`, `limits` and `health` know a loader by them.        |
| `batch`         | required: it depends on the source       | `{ by: "keys", max }` for row stores; `{ by: "partition" }`, one call for every key, for warehouses billed by bytes scanned; `{ by: "one", concurrency }` for APIs without a batch endpoint. |
| `load`          | required                                 | Reads the keys. `signal` aborts when the run stops waiting; `budget.maxBytes` is what a metered call may bill.                                                                               |
| `needs`         | none                                     | Carried attributes the load reads besides the key, typed as present in `refs` (a ref's date, for its window).                                                                                |
| `hints`         | none                                     | Carried attributes it reads when present; never a reason to hydrate or to be unknown.                                                                                                        |
| `ctx`           | none                                     | Keys of the run's `ctx` it reads; those that are data (`today`) are part of its cache keys, a service (a pool) is not.                                                                       |
| `keep`          | a whole found answer `day`, else `brief` | `(outcome) => "day" \| "hour" \| "brief" \| "none"`: how long the cache keeps a found or absent answer, decided on its outcome and first cut, never its value. An unknown is never kept.     |
| `partial`       | `"keep"`                                 | On a failed statement reported in `errors`: keep the keys that answered, or `"drop"` the whole call.                                                                                         |
| `cost`, `price` | free                                     | `cost: { metered: { auto, approve } }` and a dry run `price(refs, ctx, signal)` returning bytes: [Cost gates](#cost-gates-and-approvals).                                                    |
| `retry`         | none: a call is made once                | `{ attempts, initialMs?, maxMs?, factor?, jitter? }`: [Retries](#retry-failed-calls).                                                                                                        |
| `merge`         | none                                     | `{ needs, narrow, empty }`: refs of one key whose needs differ are read once with merged needs, and each keeps its own part.                                                                 |

A per-ref cap belongs in the query (`QUALIFY ROW_NUMBER() OVER (PARTITION BY key) <= 50`), and the
load reports the keys it cut, as `found(value, { cuts: [{ kind: "cap", limit: 50 }] })`: a cut
answer is never mistaken for a whole one.

### Hydrators

`g.hydrator(entity, loader, project)`: the loader that gives an entity's carried attributes, read
by key alone. A step that needs an attribute the ref did not bring reads it from there, once per
key. What a base row or a link brought wins over it.

### Relations

`g.relation(from, to, name, spec)` declares `from › to:name`. The name is part of the meaning:
`artist › track:recent` and `artist › track:latest` are two relations.

| Option        | Default                         | Meaning                                                                                                                                                                      |
| ------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cardinality` | required                        | `"1:1"`, `"1:N"`, `"N:1"` or `"N:N"`. One that says one target (`1:1`, `N:1`) and finds two for a ref answers that ref `unknown: ambiguous`, and nothing is read through it. |
| `strategies`  | required                        | `(s) => [s(loader, { project, needs, hints, coverage }), …]`: each a loader keyed by `from` and a pure projection of its value into links `{ to, attrs?, carries? }`.        |
| `combine`     | `"fallback"`; required with two | `"fallback"`: strategy n + 1 runs on the refs strategy n did not find or could not read. `"union"`: every strategy on every ref, links kept apart.                           |
| `link`        | none                            | The schema of the links' attributes; the projection must give them, and they are checked.                                                                                    |
| `verify`      | none                            | `(v) => v(loader, decide)`: a loader keyed by `to`, read on the candidate targets, and a rule that keeps, drops or leaves undecided each candidate of a ref.                 |
| `caps`        | none                            | `{ links }`: the most links one ref follows ([Caps](#caps)).                                                                                                                 |

### Providers

`g.provider(id, spec)` projects one loader's value per key into rows. Every projected value is a raw
field with its `Meta`; a derived field is a pure function of raw fields of the same provider:

```ts
const streams = g.provider("trackStreams", {
  loader: trackHeader,
  temporal: "historical", // as it was when written; "current": as it is today
  rows: "many",
  project: (track) => track.streams,
  raw: { market: { meta: { label: "Market" } }, streams: { meta: { label: "Streams" } } },
  derived: (d) => ({
    hit: d(["streams"], ({ streams }) => streams >= 10, { meta: { label: "Hit" } }),
  }),
  caps: { rows: 500 }, // optional: the most rows one ref gets
});
```

A provider's rows have one shape with named fields: rows typed `any` (what `JSON.parse` returns), a
union of shapes or an index signature are refused by the compiler, since the run keeps the fields
`raw` names and the result types them as the rows are typed. Give `project` a return type, with
optional fields where rows differ; a row type may be an interface or a type alias. `g.catalog()`
lists every field with its provider, entity, kind, inputs and `Meta`, for the application's field
pickers, search and docs.

### Routes, and the graph test

`g.route(base, provider, how)` makes a route, where `how` is `g.path(r1, r2, …)`, `g.itself(base)`
for a provider keyed by the base, or `g.union(...)` of paths (every path on every row). It declares
nothing on its own: `g.graph(...routes)` takes the graph's routes, all of them, and its type keeps
every (base, provider) pair they join.

```ts
export const graph = g.graph(
  g.route("track", streams, g.itself("track")),
  g.route("track", profile, g.path(performer)),
  g.route("artist", profile, g.itself("artist")),
);
```

The compiler refuses a path that does not chain, with the place it breaks, a path that does not
start at the route's base or end at the provider's entity, and `itself` for a provider keyed by
another entity. Then, at every call site: a run or a read that asks a provider for rows of an
entity it has no route from does not compile, with the provider and the entity in the message
(`provider "trackStreams" has no route from "artist"`). The check needs the rows' entities as
literals: `read` always has one, and `run` has them when its `refs` are written out or made by
`g.ref`. Rows built otherwise (`entity: string`) only ask that some route reaches each provider, and
a provider asked by an id the compiler cannot know (`string`, a field picker's) asks nothing. In
every case the run refuses what slipped through (`HG_NO_ROUTE`) before it reads anything.

`g.ref(entity, key, carries?, row?)` makes a base row for `run` the way `read` takes a key: the key
typed by what the entity's key schema accepts, every context attribute required, and the entity's
name kept, so that rows built at run time are checked against the routes all the same. Its row id
is the key's id (the entity's `id(key)`, of the key as its schema parses it) unless given.

```ts
const refs = trackIds.map((id) => g.ref("track", id));
await runner.run({ refs, providers: [summary, profile], ctx }); // routes checked from "track"
```

`checkGraph(graph, { bases })`, in the application's graph test, checks what the compiler cannot:
every (base, provider) pair has a route, every loader is used, every entity whose attributes are
needed has a hydrator; and it lists the paths no route uses, for a committed file, so a new
relation that opens a way shows up in review.

## Running

A process makes one runner, at startup, from its graph and what holds for the process (`RunEnv`);
each call site then reads through it with what holds for that call (`RunCall`):

```ts
// once, at startup
const runner = createRunner(graph, { cache, health, inflight, tracer, limits: { db: 8 } });

// at each call site: keys of one entity, one row per key, each under its key's id
const page = await runner.read("track", trackIds, [summary, profile], { ctx, deadline, signal });
// or base rows of any entities, under row ids of the caller's
const mixed = await runner.run({ refs, providers: [profile], ctx, deadline });
```

`run(graph, options)` takes both halves in one object (`RunOptions`, which is `RunEnv & RunCall`):
for a script, a test, or a call that has no runner at hand. A runner's `run(call)` is `run(graph,
options)` with the env's options.

Steps that do not depend on each other run side by side; every read of one loader in one wave,
whatever step asked, is one job: one cache lookup, one price, one set of calls. A provider asked as
declared (`[profile]`) types its rows' fields, and its key is certain only when the list is written
out and that element is one provider (not `cond ? a : b`, not an array); asked by id, a provider's
fields are untyped, so a field picker can ask by name. `run`, a runner's `run` and `read` type
their results alike.

### The process and the call

The env is what every call of a process shares, or what is the same for all of them: the stores and
objects runs share (`cache`, `health`, `inflight`), what the deployment can read and how much of it
at once (`readable`, `limits`, `caps`), how the application classifies errors (`fatal`,
`retryable`), its telemetry (`tracer`), the digest of its personal keys and its clock. The call is
what one request decides: its rows and providers, its values (`ctx`), its viewer (`readable`,
`restriction`), how long its caller waits (`deadline`, `signal`), its approvals (`approved`,
`prices`) and how far it trusts what it sends (`validate`).

A call narrows the env where both give an option, and never widens it:
- `readable`: a connector is readable when the env and the call both say so, the env's reason
  first. What the deployment cannot read (`not_configured`, `disabled`) no viewer reads; what a
  viewer may not (`forbidden`) comes from the call.
- `caps`: each is the smaller of the env's and the call's. A preview may ask for less than the
  process allows, never for more.

The other env options are fixed, and a call object that carries one (through a spread or a cast)
does not replace it:
- `cache`, `health` and `inflight` are shared: a call with its own cache would read and write where
  no other call does, and one with its own health or inflight would not see the other runs'
  failures and loads.
- `limits` are a connector's capacity (a pool's size): a call that raised them would overload the
  source for every other call.
- `digest` is the same on every instance: gate ids and personal keys are compared across calls.
- `fatal` and `retryable` classify the clients' errors, the same for every call; `tracer` is the
  process's telemetry and `clock` its time.

`restriction` is the call's alone: it names what this viewer's `readable` forbids, so it travels
with it. `createRunner` refuses an env every run would refuse (caps or limits that are not whole
numbers from 1, a `health` or `inflight` not made by `createHealth` or `createInflight`) when it is
made, not at the first call. Given no `cache`, a runner keeps the scopes of the gates its runs stop
at, for an hour, and nothing else, so that an approval still covers a part of its keys on resume;
`run(graph, options)` given none keeps nothing, and resumes only the exact gate it stopped at.

The default `digest` is the SHA-256 of the entity and the key id: it keeps a key out of sight, not
out of reach of someone who can guess it. For keys that can be guessed (an email address), give a
keyed HMAC, its secret the same on every instance:

```ts
import { createHmac } from "node:crypto";

const digest = (entity: string, keyId: string) =>
  createHmac("sha256", secret)
    .update(JSON.stringify([entity, keyId]))
    .digest("hex");
const runner = createRunner(graph, { ...env, digest });
```

`digest` is synchronous: the run builds ids where nothing awaits, so an asynchronous HMAC, such as
Web Crypto's `crypto.subtle.sign`, does not fit it.

### Options of the process: `RunEnv`

`createRunner(graph, env)`. Every option has a default.

| Option      | Default                             | Meaning                                                                                                                                                                                                     |
| ----------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cache`     | none: no answer is kept             | A `CachePort`: `getMany(keys)` and `setMany(entries)`, each entry with a retention the application maps to a duration. Without one, every run reads its sources, and only a runner keeps its gates' scopes. |
| `readable`  | every connector                     | `(connector) => true` or why not (`"disabled"`, `"not_configured"`): what the deployment can read. An unreadable loader is not touched, cache included.                                                     |
| `limits`    | none                                | Concurrent loads per connector (`{ db: 8 }`), each a whole number from 1 or `Infinity`, each run counting its own. A connector without a limit is not bounded.                                              |
| `caps`      | none                                | `{ refs, links, rows }`: [Caps](#caps).                                                                                                                                                                     |
| `health`    | none: no breaker, no rate           | From `createHealth`, shared by every run: [Circuit breakers](#protect-sources-with-breakers-and-rate-limits).                                                                                               |
| `inflight`  | none: each run loads what it misses | From `createInflight`, shared by every run: [Single-flight](#share-loads-across-runs).                                                                                                                      |
| `tracer`    | none                                | Where the runs report their spans: [Tracing](#tracing-and-metrics).                                                                                                                                         |
| `digest`    | SHA-256 of the entity and key id    | `(entity, keyId) => string`: how a personal key appears. Pass a keyed HMAC, the same on every instance, for keys that can be guessed (an email address).                                                    |
| `fatal`     | none                                | Errors that reject the run instead of failing their keys (a spent quota). A `CostChangedError` always does.                                                                                                 |
| `retryable` | none                                | Errors worth trying again, as the loader's `retry` says.                                                                                                                                                    |
| `clock`     | `Date.now`                          | The time the deadline is read against.                                                                                                                                                                      |

### Options of a call: `RunCall`

`runner.run(call)`; `runner.read(entity, keys, providers, call)` takes the same without `refs` and
`providers`.

| Option        | Default                                               | Meaning                                                                                                                                |
| ------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `refs`        | required                                              | Base rows: `{ row, entity, key, carries? }`. Several rows may share a key; rows of one key share an answer.                            |
| `providers`   | required                                              | Providers, as declared or by id; each needs a route from every base entity among `refs`, checked by the compiler where it can.         |
| `ctx`         | required, unless the graph's `Ctx` admits `undefined` | The run's values (`today`) and services, as the graph's `Ctx` types them; each loader sees only the keys it declares.                  |
| `readable`    | every connector                                       | This viewer's: `(connector) => true` or `"forbidden"`. Narrows the env's.                                                              |
| `restriction` | `""`                                                  | What makes one viewer's reads unfit for another (their forbidden sources): part of every cache key and gate id, opaque to the library. |
| `caps`        | none                                                  | `{ refs, links, rows }`; under a runner, each the smaller of the env's and the call's.                                                 |
| `deadline`    | none                                                  | Epoch ms: past it nothing starts, running loads are aborted, and the run answers.                                                      |
| `signal`      | none                                                  | An `AbortSignal`: when it aborts, the loads are aborted and the run rejects with its reason.                                           |
| `approved`    | none                                                  | Approved bytes per gate id, from a previous run's `gates`.                                                                             |
| `prices`      | none                                                  | Prices a previous run measured (its `prices`): those gates are not priced again.                                                       |
| `validate`    | `"boundaries"`                                        | `"boundaries"`, `"strict"` or `"off"`: [Validation](#validation).                                                                      |

### Reading by entity

`runner.read(entity, keys, providers, call)` reads providers for keys of one entity: one base row
per key, each under its key's id in `rows` (the key for a string, `String(key)` for a number, the
entity's `id(key)` otherwise), of the key as the run parsed it: with a key schema that turns `"07"`
into 7, the row is `"7"`.

```ts
const result = await runner.read("track", ["t1", "t2"], [summary], { ctx });
result.rows.get("t1")?.providers.trackSummary.rows[0]?.fields.plays; // number
```

- `entity` is one of the graph's, and the keys are typed by what its key schema accepts: a key of
  another type does not compile. One key, or a list; a key that is itself an array (a tuple) is
  given in a list.
- An entity with `context` attributes, which only a base row or a link brings, takes each key with
  them, `{ key, carries }`, and the call does not compile without every one:
  `read("session", [{ key: "s1", carries: { day: "2026-11-01" } }], [plays], { ctx })`. An entity
  without takes bare keys; a base row that brings other carried attributes (a hint) goes through
  `run`.
- The result is `run`'s, unwrapped by nothing: an unknown or a cut is an outcome, never a throw.
- A key that fails its schema rejects the read with a `ValidationError` that names it by its place
  among the keys (`keys[2]`), never by its value. One key given twice with different carried
  attributes would be two answers under one id: refused, by its places, with `HG_DUPLICATE`.
- Each provider needs a route from the entity: one without does not compile, and one asked by an id
  the compiler cannot know is refused when the read runs, before anything is read (`HG_NO_ROUTE`),
  with keys or none.
- The entity's name is one name: one that may be one of several (`cond ? "track" : "artist"`) takes
  no key, nor does a graph typed as a `GraphDef`, whose type says nothing of its entities.
- A personal key is a row id of the result as the caller gave it, since the caller looks its row up
  by it; everywhere else (rows, row steps, lineage, gates) it is its digest, and the trace holds no
  keys.

### The result

The result has, per base row, its providers (`rows`, each with its `fields` and `lineage`; the
`outcome`; the `unknown` reasons, `cut` and `coverage`) and its row steps (what each step said of
each ref on the way); the run's `status` (`complete` or `gated`), `gates`, `billedBytes`, `prices`,
and a `trace` per step and loader (keys in, cached, found, absent, unknown by reason, cut, bytes
billed, time, retries, failures by code). A personal key appears only as its digest, except as a
row id `read` gives back; the trace holds no keys at all; the library logs nothing.

## Outcomes

| Outcome   | Meaning                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `found`   | Rows or links were read. May carry cuts: a per-ref cap, fewer days than asked, a truncated statement, a `oneOf` loader that answered from some of its sources, a cap of the run or the graph ([Caps](#caps)). |
| `absent`  | Every applicable branch ran to the end, uncut, and found nothing. Carries what was searched (`coverage`).                                                                                                     |
| `unknown` | Something was not read. The reason says what.                                                                                                                                                                 |

Reasons for `unknown`: `unread` (the connector is `disabled`, `forbidden` or `not_configured` for
this caller), `failed` (with `why: "open"` when the connector's circuit was open), `too_heavy`
(priced above the approval cap), `awaiting_approval`, `deadline`, `unmet` (a need's hydration was
unknown), `ambiguous` (a verification left a candidate undecided, or a to-one relation found two
targets).

Branches combine by one rule: found if any branch found; absent only if every branch ran to the
end, uncut, and found nothing; unknown otherwise. Where every branch ran (a union of strategies,
the targets of a relation, the paths of a route), a found result still lists the reasons of the
branches it could not read, so a consumer can say "found, but one source was not read". In a
fallback, the strategy that found is the answer, with the reasons of the strategies before it that
could not be read, and the cuts of those that read under one and found nothing, beside it; whatever
is read through it that is absent is unknown instead, since what was not read might have led
elsewhere. An empty answer under a cut is never absent.

## Cost gates and approvals

A loader whose source bills by bytes declares `cost: { metered: { auto, approve } }` and a dry run,
`price(refs, ctx, signal)`. Before it loads, a job prices its missing keys:
- under `auto` bytes it runs, and each call receives in `budget.maxBytes` what is left of the price
  (hand it to the source as its byte limit);
- up to `approve` it stops at a gate: its keys are `unknown: awaiting_approval`, the steps that
  depend on it do not run, everything else does, and the run's `status` is `gated`, with each gate's
  `id`, `loader`, `keys` and `bytes`;
- above `approve` its keys are `unknown: too_heavy`.

To continue past a gate, run the same request again with `approved: { [gate.id]: bytes }` (and
`prices`, the previous run's, so the gate is not priced twice). Everything already read is a cache
hit; the gated read is priced again and runs with the approval as its budget. If the price grew
past the approval, the run rejects with `CostChangedError`, naming every refused gate in `gates`,
and bills nothing: **nothing is billed past an approval**. A gate id names the loader, its version,
the restriction and the keys, never the steps that asked, so it is the same on any instance; within
one run, an approval also covers a later read of a part of its keys.
[`examples/warehouse.ts`](../examples/warehouse.ts) plays the three cases.

**A graph with metered loaders wants a real cache.** A resume is cheap because what the run before
it read comes from the cache. Without one (`cache` left out), every round reads its sources again:
in a chain of two gates, the read behind the first gate is billed again in the round that approves
the second, each time within its approval. A runner given no cache still keeps the gates' scopes,
so a resume is not stopped again for a part of its keys, but it keeps no answer.

A metered job's calls take turns on its budget. A call is charged what its envelope says it billed;
a call that threw is charged the `billedBytes` on its error, or else its whole allowance. Once the
calls have billed the whole budget, the job's other keys are `unknown: failed` (`HG_BUDGET_SPENT`).

## Caps

The application bounds what one request may follow: `caps: { refs, links, rows }` on a run (in the
env, in a call, or both), `caps: { links }` on a relation and `caps: { rows }` on a provider; where
two apply, the smaller wins. Each is a whole number from 1.

| Cap     | Bounds                                       | Past it                                                                                    |
| ------- | -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `refs`  | the refs one step reads                      | The step reads its first refs by key id; the others are not read, nor anything after them. |
| `links` | the links one ref follows through a relation | The ref keeps its first links, in the order its strategies gave them.                      |
| `rows`  | the rows one ref gets from a provider        | The ref keeps its first rows.                                                              |

Past a cap the ref is cut, `{ kind: "capped", cap, limit }`: an answer read under it is found but
cut, an empty one is unknown, never absent. A ref a step did not read for its `refs` cap has a row
step of that step, `unknown` with the cut, and the trace counts it. A cap counts per step, not across the run: steps of
separate branches run side by side, and a count they shared would make which ref is cut depend on
which ran first. So a run reads at most `refs` refs per step of its plan.

## Cancellation and the deadline

A run stops when its caller's `signal` aborts, when its `deadline` passes, or when it fails. Every
`load` and `price` gets a signal that aborts then: hand it to the source's client. Past that point
nothing starts, and the run waits for nothing it started. A load that ignores its signal is left
running (it keeps its connector slots until it ends) and its late answer is dropped.
- Aborted by the caller, the run rejects at once with the signal's reason, as `fetch` does.
- Past the deadline, the run answers: what finished stands and is cached, the rest is
  `unknown: deadline`. The loads see an `AbortedError` whose `why` is `"deadline"`.
- Failed (an error the application calls `fatal`, a refused approval), the loads of the failing
  wave and of later ones are aborted at once (`AbortedError`, `why: "failed"`); the reads of
  earlier waves finish and are kept; then the run rejects with the earliest wave's failure.

Cancelling a billed read is best effort: what the source billed before it stopped is billed.

## Resilience

### Retry failed calls

A call (a load or a dry run) that throws is tried again when its loader declares `retry` and the
run's `retryable(error)` says the error is worth it (a reset connection, a timeout, a 503); by
default nothing is. Retry n waits a random time up to `initialMs × factor^(n-1)`, at most `maxMs`
(full jitter; defaults 100 ms, 10 s, 2), and `attempts` counts the first call. A retry is not tried
when its wait would end past the deadline, for an error the run calls `fatal`, nor into an open
circuit. A metered load retries on what is left of its job's budget, so an error that does not say
what it billed leaves nothing to retry on. The trace counts the retries per step.

### Protect sources with breakers and rate limits

A source's health and its rate limit hold across runs, so both live in one object that the
application creates once and passes to every run:

```ts
const health = createHealth({
  warehouse: {
    breaker: { failures: 5, windowMs: 10_000, coolDownMs: 30_000 },
    rate: { perSecond: 20, burst: 5 },
  },
});
const runner = createRunner(graph, { ...env, health });
health.state("warehouse"); // "closed" | "open" | "half-open"
```

- **Breaker.** After `failures` calls on the connector threw within `windowMs`, it opens for
  `coolDownMs`: its loaders are not called, dry runs included, and their keys are
  `unknown: failed` with `why: "open"` and the connectors. Then one call goes through as a probe;
  its answer closes the circuit, its failure opens it again. A call on several connectors is
  refused when any of their circuits is open.
- **Rate.** A token bucket per connector: `burst` calls may start at once, then `perSecond`. A
  call that finds no token waits in line. The concurrency `limits` still hold per run, beside it.

A run's answer is a function of its inputs, the cache, the approvals and the state of this health
object when each call is made. A breaker is shared by the runs of a process, so its verdicts depend
on timing by nature: a failure of one run, or of a later step of the same run, may open a circuit
before another call reaches it.

### Share loads across runs

Runs given the same `createInflight()` object share their loads: a run whose cache misses a key
another run is loading at that moment (the same cache entry, restriction included) waits for that
load instead of calling the source again. Only what the cache would keep is shared; a run that
stops while it waits waits no more, and the load goes on for the others.

```ts
const inflight = createInflight(); // once per process, beside the cache and the health
const runner = createRunner(graph, { ...env, health, inflight });
```

## Validation

`validate` says which values a run checks against their schemas; a value that passes is read as its
schema parsed it, so a key a schema coerces is read with the type the graph declares.
- `"boundaries"` (the default): the base rows' keys and carried attributes, before anything is
  read; a row that fails, or carries an attribute its entity does not declare, rejects the run with
  a `ValidationError` naming its row and field, never a value. Then what sources say through
  projections: a link's target key, its attributes (the relation's `link` schema) and carried
  attributes, and what a hydrator projects. A key whose projection fails is `unknown: failed`
  (`HG_INVALID` in the trace), and a fallback strategy runs on it.
- `"strict"`: also every envelope a load returns. A key in two buckets is failed instead of
  trusted, and keys not asked, contradicted or missing are reported in the trace.
- `"off"`: no schema runs.

## Tracing and metrics

A run given a `tracer` reports what it does as spans: the run (`hopgraph.run`), each job
(`hopgraph.batch`), and under a job its cache read, its dry runs (`hopgraph.price`), its calls
(`hopgraph.load`) and its cache writes. The interface is OpenTelemetry's shape,
`startSpan(name, attributes, parent?)` returning `{ setAttribute, addEvent, recordError, end }`, so
an OpenTelemetry tracer adapts in about twenty lines ([`examples/otel.ts`](../examples/otel.ts)); the
library depends on none.

```ts
import { trace } from "@opentelemetry/api";
import { otel } from "./otel.ts"; // the adapter in examples/otel.ts

const runner = createRunner(graph, { ...env, tracer: otel(trace.getTracer("hopgraph")) });
```

Attributes are ids, counts, bytes, durations and outcomes; a failure is its code and class, never
its message; no attribute holds a key. A job's span carries its loader's metrics: keys, cache hits,
calls, attempts, retries, bytes billed and times. A tracer that adds them up gives the application
its metrics with no metrics library; [`examples/metrics.ts`](../examples/metrics.ts) does it per
loader. A tracer that throws, or whose methods return a promise that rejects, never affects the
run. DESIGN.md §6 lists every span and attribute: their names are public API.

## Errors

Every error Hopgraph throws is a `HopgraphError` with a stable `code`, and its message starts with
`hopgraph: ` and holds no key, value or source message. A caller switches on the code:
`DefinitionError` (the builder, the plan or `checkGraph` refuses the graph: `HG_NO_ROUTE`,
`HG_PATH`, …), `ValidationError` (`HG_INVALID`, base rows that do not match their schemas, by row
and field), `CostChangedError` (`HG_COST_CHANGED`, approved gates priced higher) and `AbortedError`
(`HG_ABORTED`, the reason on a load's signal when the run stopped it). DESIGN.md §5.4 has the table
of every code.

A load that fails is not an error of the run: its keys are `unknown: failed` and the trace keeps
the failure by its code (`ECONNRESET`) and class, never its message.

## What it does not do

- It does not search for paths at run time, and does not choose between routes by cost: a route
  is declared, because a cheaper path can change what a field means.
- It has no query language and no transport: it is a library function over in-process values.
- It does not run a field's schema on the values a provider projects.
- It does not filter fields: a run returns every field of each requested provider.
- It does not aggregate, join across providers, or compute a value from two providers: that is
  left to the consumer.
- It does not write, and has no transactions.
- It does not retry a load that answered: a key an envelope reports failed stays failed for the
  run.
- It does not guarantee cancellation: what a source billed before it stopped is billed.
- It keeps no state between runs except in what the application gives every run: the cache port,
  and the objects `createHealth` and `createInflight` make. A runner holds the graph and the env,
  and, given no cache, the scopes of its gates.

## Examples

Each is a complete program, run by a test on every `npm test`, so it cannot fall behind the library.
They run TypeScript directly (Node 22.18 or later).

| Example                                             | Shows                                                                                                                    | Run                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| [`examples/playlist.ts`](../examples/playlist.ts)   | In-memory sources read by key through a runner: batching, a derived field, a switched-off source reported as unread.     | `npm run example`           |
| [`examples/sql.ts`](../examples/sql.ts)             | A SQL-like source: statements of N keys, a window per ref, a per-key cap reported as a cut, a failed statement, `oneOf`. | `npm run example:sql`       |
| [`examples/warehouse.ts`](../examples/warehouse.ts) | A billed warehouse: a dry run, a gate, an approval, the bill, a resume whose price grew.                                 | `npm run example:warehouse` |
| [`examples/otel.ts`](../examples/otel.ts)           | An OpenTelemetry adapter for `tracer`.                                                                                   | its test                    |
| [`examples/metrics.ts`](../examples/metrics.ts)     | Per-loader metrics from the spans, with no metrics library.                                                              | its test                    |

## Versioning

Hopgraph follows [Semantic Versioning](https://semver.org). Its public API is:
- what the package entry point exports, with the types of its signatures, as
  [`api/hopgraph.api.md`](../api/hopgraph.api.md) records it;
- the behaviour this README and DESIGN.md document: what each outcome and reason means, when a key
  is absent, that nothing is billed past an approval, what a result shows of a personal key;
- the names of the spans a tracer receives and of their attributes, with what each counts.

It does not include modules under `dist/` other than the entry point, the order of a list the
contract leaves unordered, the timings in the trace and the spans, or the text of an error message.

Before 1.0, a minor release (0.y.0) may break the public API, and every break is in the changelog
with its before and after in MIGRATION.md; a patch release (0.y.z) never does. From 1.0:
- **Major**: a change that breaks code that compiled and ran. An export removed or renamed; a
  parameter, option or field made required; a type the consumer passes narrowed; a type the
  library returns changed other than by a new optional field or a new union member; a documented
  meaning changed (an outcome, a reason, a guarantee, the cost rule).
- **Minor**: an addition. An export, an optional option, an optional field in a result, a new
  member of a union the library hands back (`UnknownReason`, `Cut`, an error code, a span's
  `admission` or `outcome`), a new span or span attribute: code that switches over them should keep
  a default branch. Also a new format of cache entry keys or gate ids
  (every entry misses once, an approval given before is asked again), listed under "Changed", and
  a higher minimum Node or TypeScript version, once the lower one has reached its end of life.
- **Patch**: a fix that makes the code do what the documentation already says, listed under
  "Fixed", even when a consumer relied on the bug.

A deprecated export or option stays for at least one minor release, marked `@deprecated` and listed
in the changelog, before a major release removes it. The API report makes every change to the
public API visible in review: CI fails when the build's API and the report differ.

## Contributing

```sh
npm install
npm run check   # typecheck, lint, test with coverage, run the property tests, build,
                # compare the API report, smoke-test the build
```

[CONTRIBUTING.md](../CONTRIBUTING.md) lists every command, the layout of the repository, the bar a
change meets, and how the property tests replay a seed. [SECURITY.md](../SECURITY.md) says how to
report a vulnerability, and what the library guarantees about keys.

## License

MIT: see [LICENSE](../LICENSE).
