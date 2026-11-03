#!/usr/bin/env -S python3 -I -B
"""Summarizes graded runs and their transcripts, per condition.

    ./summarize.py <pairs-file> [<out-dir>]
    ./summarize.py --pair <run-dir> <transcript.jsonl> [--pair ...] [--out <out-dir>]

<pairs-file>: one run per line, `<run-dir> <transcript.jsonl>` (whitespace or tab separated;
`#` comments). Each run must have been graded (grade.sh writes <run-dir>/grade.json). Writes
<out-dir>/results.json (one record per run: grade + metrics) and <out-dir>/summary.md (default
out-dir: the harness's results/), and prints the markdown.

Per condition (and per task x condition): runs; hidden tests passed/total and pass rate; tasks fully
passed (every hidden test and tsc) / runs; tsc clean; median and mean of tokens total, peak context,
turns, tool calls and wall seconds; mean doc chars read per run by target; runs with a protocol
violation and their count (paths outside the run: the repo, the harness's tasks, other runs,
network) and runs that changed the fakes or the project config.
"""
import json
import os
import statistics
import sys
from collections import OrderedDict, defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from metrics import measure  # noqa: E402

TARGETS = ["README.md", "DESIGN.md", "docs/guide.md", "skills", "dist d.ts", "src", "other node_modules/hopgraph"]


def load_pairs(argv):
    pairs, out = [], os.path.join(HERE, "results")
    if argv and argv[0] != "--pair":
        with open(argv[0]) as f:
            for line in f:
                line = line.split("#", 1)[0].strip()
                if line:
                    run, tr = line.split(None, 1)
                    pairs.append((run, tr.strip()))
        if len(argv) > 1:
            out = argv[1]
        return pairs, out
    i = 0
    while i < len(argv):
        if argv[i] == "--pair":
            pairs.append((argv[i + 1], argv[i + 2]))
            i += 3
        elif argv[i] == "--out":
            out = argv[i + 1]
            i += 2
        else:
            sys.exit(f"unexpected argument {argv[i]}")
    return pairs, out


def record(run, transcript):
    g = json.load(open(os.path.join(run, "grade.json")))
    m = measure(transcript, run)
    return {
        "run": os.path.abspath(run),
        "task": g["task"], "cond": g["cond"], "rep": g["rep"],
        "grade": g,
        "metrics": {k: v for k, v in m.items() if k != "doc_reads"},
        "doc_reads": m["doc_reads"],
    }


def med(xs):
    return statistics.median(xs) if xs else 0


def mean(xs):
    return statistics.fmean(xs) if xs else 0


def aggregate(recs):
    passed = sum(r["grade"]["passed"] for r in recs)
    total = sum(r["grade"]["total"] for r in recs)
    col = lambda f: [f(r) for r in recs]
    tokens = col(lambda r: r["metrics"]["tokens"]["total"])
    peak = col(lambda r: r["metrics"]["peak_context"])
    turns = col(lambda r: r["metrics"]["turns"])
    calls = col(lambda r: r["metrics"]["tool_calls_total"])
    wall = col(lambda r: r["metrics"]["wall_seconds"])
    docs = {t: mean(col(lambda r, t=t: r["metrics"]["doc_chars_total"].get(t, 0))) for t in TARGETS}
    viol = col(lambda r: len(r["metrics"]["violations"]))
    return OrderedDict(
        runs=len(recs),
        hidden_passed=passed, hidden_total=total,
        pass_rate=passed / total if total else 0,
        fully_passed=sum(r["grade"]["fully_passed"] for r in recs),
        tsc_clean=sum(r["grade"]["tsc"]["ok"] for r in recs),
        tokens_median=med(tokens), tokens_mean=mean(tokens),
        peak_context_median=med(peak), peak_context_mean=mean(peak),
        turns_median=med(turns), turns_mean=mean(turns),
        tool_calls_median=med(calls), tool_calls_mean=mean(calls),
        wall_median=med(wall), wall_mean=mean(wall),
        doc_chars_mean=docs,
        runs_with_violations=sum(1 for v in viol if v), violations=sum(viol),
        runs_changing_fakes=sum(1 for r in recs if r["grade"].get("fakes_changed")),
        runs_changing_config=sum(1 for r in recs if r["grade"].get("config_changed")),
    )


def k(n):
    return f"{n / 1000:.0f}k" if n >= 1000 else f"{n:.0f}"


def table(groups, title):
    lines = [f"### {title}", "",
             "| group | runs | hidden passed | pass rate | fully passed | tsc clean | tokens med / mean | peak ctx med / mean | turns med / mean | tool calls med / mean | wall s med / mean | violations (runs) | fakes / config changed |",
             "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|"]
    for name, a in groups.items():
        lines.append(
            f"| {name} | {a['runs']} | {a['hidden_passed']}/{a['hidden_total']} | {a['pass_rate']:.0%} | "
            f"{a['fully_passed']}/{a['runs']} | {a['tsc_clean']}/{a['runs']} | "
            f"{k(a['tokens_median'])} / {k(a['tokens_mean'])} | {k(a['peak_context_median'])} / {k(a['peak_context_mean'])} | "
            f"{a['turns_median']:.0f} / {a['turns_mean']:.1f} | {a['tool_calls_median']:.0f} / {a['tool_calls_mean']:.1f} | "
            f"{a['wall_median']:.0f} / {a['wall_mean']:.0f} | {a['violations']} ({a['runs_with_violations']}) | "
            f"{a['runs_changing_fakes']} / {a['runs_changing_config']} |")
    lines += ["", f"Mean characters of the installed package read per run, by target:", "",
              "| group | " + " | ".join(TARGETS) + " |", "|---|" + "---:|" * len(TARGETS)]
    for name, a in groups.items():
        lines.append(f"| {name} | " + " | ".join(k(a["doc_chars_mean"][t]) for t in TARGETS) + " |")
    return lines


def per_test(recs):
    """Hidden test pass counts per task, test and condition: the report's rows."""
    by = defaultdict(lambda: defaultdict(lambda: [0, 0]))
    conds = sorted({r["cond"] for r in recs})
    for r in recs:
        for t in r["grade"]["tests"]:
            cell = by[(r["task"], t["name"])][r["cond"]]
            cell[0] += t["ok"]
            cell[1] += 1
    lines = ["### Hidden tests", "", "| task | test | " + " | ".join(conds) + " |", "|---|---|" + "---:|" * len(conds)]
    for (task, name), cells in sorted(by.items()):
        lines.append(f"| {task} | {name} | " + " | ".join(
            f"{cells[c][0]}/{cells[c][1]}" if cells[c][1] else "" for c in conds) + " |")
    return lines


def main():
    pairs, out = load_pairs(sys.argv[1:])
    if not pairs:
        sys.exit(__doc__)
    recs = [record(run, tr) for run, tr in pairs]
    by_cond = OrderedDict((c, aggregate([r for r in recs if r["cond"] == c])) for c in sorted({r["cond"] for r in recs}))
    by_task_cond = OrderedDict(
        (f"{t} {c}", aggregate([r for r in recs if r["task"] == t and r["cond"] == c]))
        for t in sorted({r["task"] for r in recs}) for c in sorted({r["cond"] for r in recs})
        if any(r["task"] == t and r["cond"] == c for r in recs))
    os.makedirs(out, exist_ok=True)
    json.dump({"runs": recs, "by_cond": by_cond, "by_task_cond": by_task_cond},
              open(os.path.join(out, "results.json"), "w"), indent=2)
    md = ["# Skill eval results", "", f"{len(recs)} runs.", ""]
    md += table(by_cond, "Per condition") + [""]
    md += table(by_task_cond, "Per task and condition") + [""]
    md += per_test(recs) + [""]
    viol = [(r["task"], r["cond"], r["rep"], v) for r in recs for v in r["metrics"]["violations"]]
    if viol:
        md += ["### Protocol violations", "", "| run | tool | category | path |", "|---|---|---|---|"]
        md += [f"| {t}-{c}-{rep} | {v['tool']} | {v['category']} | `{v['path']}` |" for t, c, rep, v in viol]
    text = "\n".join(md) + "\n"
    open(os.path.join(out, "summary.md"), "w").write(text)
    print(text)


if __name__ == "__main__":
    main()
