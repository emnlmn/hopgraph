# Benchmarks

Two questions, one file each, both run on the build as a consumer would, with Node 22.18 or later
(they run TypeScript by stripping its types):
- `bench/run.ts`: what the executor itself costs. One synthetic graph over 10 to 100 000 base rows
  whose loaders answer at once, so the time measured is the executor's: planning, scheduling, cache
  keys, batching, the fallback, attribution and lineage. Nothing waits on I/O.
- `bench/latency.ts`: when each provider is read. Loaders that answer after a fixed time, some
  fast, some slow, so the time measured is when each provider is read and when the run answers.

```sh
npm run bench                  # build, then measure every size (about a minute)
npm run bench -- 1000 10000    # measure only the sizes given
npm run bench:latency          # build, then time nine runs over sources of mixed paces

# a million rows: Node's default heap runs out, and it takes about 8 minutes
NODE_OPTIONS=--max-old-space-size=16384 npm run bench -- 1000000
```

## The graph

The graph models a music catalog. Each base row is a track, and the run asks for three providers:

| Provider  | Route                      | Read by                                         |
| --------- | -------------------------- | ----------------------------------------------- |
| `summary` | itself                     | the tracks loader                               |
| `profile` | `track › artist:performer` | the artists loader (one artist per four tracks) |
| `city`    | `performer`, then `home`   | the venues loader                               |

`artist › venue:home` is a fallback: a registry that knows half the venues, then the artists
loader.

Every loader batches 500 keys per call on one connector limited to 8 concurrent calls. The artist
key is personal, so every result shows it as a digest. Two caches: `cold` keeps nothing, so every
key is loaded; `warm` already holds every answer, so nothing is.

## Columns

- **ms (median)**: the median time of one run: over 15 runs up to 1 000 rows, 5 at 10 000, and a
  single run from 100 000 on, after a warm-up run that warms the JIT and fills the warm cache.
- **µs per row**: the run's time over the number of base rows: the executor's overhead per row.
- **heap held (MB)**: the heap the result holds once the run is over (`--expose-gc`, after a full
  collection). Small values are within the collector's noise and can come out negative.
- **waves, calls, keys loaded**: what the run read. Waves is the latest wave a job started in;
  calls are the loaders' calls: one per batch of missing keys per loader per wave.

## Baseline

Apple M1 Max, Node 24.22.1, recorded on 2026-11-03 at 0.2.1. On 2026-11-02 the scheduler of
DESIGN.md §5.2 and the commit before it (the barrier), measured back to back on the same machine,
took the same time within 3% at every size, with the same calls and keys; the barrier reached 3
waves where the scheduler reaches 4.

| cache | base rows | ms (median) | µs per row | heap held (MB) | waves | calls | keys loaded |
| ----- | --------: | ----------: | ---------: | -------------: | ----: | ----: | ----------: |
| cold  |        10 |         1.3 |      129.7 |            0.0 |     4 |     4 |          19 |
| warm  |        10 |         1.1 |      110.1 |            0.0 |     4 |     0 |           0 |
| cold  |       100 |         6.0 |       60.2 |            0.0 |     4 |     4 |         175 |
| warm  |       100 |         5.8 |       57.9 |            0.2 |     4 |     0 |           0 |
| cold  |     1,000 |        46.3 |       46.3 |            1.9 |     4 |     5 |       1,750 |
| warm  |     1,000 |        44.3 |       44.3 |            2.0 |     4 |     0 |           0 |
| cold  |    10,000 |       467.6 |       46.8 |           21.3 |     4 |    35 |      17,500 |
| warm  |    10,000 |       486.3 |       48.6 |           21.1 |     4 |     0 |           0 |
| cold  |   100,000 |      5581.9 |       55.8 |          213.3 |     4 |   350 |     175,000 |
| warm  |   100,000 |      5647.1 |       56.5 |          211.4 |     4 |     0 |           0 |
| cold  | 1,000,000 |     72577.9 |       72.6 |         2126.2 |     4 |  3500 |   1,750,000 |
| warm  | 1,000,000 |     69268.3 |       69.3 |         2107.0 |     4 |     0 |           0 |

What it says:
- The jobs are what the design promises: one call per 500 missing keys per loader per wave (35
  calls for 17 500 keys at 10 000 rows), whatever the size. A warm cache makes no call.
- Four waves: the fallback of `artist › venue:home` reads the artists the profile already
  read, and that read takes its wave though it loads nothing, so that the waves after it do not
  depend on which call ended first. It makes no job.
- The time per row stays between 44 and 49 µs from 1 000 to 10 000 rows, and grows by a fifth at
  100 000, where the collector works through a heap ten times larger. A CPU profile at 100 000
  rows puts a quarter of the time in `stableJson` (the text that deduplicates row steps and chains
  and names refs and cache entries), an eighth in the collector and a seventh in `sha256` (the
  ids). No step grows faster than the rows: the base refs, once grouped with `Array.includes`
  (quadratic, the growth to 65 µs per row at 100 000 on 2026-11-02), are now grouped by a `Map`.
- A million rows do not fit Node's default heap (4.2 GB here): the first run runs out of memory.
  With a 16 GB heap the result holds 2.1 GB and the process peaks at 12 GB resident. The time per
  row grows by about 30% over 100 000; the collector's pauses go from 10% of the time to 16%,
  about 6 µs per row of the 16 it grows. The rest is not yet attributed: no profile at this size.
  One run per cache, so the figure gives the scale, not a baseline.
- A cold run costs no more than a warm one: with instant loaders, reading through the cache and
  loading cost the executor the same.
- The result holds about 2 KB per base row for three providers.

## Latency

`bench/latency.ts` reads 20 tracks. From each track it follows three paths: a fast chain three
reads deep (its releases, their albums, the albums' royalty rates, 10 ms each); a slow source (the
track's plays, 300 ms); and a fast read then a slow one (the performer, 10 ms, then the performer's
label, 120 ms). It prints, per provider, when its last read ended, and when the run
answered: the median of nine runs.

Apple M1 Max, Node 24.22.1, 2026-11-02. Before: the barrier (the commit before the scheduler), the
same file run on its build. After: the scheduler of DESIGN.md §5.2.

| provider | its reads                            | before (ms) | after (ms) |
| -------- | ------------------------------------ | ----------: | ---------: |
| rate     | releases, albums, rates: 10 ms each  |         437 |         39 |
| label    | performers 10 ms, then labels 120 ms |         426 |        138 |
| plays    | plays 300 ms                         |         304 |        305 |
| (run)    | the run answers                      |         439 |        310 |

Under the barrier every wave waited for its slowest read: the plays (300 ms) held the first wave,
the labels (120 ms) the second, so the rates, three reads of 10 ms, came after 430 ms. Now each
provider is read when its own reads are, and the run answers when its longest chain does: the
plays. The jobs are the same.

Record a new baseline here, with the machine and the Node version, when a change moves these
numbers on purpose.
