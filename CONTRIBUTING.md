# Contributing

Hopgraph is small on purpose: a declared graph, an executor, and answers that say whether they are
complete. Changes that keep it that way are welcome. This file says how to run the project, the
bar a change must meet, and how to write commits.

## Run the project

Node 22.12 or later (vitest 5 needs it; the library itself runs on Node 20); `npm install` once.

| Command                 | Purpose                                                                                       |
| ----------------------- | --------------------------------------------------------------------------------------------- |
| `npm run check`         | Run every check below that a change must pass, in order. Required before any merge.           |
| `npm run typecheck`     | Type-check `src/`, `test/`, `bench/` and `examples/` with `tsc`.                              |
| `npm run lint`          | Lint and check formatting with Biome; `npx biome check --write .` fixes what it can.          |
| `npm test`              | Run the unit tests: `src/**/__tests__`, the examples, `test/found`, `test/regressions`.       |
| `npm run badge`         | Check that README.md's coverage badge shows the `lines` threshold in `vitest.config.ts`.      |
| `npm run skill`         | Check that the code in `skills/hopgraph/SKILL.md` compiles against the source.                |
| `npm run coverage`      | Run the unit tests with v8 coverage; fail under the threshold in `vitest.config.ts`.          |
| `npm run test:props`    | Run the property tests in `test/props` from a seed (see below).                               |
| `npm run build`         | Compile `src/` to `dist/` with `tsc`.                                                         |
| `npm run api`           | Compare the build's public API with `api/hopgraph.api.md`; fail on any difference.            |
| `npm run api:update`    | Build, then rewrite `api/hopgraph.api.md` and `docs/api/`.                                    |
| `npm run smoke`         | Import `dist/` and run a small graph through it.                                              |
| `npm run bench`         | Measure the executor's own cost from 10 to 100 000 base rows (`bench/README.md`).             |
| `npm run bench:latency` | Measure when each provider is read over sources of mixed paces (`bench/README.md`).           |
| `npm run example`       | Build, then run `examples/playlist.ts`; `example:sql` and `example:warehouse` run the others. |
| `npm run docs:api`      | Write the API reference (`docs/api/`) from the last `api-extractor` run.                      |

`bench`, `bench:latency` and the `example` scripts run TypeScript directly and need Node 22.18 or
later. CI (`.github/workflows/check.yml`) runs the check on Node 22 and 24, the property tests
also from a random seed, and the smoke test of the build on Node 20, Deno and Bun.

### Run and replay property tests

`test/props` generates random scenarios (a graph, what every source answers and how slowly, the
cache earlier runs left, the approvals of a resume), plays them through the public API, and checks
what the design promises: one outcome per base row and provider; absent only where every branch
ran to the end, uncut; the answer the rules give for what was read (an oracle in
`test/props/oracle.ts` computes it the plain way); no bill past an approval; one job per loader per
wave; the same result whatever the timing; the same answers and no more jobs than the barrier the
scheduler replaced (`test/props/scheduling.test.ts`); chains that follow declared relations;
personal keys only as digests; a deadline that never makes anything absent; and all of it again
against sources that fail now and then, with retries and circuit breakers
(`test/props/failures.test.ts`).

Every run prints its seed, `[props] HOPGRAPH_SEED=…`. The default seed is fixed, so the suite is the
same on every run; `HOPGRAPH_SEED=random` draws one; any number replays that run, and
`HOPGRAPH_SCALE=10` tries ten times as many scenarios:

```sh
HOPGRAPH_SEED=random npm run test:props
HOPGRAPH_SEED=1524239071 HOPGRAPH_SCALE=10 npm run test:props -- -t "one job per loader"
```

A failure prints the property's own seed, the path to the shrunk case and the case itself, as a
person reads it (entities, loaders with what they answer per key, relations, routes, rows).

When a property finds a bug that is not fixed in the same change, its smallest failing case goes
into `test/found/` as a skipped test, with a header that says what is wrong and what decision it
waits for, and the generator stops producing that case, with a comment that points to the file.
Removing `.skip` must show the test fail. Once fixed, the case moves to `test/regressions/`, its
header says what fixed it, and the generator's exclusion goes.

## Navigate the repository

```
src/core/          the declaration: entities, loaders, relations, providers, routes, outcomes,
                   errors, the builder's types and checkGraph. No I/O.
src/run/           the executor: plan, scheduling, reads, jobs, calls (retries), health (breakers,
                   rates), single-flight, ids, gates, limits, caps, cancellation, validation,
                   hydration, relations, providers, attribution, trace, spans. Imports core only.
src/index.ts       the package's entry point
examples/          three runnable programs (in-memory, SQL-like, a billed warehouse), an
                   OpenTelemetry adapter, per-loader metrics, and the tests that run them
test/props/        property tests: random graphs, sources (some that fail now and then), caches
                   and approvals, and an oracle
test/found/        what the property tests found and is not decided yet, as skipped tests
test/regressions/  what the property tests or a review found and is fixed
test/smoke/        the build imported and run, on Node, Deno and Bun
bench/             the executor's own cost, the latency of sources of mixed paces, and their baselines
bench/skill-eval/  what the agent skill changes for a coding agent: tasks, hidden tests, results
skills/hopgraph/   the agent skill the package ships (SKILL.md, references/)
api/               the public API report
docs/api/          the API reference, generated from the doc comments
```

Each source file opens with a comment that says what it holds and why. Unit tests sit next to the
code in `__tests__/`; the executor's black-box tests (`run.*.test.ts`) use only the contract in
`src/run/types.ts`, so they hold whatever the internals become.

## Meet the quality bar

- **Write code a stranger can read top to bottom.** Each file opens with a comment that says what
  it is and why. Comments explain decisions, not syntax. Names say what a thing is in the domain.
- **Keep the surface small.** No abstraction without a second use; no option without a caller who
  needs it. Before 1.0 a breaking change is allowed when it makes the library better; when two
  designs are equally good, pick the additive one.
- **Give every behaviour a test that fails without it.** Write the test, see it fail, then make it
  pass. The executor's black-box tests (`src/run/__tests__/run.*.test.ts`) use only the contract
  in `src/run/types.ts`, so they hold whatever the internals become.
- **Never weaken an assertion to make a test pass.** If a test is wrong, fix it and say why in the
  commit.
- **Keep README.md and DESIGN.md true to the code.** A change updates them in the same commit.

The rules every change keeps:
1. The library has no runtime dependency. Code under `src/` imports only from `src/` and uses no
   `node:` module, `process` or `Buffer`, so it runs on Node 20+, Deno, Bun and workers. Dev
   dependencies appear only in `test/`, `bench/` and `examples/` (and `vitest` and `zod` in
   `src/**/__tests__`).
2. Relative imports name the `.ts` file (`./reads.ts`); the build rewrites them.
3. The library never logs: it reports through results, errors and tracer spans.
4. No error message, trace, span or id holds a key, a value or a source's error message: a personal
   key appears only as `digest(entity, keyId)`, an error only by its class and code
   (`SECURITY.md`).
5. Every ref of every step ends in exactly one of `found`, `absent`, `unknown(reason)`; `absent`
   only when everything was read uncut; nothing is billed past an approval.

## Change the public API

The public API is what `dist/index.d.ts` exports, recorded in `api/hopgraph.api.md`. A change to it
runs `npm run api:update`, which rewrites the report and the API reference in `docs/api/`, and
their diff goes into the same commit, where a reviewer sees it. Every public symbol has a doc
comment: `npm run api` fails on one that has none. Every change a consumer can see gets a line in `CHANGELOG.md` under "Unreleased"; every change
a consumer has to apply also gets its exact before and after in `MIGRATION.md`. The guide's
[Versioning](docs/guide.md#versioning) section says which changes may come in which release.

## Write commits

Small steps, each one green and about one thing. The subject says what changed, in a short
sentence; the body, when there is one, says why and what a reader should know, wrapped at 72
columns. No ticket numbers, no names of applications or companies.

```
Batch a wave's keys in key order

The keys of a wave were batched in the order the steps' reads reached
it, which timing decides, so which keys a throwing call took with it
did too. test/found/batch-order.test.ts passes and moves to the run
tests.
```

Never push to `main` without a green `npm run check`. Never `npm publish` from a branch.

## Code health

`make crap` gives each function's CRAP score (complexity against line coverage) and `make dry`
lists candidate duplicate code. Both use tools outside npm, which `make tools` (or `make setup`, which runs `npm ci` first) installs in
`.tools/` at pinned commits (needs git and python3); the first `make crap` or `make dry` runs it
for you.

## Releasing

`npm version patch`, `minor` or `major` (you choose: a breaking change before 1.0 is a minor). It
runs the check, stamps "Unreleased" in `CHANGELOG.md` and `MIGRATION.md` with the version and the
date (`tools/changelog.ts`), commits and tags; it refuses a release with nothing under "Unreleased".
Then `git push --follow-tags`: the tag runs `.github/workflows/release.yml`, which checks again,
publishes to npm with provenance and opens the GitHub Release from the version's CHANGELOG section.
A pull request that changes `src/` without touching `CHANGELOG.md` fails the check, unless it is
labelled "no changelog".
