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
  single run at 100 000, after a warm-up run that warms the JIT and fills the warm cache.
- **µs per row**: the run's time over the number of base rows: the executor's overhead per row.
- **heap held (MB)**: the heap the result holds once the run is over (`--expose-gc`, after a full
  collection). Small values are within the collector's noise and can come out negative (−3.1 MB
  at 1 000 rows, cold).
- **waves, calls, keys loaded**: what the run read. Waves is the latest wave a job started in;
  calls are the loaders' calls: one per batch of missing keys per loader per wave.

## Baseline

Apple M1 Max, Node 24.22.1, recorded on 2026-11-02 with the scheduler of DESIGN.md §5.2. The commit
before it (the barrier), measured back to back on the same machine, took the same time within 3%
at every size, with the same calls and keys; it reached 3 waves where this reaches 4.

| cache | base rows | ms (median) | µs per row | heap held (MB) | waves | calls | keys loaded |
| ----- | --------: | ----------: | ---------: | -------------: | ----: | ----: | ----------: |
| cold  |        10 |         1.0 |       98.3 |            0.1 |     4 |     4 |          19 |
| warm  |        10 |         0.8 |       79.2 |            0.0 |     4 |     0 |           0 |
| cold  |       100 |         5.4 |       54.1 |           -0.0 |     4 |     4 |         175 |
| warm  |       100 |         5.7 |       57.2 |            0.2 |     4 |     0 |           0 |
| cold  |     1,000 |        44.8 |       44.8 |           -3.1 |     4 |     5 |       1,750 |
| warm  |     1,000 |        44.2 |       44.2 |            2.0 |     4 |     0 |           0 |
| cold  |    10,000 |       496.7 |       49.7 |           21.2 |     4 |    35 |      17,500 |
| warm  |    10,000 |       484.2 |       48.4 |           21.1 |     4 |     0 |           0 |
| cold  |   100,000 |      6487.0 |       64.9 |          213.5 |     4 |   350 |     175,000 |
| warm  |   100,000 |      6478.5 |       64.8 |          211.6 |     4 |     0 |           0 |

What it says:
- The jobs are what the design promises: one call per 500 missing keys per loader per wave (35
  calls for 17 500 keys at 10 000 rows), whatever the size. A warm cache makes no call.
- Four waves: the fallback of `artist › venue:home` reads the artists the profile already
  read, and that read takes its wave though it loads nothing, so that the waves after it do not
  depend on which call ended first. It makes no job.
- The time per row stays between 44 and 50 µs from 1 000 to 10 000 rows, and grows by almost half
  at 100 000. A CPU profile at 20 000 rows puts a third of the time in `stableJson` (the
  text that deduplicates row steps and chains and names refs and cache entries) and 5% in `byEntity`
  (`executor.ts`), which groups the base refs with `Array.includes` and is quadratic in the number
  of distinct base rows: the growth at 100 000.
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
