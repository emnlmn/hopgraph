# Changelog

Every change a consumer can see, newest first. Before 1.0 a release may break the API; each break
has its exact before and after in [MIGRATION.md](MIGRATION.md). The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). [Versioning](docs/guide.md#versioning), in
the guide, says which changes each kind of release may bring.

## Unreleased

### Added

- Route a provider keyed by the base without a path: `g.route("track", summary)` is
  `g.route("track", summary, g.itself("track"))`. A provider of another entity still needs a path,
  and the compiler refuses a route that leaves it out.
- Cache in memory with `memoryCache({ max, ttl, clock })`, a `CachePort` for tests, prototypes and
  single-process apps.

### Changed

- Type a graph as `hopgraph<Meta, Conn, Ctx>()`: `Ctx` comes last and defaults to `undefined`, so a
  graph whose runs carry no ctx writes `hopgraph<Meta, "db">()`. The before and after are in
  [MIGRATION.md](MIGRATION.md).
- A run that validates `"strict"` checks the values a provider projects against their fields'
  schemas, which no run called before: in each row a ref keeps under the rows cap, each raw value as
  projected, then each derived value as computed from the parsed raw ones. A value that passes is
  read as its schema parsed it; a ref with a value that fails is `unknown: failed` for that
  provider, with no rows, counted under `HG_INVALID` in the provider's trace. A field the row does
  not hold, or holds as `undefined`, is not checked. `"boundaries"` (the default) and `"off"` run
  no field schema, as before.

## [0.2.1] - 2026-11-02

### Fixed

- A release is published only once the whole check passes on it: Node 20, 22 and 24, Deno and
  Bun, with the property tests from a random seed. 0.2.0 went out while that run failed on Node 20.
  The failure was in a property's oracle, which blamed a refused gate on another loader of its wave;
  the library's behaviour is unchanged.

## [0.2.0] - 2026-11-02

### Fixed

- `runner.read` names each row by the id of its key as the run parsed it, so an entity whose key
  schema transforms the key (`"07"` to 7) and whose `id` needs the parsed key no longer throws a
  `TypeError` after the run; `g.ref` names its row the same way. An `id` that throws on a key now
  rejects the read with a `ValidationError` naming the row by its place. `read` and `g.ref` take
  what the key's schema accepts (its input type, `KeyInputOf`); loads, links and results still see
  what it parses to.
- A run of a graph built by hand whose relation, provider or hydrator names a loader the graph
  does not hold rejects with a `DefinitionError` (`HG_FOREIGN`) before it reads anything, instead
  of an internal error (`HG_INTERNAL`).
- A run of a graph built by hand with a relation that has no strategy rejects with a
  `DefinitionError` (`HG_SPEC`) before it reads anything, as the builder refuses it, instead of
  answering absent without reading.

## [0.1.0] - 2026-11-02

First release.
