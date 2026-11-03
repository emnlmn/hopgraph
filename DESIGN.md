# Hopgraph: design

This document is the reference: why Hopgraph is built the way it is, and every rule the executor
follows, with the error codes (§5.4), the spans (§6) and the id formats (§5.2, `src/run/ids.ts`).
The README is the guide, with each option and its default; `docs/api/` is the API reference. This
document describes the code in `src/` as it is; where the code leaves something open, §11 says so.
Section numbers are stable: source comments refer to them (`DESIGN.md §5.2`).

Hopgraph is a small TypeScript library for reading across heterogeneous sources by key. An
application declares its entities, the loaders that read its sources, the relations between
entities and the fields that hang on them, each with what it means; it then asks for providers of
a set of base rows and gets them read in batches, cached per key, priced, gated and explained. It
knows nothing about any domain.

## 1. Problem

A consumer that shows fields from many sources for a set of rows needs, for every field, a walk
from the row's key to the key its source is read by. Written by hand, that walk is repeated in
every feature, each copy picks its own window, limit and fallback, and nothing fails when a new
source or a new kind of base row lacks a piece. How keys correlate is costly knowledge, and it has
no single place to live.

## 2. Goals and non-goals

Goals:
1. One declaration of every entity, relation and field source, used by every consumer.
2. A typed template: adding a base, a relation or a source without every piece fails `tsc` or the
   graph test, not code review.
3. Faithful answers: a row is told "absent" only when every way to find it ran to the end;
   anything else is "unknown", with the reason.
4. Cost under control: one job per loader per wave, a per-key cache shared by every consumer, paid
   reads priced and approved before they run.
5. Explained reads: every read explains itself, without leaking personal keys.
6. Fields with meaning: every field carries the application's metadata type, and a value computed
   from raw values is declared once, next to them (§3.5).

Non-goals: path search at run time; a query language or a transport; schema inference;
cost-based optimisation; transactions across sources; measures and aggregation; writes (§9).

## 3. Model

| Concept      | What it is                                                                                                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Entity**   | A kind of thing with a key other sources are read by. Declares its key schema, its carried attributes, which of them only context brings, and whether the key is personal.                                          |
| **Ref**      | One entity instance during a run: its key plus the carried attributes that came with it. Two links that bring different values for one key reach two refs.                                                          |
| **Loader**   | The unit of I/O. Reads one source by keys of one entity, in batches, with a cache entry per key, a retention, a failure policy and, for a paid source, a cost. Everything that touches a source is a loader.        |
| **Relation** | A named, directed `from › to:name` between entities, with a cardinality and link attributes. Evaluated by one or more strategies combined as `fallback` or `union`, and optionally verified.                        |
| **Strategy** | A pure projection of a loader's per-key value into links, plus the needs and hints it reads on the `from` ref.                                                                                                      |
| **Link**     | One `from` key, one `to` key, its attributes and the strategy that produced it. Two links to the same target are never merged. Its attributes appear in the lineage, so personal context travels as carried values. |
| **Provider** | A set of fields keyed by one entity: a pure projection of a loader's value into rows. Historical or current-state, declared.                                                                                        |
| **Field**    | One value a provider offers per row: the application's `Meta` and an optional value schema. Raw (projected from the loader) or derived (computed from raw fields of the same provider).                             |
| **Route**    | For one (base, provider) pair, the relation paths that reach the provider's entity, combined as a union (every path on every row). Declared by the application, checked by a test.                                  |
| **Outcome**  | Per ref and step: `found`, `absent` (within a stated coverage) or `unknown` (with a reason).                                                                                                                        |

### 3.1 Loaders, and why relations do not read

One source read often answers several questions. A per-key read of an artist's plays yields the
tracks played, the venues played at and the play counts; modelled as three strategies that each
read, it is three paid jobs. So I/O lives in loaders and everything above them is projection:
two relations and a provider over one loader cost one job per batch of missing keys.

```ts
const plays = g.loader({
  id: "plays",
  version: 3, // part of every cache key: bump it when the value changes shape or meaning
  keyedBy: "artist",
  needs: ["since"], // carried attributes the load reads besides the key
  ctx: ["today"], // run values it reads; data ones are part of the cache key
  connectors: { allOf: ["warehouse"] }, // or { oneOf: [...] }: available when one is readable
  batch: { by: "partition" }, // | { by: "keys", max: 500 } | { by: "one", concurrency: 4 }
  cost: { metered: { auto: 2e9, approve: 6e10 } }, // free sources omit cost and price
  price: async (refs, ctx, signal) => dryRunBytes(refs, ctx, signal),
  keep: (o) => (o.found ? "day" : "brief"), // decided on the outcome, never the value
  partial: "keep", // or "drop": one failed statement voids the batch
  // -> Envelope; `signal` aborts when the run stops waiting (§5.3): hand it to the client
  load: async (refs, ctx, budget, signal) => readPlays(refs, ctx, budget.maxBytes, signal),
});
```

The **envelope** a load returns says what happened, per key and per call:
`{ values: [K, V][], absent: K[], unknown: [K, Reason][], cut: [K, Cut][], coverage?, billedBytes, errors }`
(pairs, not maps: a key may be an object, and the executor compares keys by the entity's `id`).
A load never throws for a key it could not read; it reports it, as `failed` or, when it knows its
source is not readable for this caller, `unread`. The other reasons are the run's: a load that
claimed one (an approval awaited) would stop a fallback at a gate nobody can approve, so a run
reads any other reason an envelope gives as `failed`. A key the envelope does not mention is
failed, never absent. `envelope(answers)` builds one from per-key answers.

A call never holds two refs with the same key: the executor splits refs of one key with different
need values into separate calls (layers), so a load keys its envelope by `ref.key` and nothing is
matched by position. A loader may instead declare `merge`: refs of one key whose needs differ (a
venue reached by three tracks, each with its own window) are read once, with `merge.needs` of
them all, and each ref keeps what `merge.narrow` selects for its own needs, absent when nothing is
left. A merged read that came back cut leaves every ref cut (`merge.empty` when nothing of it is
left), never absent: what was past the cut was not read for any of them. A loader with hints
cannot merge. A per-ref cap belongs inside the query (a `QUALIFY ROW_NUMBER()`), and the loader
reports the keys it cut; the executor trims after reading, when the cost is already paid, only
under a cap the application sets on what a run follows (§5.8).

**Batching is the loader's**: by key count for row stores, by partition set for warehouses billed
by bytes scanned (one job for all keys over the union of their partitions, never chunks that
re-read the same partitions), one key at a time with bounded concurrency for APIs without a batch
endpoint. **Concurrency is the connector's**: the application gives each connector a limit (a
database pool, an API's rate), and the executor holds every loader on that connector under it. A
load holds a slot on each connector it reads (for `oneOf`, on the readable ones), and a `one`
loader also one of its own; slots are taken in one order, so two loads never wait on each other.

A failed statement is reported in `errors` (a code and how many keys it took, never a driver's
message). With `partial: "drop"` an envelope with any error fails every key of its call; with
`"keep"`, the default, only the keys it reports unknown. A load that throws instead fails every key of its call,
and the trace keeps the error's own `code` with its class, never its message (§5.4).

### 3.2 Needs

A load or a projection may need values beyond the key. Each need comes from one of three places:
- **carried**: an attribute of the ref, produced by the entity's hydrator (itself a loader keyed by
  the entity, reading by key alone). A window that depends on the ref (its date ± 30 days) is
  computed by the loader from carried attributes, so a ref from last year next to one from today
  does not read the year between them.
- **context** (not to be confused with `ctx`, below): a carried attribute the link that reached the
  ref brings (`carries` in the projection's output), or the base row itself. The entity declares
  it in `context`, so the graph check asks no hydrator for it: a session reached from a track of
  3 March is read over the days around 3 March.
- **ctx**: a value of the run that depends only on the request (`today`, a fixed look-back),
  declared by the loader in `ctx`.

What came with a ref (from the base row, or from the link that reached it) wins over the hydrator.
A step whose given values already hold every need it can hydrate sees those alone, so what it
reads never depends on whether another step hydrated the key first.

A load's answer is a function of its key **and its needs**: the same key reached with different
need values is two loader keys, answered and attributed separately along their own links, and both
travel in the same job. So a key's answer never depends on the other keys of the batch: a read
over a union of partitions filters each key by its own window inside the query, and a cap is per
key (`QUALIFY ROW_NUMBER() OVER (PARTITION BY key)`), never a LIMIT shared by the statement.

A **hint** is a carried attribute read when present (`hints: ["kind"]`: an id's type when the base
row gave it). It never triggers hydration (a value hydrated for another need is passed), it is
never a reason to be unknown, and its value is part of the loader key like a need's.

A loader declares needs and reads them typed in `load(refs)`; a strategy declares the ones its
projection reads. The executor hands either only refs whose needs are present, typed as required.
A need missing because its hydration was unknown makes the ref `unknown: unmet` for that step,
never absent. A need missing because its hydration found the entity **absent** makes the step
absent for that ref, with the hydration's coverage: a session missing from the index has no
plays to read.

### 3.3 Relations: names, strategies, verification

The same pair of entities can relate in ways that mean different things: "the tracks of an
artist in the last six months, 500 per statement" and "the latest 50 tracks of an artist per
catalog, any age" change results if unified. Window, order and per-ref cap are part of meaning, so
they are part of the relation's name (`artist › track:recent`, `artist › track:latest`).
Consumers pick by name.

Strategies of one relation combine as:
- `fallback`: strategy _n + 1_ runs on the refs strategy _n_ did not find. Found if any found;
  absent only if every strategy ran uncut and found nothing; otherwise unknown. A strategy that
  stopped at a cost gate (`awaiting_approval`) stops the fallback for that ref: the approval may
  make the next strategy unnecessary. A strategy that could not be read (`unread`, `failed`, an
  open circuit, `too_heavy`, `unmet`), or that read under a cut and found nothing (fewer days than
  asked, a capped statement), does not stop it either: the next one runs, and what it finds stands,
  found, with the reason or the cut of the strategy it went past beside it. That reason or cut
  travels with the links: whatever is read through them that is absent is unknown instead, with
  it, since what was not read might have led elsewhere (to an artist with a profile, where the
  next strategy led to one without). A strategy before it that read the whole and found nothing
  adds nothing, so a fallback whose earlier strategies all read uncut and found nothing still gives
  absent.
- `union`: every strategy runs on every ref and links are concatenated. Absent only if all are
  absent; unknown if any is unknown and none found.

A found value that projects to no link is an absence for that strategy, within what it searched.

A relation may end with a **verification**: a loader keyed by the relation's `to`, read on the
candidate targets in one job, and a rule that sees all the candidates of one `from` ref at once,
each with that read's state (found, absent, unknown) and value, and keeps, drops or leaves
undecided each one (a bare id found in several tables, kept where a second source confirms it, the
others dropped when one is confirmed). Undecided candidates stay, marked ambiguous, and whatever
is read through them carries the reason `ambiguous`. A strategy whose candidates were all dropped
found nothing.

A relation's **cardinality** says how many targets a ref may have. One that says one (`1:1`, `N:1`:
a track has one performer) and whose strategies, verification included, leave two distinct targets
for a ref is `unknown: ambiguous` for that ref, with no link: two performers are not an answer it
declares, so neither is read through it, and whatever the route reaches through that ref is
unknown. Two links to one target are one target. The strategies' row steps still say what each
found. `1:N` and `N:N` take every target. The `from` side (`1:` against `N:`) is not checked: a ref
sees its own targets, not the refs that share them. Two links to one key that bring different
carried values reach two refs of it (§3), each read with its own values: one target, read twice.

### 3.4 Outcomes and reasons

Three values per ref and step, so "not found" and "not read" never blur:

| Outcome   | Meaning                                                                                                                                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `found`   | links, rows or a value; may carry cuts: `cap` (a per-ref cap), `days` (fewer days read than asked), `truncated` (a statement's LIMIT reached), `sources` (a `oneOf` loader answered from some of its sources), `capped` (a cap of the run or the graph, §5.8) |
| `absent`  | every applicable strategy ran to the end, uncut; carries the coverage searched (a window, a look-back), declared by the strategy or reported per key by the load                                                                                              |
| `unknown` | with a reason: `unread` (`disabled`, `forbidden`, `not_configured`, with the connectors), `failed` (`why: "open"` when a circuit refused the call, §5.7), `too_heavy`, `awaiting_approval`, `deadline`, `unmet`, `ambiguous` (§3.3)                           |

`unknown` propagates: a provider read through an unknown step is unknown for that base row, and
the consumer says so. Several branches (strategies, the targets a link fans out to, the paths of a
route) make one answer by one rule: found if any branch found; absent only if every branch ran to
the end, uncut, and found nothing; unknown otherwise. Where every branch ran (a union, the targets
of a relation, the paths of a route), a found answer keeps the reasons and cuts of the others
beside it, so the consumer can say "found, but one source was not read". In a fallback the branch
that found is the answer, and the reasons and cuts of the branches before it that were not read
whole stay beside it in the same way (§3.3): an answer that depends on what nobody read is never
absent.

### 3.5 Fields: meaning and derivation

A raw column is right and still useless to someone who does not know what it holds: a user id is
a listening channel once a rule reads it. That rule and that explanation belong to the field, once,
not to every page that shows it.

```ts
const g = hopgraph<Ctx, Meta>().entities({ track, artist }); // Meta: the application's type

g.provider("trackStreams", {
  loader: trackHeader,
  temporal: "historical",
  rows: "many",
  project: (track) => track.streams, // the provider's rows for one key
  raw: { market: { meta: { label: "Market" } }, user: { meta: { label: "User" } } },
  derived: (d) => ({
    channel: d(["user"], ({ user }) => channelOf(user), { meta: { label: "Channel" } }),
  }),
});
```

- **Rows.** `project(value, key)` returns the provider's rows for a key (one element when
  `rows: "one"`). Every projected value must have a raw field with its `Meta`: `raw` is checked
  against the projection's type. A value that projects to no row is absent.
- **Meta.** `Meta` is the application's, required on every field and opaque to the library:
  Hopgraph types it, demands it and hands it back, never reads it. Labels, descriptions,
  vocabularies, what a viewer may see: all belong to the application.
- **Derived fields.** A derived field is a pure function of raw fields of its own provider (same
  key, same read): no I/O, no field of another provider. Its function receives exactly its inputs.
  A value that needs two providers is the consumer's computation.
- **Catalog.** `g.catalog()` lists every field with its provider, entity, kind,
  `Meta`, temporal and row kind and, for a derived field, the raw fields it reads. The application
  builds its field picker, search and documentation from it, so they cannot drift from the code.

## 4. Routes: declared, not searched

Choosing a path by cost changes meaning: the address an artist registered and the address typed
when a track was uploaded are both "the email of the track", and a new cheaper relation would
silently change every report that already exists. So the run time has no path finder.

```ts
export const graph = g.graph(
  g.route(
    "track",
    campaignSends,
    g.union(
      g.path(performer, registeredEmail), // track › artist:performer, artist › email:registered
      g.path(typedEmail), // track › email:typed
    ),
  ),
  g.route("track", trackStreams, g.itself("track")), // the provider is keyed by the base entity
);
```

The compiler refuses a path that does not chain, a path that does not start at the base, a union
of paths with different ends, and `itself(base)` for a provider keyed by another entity (§7).
`itself` is the path of no relation: the one spelling for a provider keyed by the base, alone or
in a union (`g.union(g.itself("artist"), g.path(referred))`).

A route is a value: `g.route()` checks it and declares nothing, and `g.graph(...routes)` takes the
graph's routes, all of them, refusing one given twice (`HG_DUPLICATE`) or made on another graph
(`HG_FOREIGN`). So the routes are in the graph's type, `Graph<E, Ctx, Meta, R>`, `R` the union of
its `Route<base, provider>`, and a call site is checked against them (§7): a provider asked for
rows of an entity no route joins it to does not compile. They used to be statements, `g.route()`
on a line of its own registering into the builder; a statement changes nothing's type, so the
compiler could check each path but not which pairs exist, and a missing one was a run-time
`HG_NO_ROUTE`. The run still refuses one (§5.1), for what the types cannot see: rows whose
entities are `string`, an id that is `string`, a graph whose types were forgotten (`GraphDef`).
A graph's routes, like its `Ctx`, are invariant in its type: a graph or a runner of some routes is
not one of more, which would let a read ask what nothing routes.

A path finder runs in a test over the declared graph: `checkGraph(graph, { bases, maxDepth })`. It
reports a (base, provider) pair with no route, a route whose path does not chain (when built
without the compiler's help), a route from an entity that is not a base or to an unknown provider,
a loader nothing uses, and an entity whose needed attributes have no hydrator. It also returns
every simple path (up to `maxDepth` relations, default 4) that no route uses; the application
writes them to a committed file, so a new relation that opens a new way shows up in review, where
a person decides whether a route should use it.

Routes combine paths only as a union. A route-level fallback (path n + 1 on the rows path n did not
find) and a declared unreachable pair were built and removed: no route used them. Strategies of a
relation still combine as `fallback` or `union` (§3.3). Add either back when a route needs it.

## 5. Executor

`run(graph, options)` reads the requested providers for the base rows of one or more entities: a
track row and an artist row whose routes share a step make one job of it. The options are listed
in the README; the contract is `src/run/types.ts`. A runner gives the options that hold for the
process once, and reads by entity (§5.9).

### 5.1 Plan and schedule

The plan has one node per base entity, one per relation and one per provider: a relation or a
provider is one step for the whole run, shared by every path through it, and runs once over every
ref that reaches it. Shared prefixes, and steps several bases reach (even at different depths),
are read once. Requested routes that order two relations both ways cannot share their steps: the
plan refuses them, naming the cycle, before anything is read; asked in separate runs they work.

A node starts when every node feeding it is done; nodes that do not depend on each other run side
by side. Within a node, what is computed per ref is kept per step and ref identity (the key and
the values the step reads), so two routes that meet a ref ask for it once.

### 5.2 Reads, waves and the cache

Every step reads through one place (`src/run/reads.ts`), and every read has a **wave**: one more
than the wave its step had reached, the reads of the steps that fed it included. Every read of
one loader in one wave, whatever step asked (a strategy, a verification, a hydration, a provider),
is one **job**: one cache lookup, one price and one set of calls (`src/run/job.ts`). A read whose
keys an earlier job answered still takes its wave, and a key that two waves ask is fetched by the
earlier one.

**When a job starts** (`src/run/schedule.ts`). A loader's job of wave n starts once nothing behind
it can still add keys to it: no work of a wave before n is running, or waiting for a read, in a
plan node that may read the loader, directly or through the nodes after it. A loader's jobs run one
after the other, in wave order. What a node may read comes from the plan (its strategies', its
verification's and its provider's loaders, and the hydrator of an entity whose attributes they
need), so a node that ends up not reading a loader (for example, a fallback whose earlier strategy
found) holds that loader's job back longer than needed, never less. Work between two reads is
microtasks, except an asynchronous validator, which the step declares so that it holds back what
it could still add keys to. A provider's validators run after its read, and nothing reads after a
provider, so they hold nothing back.

The rule used to be a barrier: wave n started once every read of wave n − 1 had ended, so a step
behind a fast read waited for the slowest read of its wave, related or not, and so did every wave
after it. The barrier is this rule with every node treated as able to read every loader. Both rules
form the same jobs, so no loader is called more often; the new rule only starts sooner the jobs
nothing can still add keys to. The property tests play every scenario under both and compare them
(§12).

**What timing used to decide.** Under the barrier, which reads shared a wave depended on which call
ended first: a step whose read another step had already answered went on at once and joined an
earlier wave. Now a read takes its wave whatever it finds, so the waves, and the jobs, are a
function of the plan and of what the sources answer. What a job did is then given out in an order
the inputs decide: its keys are cut into the loader's batches in key order, so which keys a call
that throws takes with it does not depend on who asked first; a key it loads is loaded for the
asking step with the smallest id and cached (answered by another step) for the others; and its
bill, failures and retries go to that step. A key's hydration is read by every step that lacks it,
and recorded once, by the step that asked for it in the earliest wave.

A step still waiting for some of its inputs offers the refs it already has, so a job of a later
wave that reads the same loader anyway takes their keys too, up to the wave the step starts in;
an offer never starts a job of its own.

For one loader in one job:
1. A loader whose connectors this caller may not read (`readable`) is not run, and the cache is
   not touched: a disabled connector never shows data. Its keys are `unknown: unread`.
2. Once the run has stopped (past its deadline, aborted, failed: §5.3), nothing starts:
   `unknown: deadline`.
3. Keys already answered in this run are taken from the run's own answers.
4. The cache is asked for every other key at once; only the missing keys go on. A missing key
   another run is loading at that moment is waited for, when the runs share their loads (§5.7).
5. A metered loader is priced and gated (§5.3).
6. The missing keys are loaded in the loader's batches, in key order, under the connectors'
   limits; a metered loader's calls take turns on the job's budget (§5.3).
7. Found and absent answers are written back with the retention `keep` gives; an unknown is
   never kept, so the next run reads it again.

**Cache keys** cover `(loader id, loader version, key id, the needs' and hints' values, the
declared ctx values that are data, restriction)`. `today` makes an entry per day; a service in the
ctx (a client, a pool) is not part of the key. `restriction` is whatever the application says makes
one viewer's read unfit for another (a set of forbidden sources); the library treats it as opaque.
A run that gives none reads as every viewer alike (`""`).

A key is `hopgraph:1:answer:<loader id>:<loader version>:<D>`, where D is the SHA-256 (hex) of the
JSON of those parts with object keys sorted (`src/run/ids.ts` gives every format). Two requests
that shared an entry would share an answer, across viewers too, so the digest must not collide: a
53-bit hash would, at the scale of a shared cache, by chance. The SHA-256 is computed in the
library (pure TypeScript, synchronous: the ids are built where nothing awaits), so the same
request has the same key on every runtime, in every process and in every version that writes
format 1; tests pin each format to its text. The loader's id and version stay readable, so an
operator drops a loader's entries by prefix; the key id is hashed, so a personal key is not in the
store's key space in clear. **Retention** is per key, from `keep`, which sees the outcome and the
first cut, never the value: a key absent today may be found tonight, so it is kept briefly. A
loader that declares no `keep` keeps a whole found answer for a `day` and an absent or a cut one
`brief`ly. The application maps each retention to a duration in its `CachePort`.

### 5.3 Gates, limits, deadline and cancellation

A metered loader prices its missing keys before it loads, one dry run per call layer, and is gated
once for the whole job. Under its `auto` cap it runs with the price as its budget; up to its
`approve` cap its keys are `unknown: awaiting_approval` and the run records a gate with the price;
above it the keys are `unknown: too_heavy`. A gated step and the steps that depend on it do not
run; everything else that could run, runs, and the result's status is `gated`. A price that throws
or is not a finite non-negative number fails its keys; nothing is billed.

**A job's budget is shared by its calls.** A loader that makes several calls in a job (`by:
"keys"`, `by: "one"`) is priced once for all of them, and a job's fixed scan (a dimension table
every statement joins) makes the calls together cost more than the price. So every call of a
metered job draws from what is left of the budget the job was priced and approved at: the calls
take turns, and each is told (`budget.maxBytes`) what the ones before it left. A call is charged
what its envelope says it billed; one that threw, what its error says (`billedBytes`), else all it
was told, since the source may have billed the job before the answer was lost. Once the calls have
billed the whole budget, the job's other keys are not loaded: `unknown: failed`, traced under
`HG_BUDGET_SPENT`. A zero budget is never spent: a job priced at zero runs every call, each with a
`budget.maxBytes` of 0. The other ways to keep the rule were each worse: a dry run per call
prices and gates every call apart (more dry runs, gates nobody can approve as one); the budget
split among the calls in advance starves every call of a job with a fixed scan. The cost of taking
turns is time: the calls of one metered job do not overlap. A warehouse read in one call per job
(`by: "partition"`) is not affected.

Concurrency is held per connector (§3.1). A connector without a limit is not bounded by the run;
its loaders' batching still bounds them.

**Cancellation.** A run stops for one of three things: its caller's `signal` aborts, its
`deadline` (epoch milliseconds) passes, or it fails (an error that rejects it, §5.4). Every load
and dry run gets an `AbortSignal`, its last argument, that aborts then, so a source whose client
honours it stops working for nobody. Past that point nothing starts, and the run waits for
nothing it started: a load, a dry run, a cache read or write, a wait for a connector slot. A load
that ignores its signal is left running and keeps its connector slots until it ends, so the
connector's limit still counts it; its answer, when it comes, is dropped, never kept.

The three differ in what the run does next. Aborted by its caller, the run rejects at once with the
signal's reason, as `fetch` does: nobody waits for an answer. Past the deadline, the run answers:
what finished stands and is cached, every key not answered is `unknown: deadline`, those of the
loads that were running included; the loads see an `AbortedError` with `why: "deadline"`. Failed,
the run rejects with what failed it, and the loads see an `AbortedError` with `why: "failed"` and
that error as its cause, so a refused approval never leaves loads billing for nothing. A failure
(a refused approval, an error the application declares fatal) stops the loads of its wave and of
later ones at once, and lets the jobs of earlier waves finish before the run rejects with the
earliest wave's failure (§5.4); each job has a signal of its own for that.

The deadline is watched twice: a timer aborts what runs at the instant, and the run's clock is
read before anything starts and when a load answers, so a clock the application gives is obeyed
even where it is not the time the timer counts. An answer that arrives after the deadline is late
whichever noticed first.

Cancelling a billed read is best effort. What the source billed before it stopped is billed, and an
answer the run dropped takes its bill with it: the trace's billed bytes count what was answered in
time.

### 5.4 Resume and errors

**Resume through the cache.** An approved run is the same run again, on any instance, with
`approved: { [gateId]: bytes }`. Every step already read is a cache hit; the gated read re-prices
its keys and runs with the approval as its budget, or rejects the run with `CostChangedError` if
the price grew past the approval, never billing it. There is no frontier to store.

**Several refusals.** A resume can find several approvals short. Rejecting at the first refusal
named whichever dry run ended first, and the consumer met the others one round at a time. So the
first refusal does not stop the run at once: it stops what would load in its wave and in later
ones (the loads already running are aborted), the jobs of earlier waves finish, every job of its
wave is priced, and then the run rejects with one `CostChangedError` whose `gates` lists every
refused gate of the earliest wave that refused one, by gate id; `gate`, `approved` and `priced` are
the first. The list depends on the request, the approvals and the sources only: the jobs of earlier
waves are the ones a barrier would have finished before reaching the refused wave, and they are
kept, so the next round reads them from the cache. A refusal found first in a later wave gives way
to one of an earlier wave. What the loads of the refused wave and of later ones billed before they
were aborted is billed, as for any failed run.

**Which failure.** An error a job throws that fails the run (one the application declares fatal, a
cache port that throws) is held the same way, so that a run fails with the failure of the earliest
wave, whichever call ended first, as it did under the barrier, where nothing of a later wave had
started. In one
wave a refusal comes before a thrown error: every dry run of the wave ends, while a load that would
throw may have been stopped by the refusal first. Of two errors thrown in one wave, the run rejects
with the one of the job whose smallest step id comes first (then by loader id), as refusals are
named by gate id. An error that fails the run is heard where it is thrown, before the call lets go
of its connector slots: a load waiting for the slot must not start once the run has failed. So a
load that fails the run stops the other loads of its wave at once, and an error one of them would
have thrown after it is not seen; two dry runs of one wave that fail are both seen, since a failure
lets the dry runs of its wave end.

**What a gate names.** A gate id is `<loader id>:<D>`, D the SHA-256 of the loader, its version,
the restriction and the loader keys to load, in any order; each loader key enters as a token, the
first 128 bits of the SHA-256 of the key id, the key as results show it (a personal key by its
digest) and the values the load reads of it. The id does not name the steps that asked. A wave
gathers whichever steps are ready, and on resume the cache answers what was read, so the same keys
can come from other steps or split across waves: an id that named the steps stopped such a resume
at a gate of another id, for keys a person had approved. The person approves loading these keys
of this source for this viewer at this price; which step wanted them is shown beside the gate
(`Gate.step`), not part of what is approved. A gate id cannot be recomputed from a guessed
personal key without the digest's secret, since its tokens hash the digest too; that is also why
the digest must be the same on every instance (an HMAC with a fixed key).

**An approval covers a part of its keys.** Within one run, an approval also covers a later read of
a subset of its keys, at no higher price than what is left of it: the keys of one gated wave may
come back in two waves, or some may be cached by then. Each part runs with its own price as its
budget and spends it, so the parts of one approval never get more than its bytes between them, and
nothing is billed past an approval. To know a gate's keys on resume, the run that stops at a gate
writes its scope (its tokens) through the cache port, under `hopgraph:1:gate:<gate id>` for an
hour, a person's time to decide. The trade-offs:
- An approval whose scope the cache lost (evicted, another store, or no cache: a runner given none
  keeps its gates' scopes itself, §5.9, a bare `run` does not) covers its own id only, and a part
  of it stops at a gate of its own: a second approval round, never a load nobody approved.
- A part runs on its own price, not on the approval, so a dry run that underestimates it leaves
  the load to refuse the job under its budget (its keys fail) instead of billing up to the
  approval as a whole request would.
- Parts priced separately may cost more than the whole (a warehouse scans the same partitions for
  each): the part that would go past what is left stops at a gate.
- An approval is not a budget across runs: like the approval of a whole request, each run that
  passes it may spend it once more on what its cache does not hold.

A load or a price that throws fails its keys (`unknown: failed`, the error kept by its own code and
class, never its message) and the run goes on, except a `CostChangedError` and what the
application declares `fatal` (a spent quota: never "not read"), which reject the whole run.

**Errors.** Every error Hopgraph throws is a `HopgraphError` with a stable `code` and a message that
starts with `hopgraph: ` and holds no key, value or source message: `DefinitionError` for what the
builder, the plan or `checkGraph` refuses, `ValidationError` for base rows (§5.6),
`CostChangedError`, and `AbortedError`, the reason a load's signal carries when the run stopped it.
A caller switches on the code; the words may change.

| Class              | Code                  | When                                                                                                                       |
| ------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `DefinitionError`  | `HG_UNKNOWN_ENTITY`   | a name that is not a declared entity                                                                                       |
|                    | `HG_UNKNOWN_PROVIDER` | a provider id that is not declared                                                                                         |
|                    | `HG_UNKNOWN_RELATION` | a route names a relation that is not declared                                                                              |
|                    | `HG_DUPLICATE`        | a loader, relation, provider, route or hydrator declared twice; a read's key given twice with different carried attributes |
|                    | `HG_FOREIGN`          | a loader, provider or route declared on another graph                                                                      |
|                    | `HG_KEYED_BY`         | a hydrator's, strategy's or verification's loader keyed by another entity                                                  |
|                    | `HG_SPEC`             | a declaration that contradicts itself (metered without price, …)                                                           |
|                    | `HG_PATH`             | a route whose path does not chain or does not reach the provider's entity                                                  |
|                    | `HG_NO_ROUTE`         | a (base, provider) pair with no route                                                                                      |
|                    | `HG_CYCLE`            | requested routes that order two relations both ways                                                                        |
| `ValidationError`  | `HG_INVALID`          | base rows that do not match their entity's schemas (`rows`: row, field)                                                    |
| `CostChangedError` | `HG_COST_CHANGED`     | approved gates priced higher on resume (`gate`, `approved`, `priced`, `gates`)                                             |
| `AbortedError`     | `HG_ABORTED`          | the reason on a load's signal when the run stopped it (`why`, `cause`)                                                     |
| `HopgraphError`    | `HG_INTERNAL`         | an invariant of the executor broke: a bug in Hopgraph                                                                      |

`checkGraph` reports its problems as `{ code, message }` with the same codes, plus
`HG_NOT_A_BASE`, `HG_UNUSED_LOADER` and `HG_NO_HYDRATOR`.

A load that fails is not an error of the run: its keys are `unknown: failed`, and the trace keeps a
failure code per step. For a load or a dry run that threw, that is the error's own `code`
(`ECONNRESET`) with its `class` beside it, or its class alone; a code or a name that is not a short
identifier is not kept. The codes the executor writes itself are `HG_INVALID` (a projection failed
its schemas), `HG_BUDGET_SPENT` (a metered job's calls billed its whole budget before these keys'
call), `HG_CIRCUIT_OPEN` (the connector's circuit was open) and, under `strict`,
`HG_ENVELOPE_UNASKED`, `HG_ENVELOPE_CONFLICT` and `HG_ENVELOPE_MISSING`.

### 5.5 Attribution

After the steps, provider rows are attributed back to every base row along the links: per base
row and provider, the rows it reaches, each with every distinct chain of links from the base row
to it (its **lineage**), and the outcome of the route by the rule of §3.4. Each base row also gets
its row steps: what every step on its way (hydration, relation strategy, verification, provider)
said about each ref, with reasons, cuts, coverage and, for a strategy, how many links it produced.
Base rows that share a ref share one answer.

### 5.6 Validation

Schemas are the graph's declaration of what a key, a carried attribute, a link's attributes and,
optionally, a provider's field are. A run checks against them what enters it from outside: the
base rows, from its caller, and what sources say through projections. A call's `validate` chooses:
- `boundaries` (the default). The base rows' keys and carried attributes, before anything is read.
  A row that fails, or that carries an attribute its entity does not declare, rejects the run with
  a `ValidationError` naming each row id and field: the caller sent it, and reading around it would
  answer a question nobody asked. Then each link a strategy projects (its target key, its
  attributes against the relation's `link` schema, the target's carried attributes) and what a
  hydrator projects. Those are a source's word: a key whose projection fails is
  `unknown: failed`, counted in the trace under `HG_INVALID`, and the run goes on (a fallback
  strategy runs on it). The whole projection of that key fails, not the one bad link: a ref told
  "found" with a link missing would claim more than was read.
- `strict`. Also every envelope a load returns: a key it puts in two buckets is failed instead of
  trusted, and keys not asked, contradicted or missing are reported as failure codes. A key not
  mentioned is failed in every mode (§3.1). And the values a provider projects, against their
  fields' schemas: in each row a ref keeps under the rows cap (§5.8), each raw value as projected,
  then each derived value as computed from the parsed raw ones. A field without a schema is not
  checked, nor one the row does not hold or holds as `undefined`: a field may be optional. A ref
  with a value that fails is `unknown: failed` for that provider, with no rows (as for links, the
  whole projection fails), counted in the provider's trace under `HG_INVALID`; its other providers
  and the other refs are as they were. A row the cap cut is not answered, so it is not checked, and
  a ref the provider did not find has no row to check. The loader's answer is cached as it came, so
  each strict run checks the projection again and a run that is not strict reads it as it came. A
  field's value steers no read, and there is one per field per row: checking them is the caller's
  choice, not the default.
- `off`. No schema runs; the values are taken as they come.

A value that passes is replaced by what its schema parsed, so the type the graph declares is the
type a load reads (a coerced key, a trimmed string). A schema's issue messages are never kept,
since they may quote the value. An asynchronous validator is awaited; one that throws fails its
value. Validation costs a call per value at the boundaries, and under `strict` one per field value
of every row kept; `off` is for a caller that already validated what it sends and trusts its
sources.

### 5.7 Failing sources

A source that fails now and then should not make a key unknown when a second try would have read
it; a source that is down should not be called by every run until it is up again. What happens
between deciding to call a source and having its answer lives in one place
(`src/run/calls.ts`).

**Retries.** Two parties know different halves of when to try again. The application knows which
errors are transient (a reset connection, a timeout, a 503), the same for every source of one
client library, so the run takes one classifier, `retryable(error)`, false by default. The loader
knows how its source wants to be waited for, so it declares the policy: `retry: { attempts,
initialMs, maxMs, factor, jitter }`. A call is tried again only when both say so, and never for an
error the run calls `fatal`, nor into a circuit that would refuse it (one the failure may just
have opened). Retry n waits a random time up to `initialMs × factor^(n-1)`, at most `maxMs` (full
jitter: the callers one failure synchronised do not come back together), and no wait may be
longer than a timer can count (about 24.8 days). A wait that would end past the deadline is not
started, and a retry that gets no answer (the deadline passed while it waited for its slot or its
token, or a circuit refused it) leaves the failure it followed as it was: a retry never turns a
failure into a deadline. A run that stops during a wait stops waiting. A dry run is retried by
the same policy: it bills nothing, and the load behind it waits for it.

A metered load is where a retry costs: an attempt that threw may have billed its job before the
answer was lost. So every attempt draws from the job's budget like a call does (§5.3): it is told
what is left, and charged what its envelope or its error says it billed, or else (no bill said, or
one that is not a number of bytes from 0) all it was told. A loader whose failed jobs bill nothing
sets `billedBytes: 0` on the error, and its retries draw on the whole remainder; one that sets
nothing is not retried, since nothing is left. Nothing is billed past an approval, retries
included.

What the trace keeps is the number of retries per step that got an answer or an error; the keys
of a call that ran out of
attempts are `unknown: failed` and the trace keeps its last error. An envelope is an answer, not a
failure: a load that reports keys failed is not tried again, since the load chose what to report.

**State that outlives a run.** A source's health and its rate limit hold across runs, and a run
that started fresh each time would learn neither. The library
keeps no global state (two graphs in one process, two tenants, a test next to another), so that
state lives in an object the application creates once and hands to every run: `createHealth`
(`RunEnv.health`). Leaving it out is the behaviour of before: no breaker, no rate.

**Circuit breakers.** Per connector, `{ failures, windowMs, coolDownMs }`. Every call through the
connector that threw is counted, loads and dry runs alike. A fatal error counts too, since a spent
quota is the source refusing; a refused approval does not, since it is the run's own decision.
After `failures` of them within `windowMs`, the circuit opens for `coolDownMs`. While it is open
its loaders are not called, dry runs included, and their keys are `unknown: failed` with
`why: "open"` and the connectors, so a consumer can say "not read: the source is failing" without
waiting for it; the trace counts them under `HG_CIRCUIT_OPEN`. After the cool-down the circuit is
half-open: one call goes through as a probe and the others are still refused while it runs; its
answer closes the circuit, its failure opens it for another cool-down. Only calls let through
while the circuit was closed count toward opening it, and only an answer or a throw is a verdict:
a call the run stopped waiting for (the deadline, the caller) says nothing about the source, and a
probe that ends that way leaves the circuit half-open for the next call. A probe that has not
ended within a cool-down is given up and the next call probes: a call that hangs, in a run with no
deadline, must not keep the circuit shut for every run. A load asks the circuits after it has its
rate's tokens, so a call that waited for one is refused if a circuit opened meanwhile, and gives
its tokens back. A call on several
connectors is refused when any of their circuits is open, a `oneOf` loader's included: the
executor cannot tell which of its sources the load would read. A failure counts against every
connector the call held, for the same reason. An envelope that reports failed keys is an answer:
the source is up.

**Rate limits.** Per connector, a token bucket: `{ perSecond, burst }`. A load takes a token on
each connector it reads once it holds its slots, so the rate counts calls as they start, not as
they queue. A call that finds no token waits in line, and the line is served in the order it
formed as the bucket refills. Nothing is promised to a call before its token is there: a call
whose run stops leaves the line and takes nobody's turn with it, and a token given back (taken by
a call that then did not start) goes to the next in line, so the calls never start closer than
the rate allows. Dry runs take no token, as they hold no slot: they are cheap and the source's
limits are about the work. The concurrency limits stay per run (`RunEnv.limits`), beside the
shared rate.

**Single-flight across runs.** Within a run a key is loaded once (§5.2); across runs the cache
dedupes only what has landed, so a page that a hundred people open at once makes a hundred loads of
the same keys. Runs given the same `createInflight()` object (`RunEnv.inflight`) share their
loads: once a wave is admitted, the run puts its loader keys in flight, under their cache entries,
and lands each with its call's answer (the keys of a metered job's later calls are in flight
while the earlier ones take their turns). A run whose cache misses a key that is in flight waits for it
instead of loading it, after its cache lookup and before its admission, then admits and loads in
one go whatever is left: one dry run and one gate per job stay true, at the cost of a run that
waits for a borrowed key before it loads its own. The entry names the loader, its version, the
key, what the load reads, the run values that are data and the restriction, so a run never borrows
an answer its cache could not have given it. Only what the cache would keep is shared: a found or
an absent answer whose retention is not `none`. An unknown belongs to the run that met it (its
deadline, its budget, its approval), and a run that waited for one reads the key itself. A waiting run that stops (aborted,
past its deadline) waits no more, and the load goes on for the others; a run whose own load stops
lands its keys with nothing to share. A run waits only for keys another run has admitted, and a
run that has admitted its keys never waits for a flight, so two runs never wait for each other.

### 5.8 Caps

A per-ref cap belongs inside the query (§3.1), where it saves the read. Caps are the application's
bound on the rest: on a key with a million tracks, on a request whose fan-out multiplies hop after
hop. A run's `caps` (its env's and its call's, the smaller winning, §5.9) set three, and a
relation (`caps.links`) or a provider (`caps.rows`) may declare its own; where both apply, the
smaller wins:
- `refs`: the most refs one step reads. A step takes its refs in the order of their key ids (refs
  of one key by the values they carry) and reads the first; the others are not read, not hydrated,
  and nothing is read through them. A verification is a step of its own: it reads the first of its
  candidates' targets, and a candidate whose target is past the cap is dropped, its ref cut. A rule
  of `decide` sees the candidates whose targets were read.
- `links`: the most links one ref follows through a relation. The ref keeps its first links, in the
  order its strategies gave them (after verification and cardinality, §3.3).
- `rows`: the most rows one ref gets from a provider. The ref keeps its first rows.

Past a cap the ref is cut (`{ kind: "capped", cap, limit }`), so an answer read under it is found
but cut, and an empty one is unknown, never absent (§3.4). A ref past the `refs` cap has a row step
of the step that did not read it, `unknown` with that cut and no reason, and the step's trace counts
it among its keys and its cuts (for a relation, under its first strategy's loader). The executor trims after reading here,
where §3.1 says it should not: a cap is not part of what a relation means, but a bound on what one
request may cost, and what it saves is the reads after the trim.

Each cap counts per step, not across the run. Steps of separate branches run side by side, so a
count of refs shared by the run would make which ref is cut depend on which branch ran first, and
the result would depend on timing. A run therefore reads at most `refs` refs per step of its plan.
For the same reason, under a `refs` cap a step waiting for its inputs offers none of them to another
step's job (§5.2): it knows which of its refs it reads only once every input is in.

### 5.9 The runner and a read by entity

A run's options are of two kinds. Some hold for the process: the stores and objects every run
shares (the cache, the health of the connectors, the loads in flight), what the deployment can read
and how much of it at once (`readable`, `limits`, `caps`), how the application classifies its
clients' errors (`fatal`, `retryable`), its telemetry, the digest of its personal keys and its
clock. The others hold for one call: the rows and the providers, the run's values (`ctx`), the
viewer (`readable`, `restriction`), how long the caller waits (`deadline`, `signal`), the approvals
(`approved`, `prices`) and how far the caller trusts what it sends (`validate`). Given in one object
at every call site, the first kind is repeated in every feature, and a feature that builds its own
cache or health object quietly stops sharing it. So the options are two types, `RunEnv` and
`RunCall` (`src/run/types.ts`): `createRunner(graph, env)` takes the first once, at startup, and
its `run(call)` and `read(...)` the second (`src/run/runner.ts`). `run(graph, options)` takes both
in one object (`RunOptions`, `RunEnv & RunCall`), and is what a runner calls.

Where both give an option, the call narrows the env and never widens it. `readable` is a
deployment's (a connector not configured, switched off) and a viewer's (forbidden): a connector is
readable when both say so, and the env's reason is the one given, since what the deployment cannot
read is no viewer's to read. A cap is the smaller of the two, as between a run's caps and a
relation's or a provider's (§5.8). Every other option of the env is the env's alone, taken by name,
so a call object that carries one (a spread, a cast, plain JavaScript) does not replace it: the
shared objects stay shared, the limits are a connector's capacity, the digest must be the same on
every instance (§5.4, §6), and the classifiers, the tracer and the clock are the process's.
`restriction` is the call's: it names what the viewer's `readable` forbids (§5.2). A runner refuses
when it is made an env every run would refuse (caps or limits that are not whole numbers from 1, a
health or an inflight object the library did not make), so a process with one fails at startup. A
limit is a whole number from 1 or `Infinity`: `NaN`, what reading an unset variable as a number
gives, held every load on its connector until the deadline.

Every option has a default: every connector readable, no cache, no limit, no cap, and the rest as
the README lists. With no cache every run reads its sources. A runner given none keeps one thing
itself, the scopes of the gates its runs stop at, each for the hour it is written for: without
them an approval covers its own gate id only (§5.4), and a resume whose keys another call is
loading at that moment borrows those and prices the rest under a new gate id, which stops again. A
bare `run` given no cache has nowhere to keep them, and resumes only the exact gate it stopped at.
`ctx` may be left out only when the graph's `Ctx` admits `undefined` (a graph whose runs carry
nothing): `g.graph()` returns a `Graph<E, Ctx, Meta, R>` that carries its entities, its `Ctx` and
its routes in its type, and a run's `ctx` is checked against it. A loader's `version` defaults to 1.
Its `connectors` have no default: a loader with none would escape every `readable`, limit, breaker
and rate, so a switched-off source or a viewer's refusal would not hold it. Nor has its `batch`: it
is the one choice that depends on the source.

**A read by entity.** Most calls ask for the providers of rows that are keys of one entity, each
row's id its key. `read(entity, keys, providers, call)` makes those base rows and gives each back
under its key's id (the entity's `id(key)` of the key as its schema parsed it, `String` unless
declared), so the caller looks a row up
by what it has in hand. The result is `run`'s, unwrapped by nothing: an unknown is an outcome, never
a throw. Inside the run each row is named by its place (`keys[2]`), so a `ValidationError` for a key
that fails its schema, or whose id cannot be computed, names its place, never the key (§5.4). The
keys are typed by what the entity's key schema accepts (its input type; its parsed type when it
says it accepts `unknown`, as a `Schema<T>` does), one or a list; a key that may be an array is given in a list, so that one key is never
read as several, and a name that may be one of several entities takes no key, its key type not
being one. One key given twice with different carried attributes would be two refs, both read, and
one row under one id: the read refuses it before reading anything (`HG_DUPLICATE`, naming the two
places). A read of no key checks the routes from its entity all the same. An entity with `context`
attributes takes `{ key, carries }`, every one of them required: only a base row or a link brings
them (§3.2), and a base row without them would leave every step that needs them `unknown: unmet`.
Only such an entity: for an object key, a key and `{ key, carries }` cannot be told apart at run
time, so a base row that brings other attributes (a hint) goes through `run`. The entity's type carries its context attributes for this
(`Entity<K, C, X>`).

A personal key is the id of its row in a read's result, as the caller gave it: the caller looks the
row up by its own key. Everywhere else (rows, row steps, lineage, gate ids) it is its digest, and
the trace holds no key.

The providers of a read are those the graph's routes reach from its entity (§4, §7): one with no
route from it does not compile. One asked by an id the compiler cannot know (`string`) is refused
when the read runs, before anything is read (`HG_NO_ROUTE`), as `run` refuses it.

## 6. Trace

Aggregated per step and loader: keys in, keys answered without loading (by the cache or by another
step), found, absent, unknown by reason, cut, billed bytes, time spent, retries, and failures by
code. A relation with two strategies has an entry per strategy's loader, so the trace says which one
answered. Per-ref detail lives in the row steps. A job several steps asked is counted once: a key it
loads is loaded for the asking step with the smallest id and cached for the others, and its bill,
failures and retries go to that step, so the trace bills what the calls billed and says the same
whatever the timing (§5.2).

**Spans.** A run given a tracer (`RunEnv.tracer`) reports itself as spans: the run, each job,
and under a job its cache read, its dry runs, its calls and its cache writes. The interface is the
part of OpenTelemetry's API that a library needs (`startSpan(name, attributes, parent?)` returning
`setAttribute`, `addEvent`, `recordError` and `end`), so an OpenTelemetry tracer adapts in about
twenty lines (`examples/otel.ts`) and the library depends on nothing. The parent is passed rather
than found in a context, since a library that runs in workers and other runtimes has no async
context to read it from. Attributes are ids (loader, steps, gate, connectors), counts, bytes, durations and
outcomes; an error is its code and class; a retry is an event on its call. The job's span is also
where the metrics are: per loader, its keys, cache hits, calls, attempts, retries, bytes billed, the
state of the circuit each call met, and its times; a tracer that adds them up is the application's
metrics (`examples/metrics.ts`), with no metrics library here. The trace in the result stays the
per-step summary a consumer renders; spans are for the application's telemetry.

The spans and their attributes are public API (README, "Versioning"):

| Span                   | Parent | Attributes (`hopgraph.` left out)                                                                                                                                                                                                                                           |
| ---------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hopgraph.run`         |        | `rows`, `providers`; at the end `status` (`complete`, `gated`, `failed`, `aborted`); when it answers `gates`, `billed_bytes`, `jobs`, `waves`, `deadline_passed`; when it rejects, its error                                                                                |
| `hopgraph.batch`       | run    | a job: `loader`, `wave`, `steps`, `keys`, `waited_ms`; at the end `cache.hits`, `inflight.hits`, `admission`, `price_bytes` and `gate` (metered), `loaded`, `calls`, `attempts`, `retries`, `billed_bytes`, `found`, `absent`, `unknown`, `cache_ms`, `price_ms`, `load_ms` |
| `hopgraph.cache.read`  | batch  | `loader`, `entries`; at the end `hits`                                                                                                                                                                                                                                      |
| `hopgraph.price`       | batch  | a dry run: `loader`, `keys`; at the end `outcome`, `attempts`, `circuit`, `bytes`                                                                                                                                                                                           |
| `hopgraph.load`        | batch  | a call: `loader`, `keys`, `connectors`, `budget_bytes` (metered); at the end `outcome`, `attempts`, `circuit`, `billed_bytes`; a `hopgraph.retry` event per retry, with the failure it follows                                                                              |
| `hopgraph.cache.write` | batch  | `loader`, `entries`                                                                                                                                                                                                                                                         |
- `admission` says why a job loaded or did not: `free`, `auto`, `approved`, `covered` (a part of
  an approval), `cached` (nothing missing), `gated`, `too_heavy`, `refused` (an approval its price
  grew past), `failed` (its dry run), `open` (a circuit), `stopped` (the run stopped).
- `outcome` says how a call ended: `done`, `threw`, `open` (refused by a circuit), `spent` (the
  job's budget was billed) or `late` (the run stopped waiting); `circuit` is the state of the
  circuit it met: `closed`, `half-open` (it was the probe) or `open`.
- A failure is recorded by its code and class, never its message. No attribute or event holds a
  key or a value, personal or not.
- A tracer that throws, or whose method returns a promise that rejects, never affects the run;
  only the span it was handling may miss some attributes.
- A span that fails to start is no span, and its children hang on the nearest span that did.

An entity with a personal key (`personal: true`) appears in row steps, rows and lineage only by
the application's `digest(entity, keyId)`; the trace holds no keys at all. A run given no digest
shows the SHA-256 of the entity and the key id: never the key, but anyone who guesses a key (an
email address) can compute its digest and recognise it, so an application with such keys gives a
keyed HMAC, the same on every instance. The trace and the row
results are data for the application to render through its own masking; the library never logs.

## 7. Types

The compiler enforces, at the call site and with error messages written for people:

```ts
const g = hopgraph<Ctx, Meta, Conn>().entities({ track, artist, email }); // type arguments first

export const contact = g.relation("track", "email", "contact", {
  cardinality: "N:1",
  combine: "fallback",
  strategies: (s) => [
    s(trackHeader, { needs: ["email"], project: (ref) => [{ to: ref.email }] }), // ref: { key; email }
    s(warehouse, { project: (_ref, v) => [{ to: v.contact }] }),
  ],
});
```

1. Entity names in relations, providers and routes exist.
2. A strategy's loader is keyed by the relation's `from`; a verification's by its `to`.
3. A need or a hint is a carried attribute of the entity. Inside the load or the projection the
   ref exposes the key, the declared needs (present) and the declared hints (optional) only
   (`{ key } & Required<Pick<C, N>> & Partial<Pick<C, H>>`), so an undeclared attribute is a
   compile error, not an `undefined`.
4. A loader's ctx key is a key of `Ctx`, and its load sees only the keys it declared.
5. A loader's connectors are connectors of the graph (`Conn`); a metered loader has `price`.
6. A projection returns links with the target's key type and, when the relation declares link
   attributes, those attributes.
7. A route's path chains, starts at the route's base and ends at the provider's entity; a union's
   paths share both ends; `itself(base)` only when the provider is keyed by the base. A route has
   one base and one provider: with a union of either, the checks would hold for one member while
   the graph's type claimed every pair. `g.route` and `g.graph` check the chain again at run time,
   for a route from a cast or plain JavaScript (`HG_PATH`, `HG_UNKNOWN_RELATION`).
8. Every projected value is a raw field, and every field carries a `Meta`. A derived field reads
   raw fields of its own provider, cannot take a raw field's name, and its function receives
   exactly its inputs, typed. A provider's rows have one shape with named fields, since the run
   keeps of a row the fields `raw` names and a result types them as the rows are typed: rows typed
   `any` (what `JSON.parse` returns) or as a union of shapes are refused at `raw`, rows with an
   index signature on the provider `g.provider` returns, which a route or a run then refuses. A
   row type may be an interface or a type alias; the refusals hold for both.
9. A run asked for a provider as declared (`providers: [trackStreams]`) types that provider's
   result: `rows.get(row)?.providers.trackStreams.rows[i].fields` has its raw and derived fields.
   The list is read as a tuple: an element that is one provider is certainly answered, so its key
   is required; one that may be one of several providers, or a list typed as an array, gives keys
   that may be missing. Asked by id, a provider's fields are untyped, so a field picker can ask by
   name. A runner's `run` and `read` type their results the same way.
10. A run's `ctx` is the graph's `Ctx`, which `g.graph()` carries in its type; it may be left out
    only when `Ctx` admits `undefined`.
11. A read names an entity of the graph and takes keys its key schema accepts; an entity with `context`
    attributes takes `{ key, carries }` with every one of them, typed by their schemas (§5.9).
12. A provider asked by a run, a runner's run or a read has a route from the entity of every base
    row, as the graph's routes say (§4). The message names both: `provider "trackStreams" has no
    route from "artist"`. What the check knows is what the call's types know: a read's entity is
    always a literal; a run's rows are when they are written out or made by `g.ref`, which types a
    row like a read's key and keeps its entity's name, and rows built otherwise
    (`entity: string`) only ask that some route reaches the provider; an id typed `string` asks
    nothing; a graph with its types forgotten (`GraphDef<Meta>`) refuses nothing. The run
    refuses the rest (`HG_NO_ROUTE`) before it reads anything.

The builder also throws, at declaration time, on what it can see then: a name declared twice, a
route given to `g.graph` twice, a loader or a route used on another graph, a metered loader
without `price`, a merging loader with hints, a retry policy that cannot be followed, two
hydrators for one entity, a relation with several strategies and no `combine`, a cap that is not a
whole number from 1, and the shapes the types
refuse when they come from plain JavaScript or through a cast: connectors other than `allOf` or
`oneOf`, a batch of another kind, a route that is not a path or a union of paths.

One statement per relation, never one builder chain for the whole graph: the compiler crashes
near 550 chained calls, and a single literal checked as a whole hides its error text. The routes
are the one list, the arguments of `g.graph(...)`: each `g.route(...)` is its own expression,
checked and reported where it is written. Global properties (coverage of every (base, provider)
pair, unused loaders, hydrator coverage) live in the graph test of §4. Key and attribute schemas
are Standard Schema, so the library imports no validator.

Measured during development (TypeScript 5.9, a generated graph with a metered loader, a relation,
a provider with a derived field and three routes per entity): check time 0.20 s at 15 entities,
0.43 s at 50, 0.74 s at 100, about 2.2k type instantiations per entity, linear. A consumer that
records the instantiation count of its graph file sees a jump in review. With the routes in the
graph's type (TypeScript 5.9, 50 entities, 100 routes, the library's own 19k instantiations
included): the graph costs what it did (86.7k instantiations against 86.0k as statements); the
first call site checked against its routes adds about 48k, once, and each further one about 20
(20 call sites: 135k and 0.54 s of check time, against 86.8k and 0.51 s before; 100: 137k and
0.56 s).

## 8. Layers

```
src/core/       entities, loaders, relations, providers, routes, outcomes, errors, builder
                types, route checker. Pure: no I/O, no imports.
src/run/        executor, runner, scheduling, cache port, ids, connector limits, caps, gates,
                cancellation, retries, health (breakers, rates), single-flight, validation,
                lineage, trace, spans.
                Imports core only.
application     entity schemas (domain), loaders over its connectors (infrastructure),
                relations, providers and routes (one graph module), its Meta type and the
                fields' meaning, the graph test, the cache store, the digest, which errors are
                retryable, the one health and inflight object of the process, and the
                one runner it makes with them at startup.
```

## 9. Writes (not designed further)

A write over an entity graph is a read plan that finds the targets, then an action keyed by one
entity with needs, a dry run listing the targets, an explicit confirmation, one outcome per target,
and retries only when declared idempotent. No transactions across sources: ordering and
compensation stay with the caller. Nothing is reserved in `core` for it.

## 10. Prior art

|                                             | Shares                                                                                                                           | Differs                                                                                      |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Graph query languages with batching loaders | typed entities and relations; batched, per-key cached loaders under resolvers (here, loaders under relations)                    | the client writes the path; no outcomes, gates or cost                                       |
| Federated query planners                    | entities with keys; a field that requires another is a carried need; a query planner                                             | plans a client-shaped query across services; no fallback or union of strategies              |
| Semantic layers                             | relations declared once; fields reached through joins; a dimension with label, description and derivation is a field with `Meta` | one warehouse, compiled to SQL; join paths found automatically; measures (Hopgraph has none) |
| Graph libraries                             | graph structure, traversal                                                                                                       | no I/O model, types over the domain, or cost                                                 |

In one line: batching per-key loaders under a declared relation graph, with needs a field requires
of the ref it hangs on, routes chosen by people and checked by a test, and answers that say whether
they are complete.

## 11. Limits and open questions

- **Field schemas run only under `strict`** (§5.6). At the default level, keys, carried
  attributes and links are validated and the values a provider projects are taken as they come. A
  field's schema is optional and is not in the catalog.
- **A run asks for providers, not fields.** Every field of a requested provider is computed and
  returned; choosing fields is the consumer's.
- **Only loaders read ctx.** A strategy declares needs and hints, not ctx values; a window that
  depends on `today` is computed by the loader.
- **Routes have no fallback and no unreachable pair** (§4). Every base passed to `checkGraph` must
  reach every provider.
- **Cancelling is best effort.** A load that ignores its signal runs on, and what a source billed
  before it stopped is billed (§5.3).
- **An approval is not a budget across runs** (§5.4).
- **Only a thrown call is retried** (§5.7). A key an envelope reports failed is unknown for this run
  and read again by the next, since unknowns are never cached.
- **A run that fails may have read ahead.** With no barrier, jobs of later waves on other branches
  may have started before a failure; they are aborted, and what their sources billed before is
  billed. The jobs of earlier waves finish, as under the barrier (§5.4).
- **Caps count per step** (§5.8): a run's refs are bounded by `refs` times the steps of its plan,
  not by `refs`.
- **What the compiler knows of a run's rows** (§7): rows built at run time without `g.ref` have
  `string` entities, and a provider asked for them is checked only against all the routes, not
  those of their entities; the run refuses a missing route (`HG_NO_ROUTE`).
- **What a node may read is known per node** (§5.2). A node holds back the jobs of every loader it,
  or a node after it, may read for as long as it runs, a loader of a step it has passed included:
  a job may start later than it had to, never earlier.

## 12. How the design is checked

Unit tests next to the code check each behaviour on a hand-written graph. The property tests
(`test/props`) check the promises of this document on random ones: random entities, loaders,
relations (strategies combined both ways, verified or not), providers and routes; sources that
find, find nothing, cut, fail a key, leave it out, fail a statement, throw, throw fatally, or answer
slowly; caches left by earlier runs, some over sources that have changed since; gates, and resumes
that approve them exactly, generously or short. On every run they hold that:
- every base row gets an answer and every requested provider exactly one outcome (§3.4);
- a provider is absent only where every branch ran to the end, uncut; a deadline never makes one
  absent (§3.4, §5.3);
- the answer is what an oracle computes the plain way, from what the run read and the rules of
  §3.3, §3.4 and §5.5, without waves, plan nodes or memos;
- the cache keeps found and absent answers with their retention, never an unknown (§5.2);
- a metered loader is priced before it loads, loads only under its auto cap or with an approval no
  smaller than its price, its calls in one wave are each told what the ones before them left and
  bill no more than the budget together, and a run that failed calls nothing more (§5.3, §5.4);
- each loader makes one cache lookup, at most one dry run and its batches per wave, its jobs in
  wave order, and loads a key once per run (§5.2);
- played under the barrier too, every run answers the same, and one that answers makes no more
  jobs of any loader (§5.2);
- the result, trace and gate ids included, and the gates a failed run refused, do not depend on
  the order slow calls finish in (§5.2, §5.4). The guarantee is that a run's answer is a function
  of its inputs, the cache, the approvals and the state of the connectors' health when each call
  is made. A breaker is shared by the runs of a process (§5.7), so its verdicts depend on timing by
  nature: a later wave's failure may open a circuit before an earlier wave's call reaches it, and
  that call is refused, and a run may then fail with the later wave's error. The determinism
  property plays no breaker;
- every chain of a provider row starts at its base row and follows declared relations, link by
  link, each one its strategy's projection of what was read; a personal key appears only as its
  digest (§5.5, §6);
- against sources that fail now and then (each call throwing a transient error on its first
  attempts) and loaders that retry, the answer is still the rules' for what was read, no call is
  attempted more than its policy allows, every retry is in the trace, and no metered job bills
  past its budget; with retries enough, the answer is that of sources that never failed; with
  breakers that open, a key reached through unions is never absent where it was found (§5.7);
- a run fails with the earliest wave's failure, the same under the barrier (§5.4);
- field schemas that accept every value, at once or later, change nothing under `strict`, its jobs
  and waves included; ones that refuse every value change nothing under `boundaries` or `off`; and
  under `strict` a field that refuses its values fails exactly the refs whose rows hold it (§5.6).

Every finding is fixed, and each fix keeps its case in `test/regressions`, with a header that says
how it was found. Among the cases the property tests led to: the order a wave's keys were batched
in, which step a merged job's bill and failures went to, which refused gate a failed resume named,
and which keys of a loader shared a wave, each decided by timing until the scheduling of §5.2.
Among those a review found: a job whose error could not be described hung the run, a load could
take the slot of a call that had just failed the run, a tracer's rejected promise could end the
process, and which of two fatal errors of a wave a run rejected with depended on timing. One waited
for a decision: a fallback through a strategy whose circuit was open told absent what a run with
the source up found (§3.3); with it, decided the same way, a fallback through a strategy that read
under a cut and found nothing. New findings wait in `test/found` as skipped tests until they are
decided.
