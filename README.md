<p align="center">
  <img src="brand/icon.svg" width="96" height="96" alt="Hopgraph">
</p>

<h1 align="center">Hopgraph</h1>

<p align="center">Read data across sources by key through a typed graph.</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-0.2.0-2C5E5C?style=flat-square&labelColor=0F2B2C" alt="Version 0.2.0">
  <img src="https://img.shields.io/badge/TypeScript-%E2%89%A5%205.4-2C5E5C?style=flat-square&labelColor=0F2B2C&logo=typescript&logoColor=white" alt="TypeScript 5.4 or later">
  <img src="https://img.shields.io/badge/dependencies-0-2C5E5C?style=flat-square&labelColor=0F2B2C" alt="No runtime dependencies">
  <img src="https://img.shields.io/badge/coverage-100%25-2C5E5C?style=flat-square&labelColor=0F2B2C" alt="Line coverage 100%">
</p>

<p align="center">
  <img src="brand/film.gif" width="640" alt="A key walks the graph from a track to its performer and label across three sources, and each answer comes back found, absent or unknown.">
</p>

You have a list of tracks. The artist's name is in one database, the label in a service, the
streams in a warehouse. Hopgraph walks from each track to each of those, batches the reads, and
tells you per row whether each value was **found**, **absent**, or **unknown** and why. "No artist"
and "the artist database was down" are different answers.

```sh
npm install hopgraph
```

ESM, Node 20+, Deno, Bun. No runtime dependencies. Schemas are [Standard Schema](https://standardschema.dev) (Zod, Valibot, …).

## In five pieces

**1. Entities**: the things you read by key.

```ts
const g = hopgraph<Meta, "db">().entities({
  track: entity({ key: z.string() }),
  artist: entity({ key: z.string() }),
});
```

**2. Loaders**: the only code that touches a source. Batched, cached per key.

```ts
const artists = g.loader({
  id: "artists",
  keyedBy: "artist",
  connectors: { allOf: ["db"] },
  batch: { by: "keys", max: 100 },
  load: async (refs) =>
    envelope(
      refs.map((r) => {
        const artist = ARTISTS.get(r.key);
        return [r.key, artist ? found(artist) : absent()];
      }),
    ),
});
```

**3. Relations**: edges between entities, read through a loader.

```ts
const performer = g.relation("track", "artist", "performer", {
  cardinality: "N:1",
  strategies: (s) => [s(tracks, { project: (_, t) => [{ to: t.artist }] })],
});
```

**4. Providers**: the fields an entity offers, each with your metadata.

```ts
const profile = g.provider("artistProfile", {
  loader: artists,
  temporal: "current",
  rows: "one",
  project: (a) => [{ name: a.name }],
  raw: { name: { meta: { label: "Name" } } },
});
```

**5. Routes**: how a base row reaches a provider. Declared, never searched.

```ts
const graph = g.graph(g.route("track", profile, g.path(performer)));
```

## Read

```ts
const runner = createRunner(graph, { cache: memoryCache(), limits: { db: 8 } }); // once, at startup

const result = await runner.read("track", ["t1", "t2"], [profile]);

result.rows.get("t1")?.providers.artistProfile.rows[0]?.fields.name; // "Mira Volk", typed
result.rows.get("t2")?.providers.artistProfile.outcome; // "absent"
```

Asking for a provider with no route from `track` doesn't compile. Neither does a key of the wrong
type.

The full program is [`examples/playlist.ts`](examples/playlist.ts).

## Outcomes

|           |                                                                                                                    |
| --------- | ------------------------------------------------------------------------------------------------------------------ |
| `found`   | Read. May carry cuts (a cap, fewer days than asked).                                                               |
| `absent`  | Every source that applies was read in full and had nothing.                                                        |
| `unknown` | Not read, with the reason: `unread`, `failed`, `deadline`, `too_heavy`, `awaiting_approval`, `ambiguous`, `unmet`. |

`absent` is never a guess: a cut, a timeout or a source that was down makes it `unknown`.

## What the runner does for you

- **Batching**: every read of one loader in a wave is one call, whatever asked for it.
- **Scheduling**: independent reads run side by side; a fast one never waits for a slow one.
- **Cache**: per key, through a port you provide (`getMany` / `setMany`), or `memoryCache()` for tests and single-process apps.
- **Cost gates**: a source billed by bytes is priced first; above a threshold the run stops and asks for an approval. Nothing is billed past it.
- **Deadline and `AbortSignal`**: running loads are aborted, the rest is `unknown: deadline`.
- **Resilience**: retries with backoff, circuit breakers and rate limits per connector, shared loads across concurrent runs.
- **Tracing**: OpenTelemetry-shaped spans, no keys in them ([`examples/otel.ts`](examples/otel.ts)).
- **Privacy**: a personal key shows only as its digest; errors and traces hold no keys.

## Compared with

|                                                  | **Hopgraph** | GraphQL | DataLoader | Cube, dbt |
| ------------------------------------------------ | :----------: | :-----: | :--------: | :-------: |
| Read databases, APIs and warehouses in one call  |      ✓       |    ✓    |     ✓      |     –     |
| Avoid N+1 queries across every hop               |      ✓       | add-on  |   1 hop    |    SQL    |
| Distinguish missing data from unreadable sources |      ✓       | `null`  |   error    |     –     |
| Approve costly queries before they run           |      ✓       |    –    |     –      |     –     |
| Catch wrong paths and keys at compile time       |      ✓       | codegen |     –      |     –     |
| Document the meaning of every field              |      ✓       |    ✓    |     –      |     ✓     |
| Run inside your app, without a server            |      ✓       |    –    |     ✓      |     –     |

Choose GraphQL when clients write the queries, Cube or dbt for dashboards. Choose Hopgraph when
your code reads rows from many sources and must tell missing data from unread data.

## What it doesn't do

No query language, no transport, no writes, no path search at run time, no joins across providers.
It's a function over values your loaders return.

## More

- [Guide](docs/guide.md): every option with its default.
- [DESIGN.md](DESIGN.md): why it's built this way, the rules the executor follows, error codes.
- [API reference](docs/api/hopgraph.md), [examples](examples/), [CHANGELOG](CHANGELOG.md), [CONTRIBUTING](CONTRIBUTING.md).

Before 1.0, a minor release may break the API; every break is in [MIGRATION.md](MIGRATION.md).

MIT
