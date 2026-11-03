# Does the agent skill help?

`skills/hopgraph/` is an [Agent Skill](https://agentskills.io/specification) the package ships for
coding agents. This harness measures what it changes: the same coding agent, given the same ticket
in the same small project that depends on hopgraph, with three versions of the installed package.

| Condition | `node_modules/hopgraph` holds |
| --- | --- |
| A | the package without its skill: dist with `.d.ts`, src, README.md, DESIGN.md |
| B | A + docs/guide.md (the guide every option is documented in) |
| C | A + skills/hopgraph/, named in the prompt the way an agent harness lists installed skills |

The prompts are identical but for C's one-line listing of the skill (`PROMPT.md`, `prompt.py`).

## The tasks

Four tickets on a music catalog, each a small project (`tasks/<task>/starter`) whose sources are
in-process fakes the hidden tests control. Each turns on hopgraph semantics a careless reading gets
wrong.

| Task | The ticket | What it hinges on |
| --- | --- | --- |
| t1-add-source | show each track's record label from a labels service | a new loader, relation and provider; "no label" and "service down" kept apart; one batched call per page |
| t2-debug-outcomes | the artist box shows the wrong text, three symptoms | keys left out of an envelope, an error caught as absent, a link key failing its schema |
| t3-cost-gate | warehouse reads behind a cost gate, with approval and resume | metered loaders, gates, `approved` and `prices`, a cache so a resume bills nothing twice |
| t4-deadline-viewer | a 300 ms page, and users without analytics access | `deadline`, `readable`, `restriction`, absent vs late vs forbidden |

t4 was held out: the skill was written from the baseline transcripts of t1 to t3, without looking
at t4's. Hidden tests (`tasks/<task>/hidden`) grade behaviour, never the shape of the code; each
starter fails them and each reference (`tasks/<task>/reference`) passes them, three runs out of
three (`validate.sh`). `variants.py` replays 21 plausible wrong solutions per condition and checks
each fails at least one hidden test.

## Results: 2026-11-03

hopgraph 0733f4a, Claude Sonnet 5.5 as the agent, one run per task and condition (12 runs). Raw
data: [`results/2026-11-03.json`](results/2026-11-03.json). The skill measured differs from the
one in `skills/hopgraph/` by two edits made afterwards so that its examples compile as one module
(`npm run skill`): the `Conn` type names `"wh"`, and the `tracks` loader the example relation reads
is declared.

**Every run passed every hidden test** (41 of 41 per condition), with `tsc` clean. The skill did
not change whether the agent got it right; it changed what getting there cost.

| Mean of 4 tasks | A: package | B: + guide | C: + skill | C vs B | C vs A |
| --- | ---: | ---: | ---: | ---: | ---: |
| tokens processed | 1,707k | 1,105k | **706k** | −36% | −59% |
| tokens written to cache | 101k | 89k | **49k** | −46% | −52% |
| output tokens | 23.3k | 16.3k | **14.7k** | −10% | −37% |
| cost, in input-token units | 401k | 293k | **199k** | **−32%** | **−50%** |
| peak context | 101k | 89k | **72k** | −19% | −29% |
| turns | 20.8 | 16.0 | **11.2** | −30% | −46% |
| wall time | 213 s | 148 s | **121 s** | −18% | −43% |
| characters of the package read | 73k | 58k | **25k** | −57% | −66% |

Cost weighs cache reads at 0.1, cache writes at 1.25 and output at 5 times an input token.

| Tokens processed, per task | A | B | C |
| --- | ---: | ---: | ---: |
| t1-add-source | 1,026k | 839k | **441k** |
| t2-debug-outcomes | 986k | 807k | **559k** |
| t3-cost-gate | 3,436k | 1,813k | **1,051k** |
| t4-deadline-viewer (held out) | 1,380k | 960k | **774k** |

What the agents read: in A, DESIGN.md (32k characters a run) and the `.d.ts` files (26k); in B, the
guide (20k), DESIGN.md (13k) and the library's source (17k); in C, the skill (17k) and, for t3, 23k
of source on how a resume reuses prices and the cache.

**What these numbers do not say.**
- One run per cell. The direction is the same on all four tasks (C below B below A in tokens), but
  a single difference may be noise.
- t1 to t3 are not independent of the skill, which was written from their baseline transcripts.
  The held-out t4 is the fair measure: −19% tokens against B, −44% against A, the same wall time
  as B.
- The tasks did not separate the conditions on correctness: Sonnet 5.5 solved them all from the
  package alone. Harder tasks, or a smaller model, may.
- No agent read the repo or the hidden tests. Five wrote a backup file outside their project while
  mutation-testing their own tests (in /tmp or the parent directory) and removed it.

## Running it

Needs Node 22.18 or later, npm, python3, git, and a way to run a coding agent per run directory
whose transcript records its tool calls and token usage (`metrics.py` reads Claude Code's subagent
transcripts, `~/.claude/projects/<project>/<session>/subagents/agent-<id>.jsonl`).

```sh
cd bench/skill-eval
packages/build.sh main            # hopgraph-{A,B,C}.tgz from a commit of this repo (git archive; the repo is not touched)
./setup-env.sh A B C              # one installed node_modules per condition
./validate.sh                     # starters fail the hidden tests, references pass them, 3 times
./variants.py && COND=B ./variants.py

RUNS_DIR=/tmp/hg-runs ./new-run.sh t1-add-source C 1   # a fresh project; prints its path
./prompt.py /tmp/hg-runs/t1-add-source-C-1             # the prompt to give the agent there
# … run the agent with that prompt, in that directory …
./grade.sh /tmp/hg-runs/t1-add-source-C-1              # hidden tests + tsc → grade.json
./summarize.py pairs.txt results/                      # pairs.txt: "<run dir> <transcript>" per line
```

Keep the run directories outside this repository: an agent must not find `tasks/*/hidden`.
`metrics.py` flags every tool call that touches a path outside its run (the repo, the harness,
other runs, the network) and counts what the agent read of the installed package, by file.
