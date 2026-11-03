#!/usr/bin/env -S python3 -I -B
"""Checks that the hidden tests tell right from wrong, beyond the reference.

    ./variants.py [task ...]        (condition A; COND=B ./variants.py for B)

tasks/<task>/variants.json lists variants of the reference solution, each a set of exact string
edits on the reference files (or whole files under "files"): "expect": "fail" for a plausible
wrong solution (a classic misreading of the library; at least one hidden test must fail), "pass"
for another correct design (every hidden test must pass, tsc clean). Each variant is graded in
runs/<task>-<cond>-v<name>/ like an agent's run.
"""
import json, os, shutil, subprocess, sys

E = os.path.dirname(os.path.abspath(__file__))
cond = os.environ.get("COND", "A")
tasks = sys.argv[1:] or sorted(os.listdir(os.path.join(E, "tasks")))
runs_dir = os.path.join(E, "validation", "runs")
os.makedirs(runs_dir, exist_ok=True)
env = dict(os.environ, RUNS_DIR=runs_dir)
log = open(os.path.join(E, "validation", f"variants-{cond}.txt"), "w")
ok_all = True
for task in tasks:
    vfile = os.path.join(E, "tasks", task, "variants.json")
    if not os.path.exists(vfile):
        continue
    for v in json.load(open(vfile)):
        rep = "v" + v["name"].replace("-", "_")
        name = f"{task}-{cond}-{rep}"
        run = os.path.join(runs_dir, name)
        shutil.rmtree(run, ignore_errors=True)
        subprocess.run([os.path.join(E, "new-run.sh"), task, cond, rep], check=True, capture_output=True, env=env)
        shutil.copytree(os.path.join(E, "tasks", task, "reference"), run, dirs_exist_ok=True)
        for rel, text in v.get("files", {}).items():
            with open(os.path.join(run, rel), "w") as f:
                f.write(text)
        for ed in v.get("edits", []):
            path = os.path.join(run, ed["file"])
            s = open(path).read()
            if s.count(ed["old"]) != 1:
                sys.exit(f"{name}: edit not found exactly once in {ed['file']}: {ed['old'][:60]!r}")
            open(path, "w").write(s.replace(ed["old"], ed["new"]))
        subprocess.run([os.path.join(E, "grade.sh"), run], check=True, capture_output=True)
        g = json.load(open(os.path.join(run, "grade.json")))
        failed = [t["name"] for t in g["tests"] if not t["ok"]]
        green = not failed and g["tsc"]["ok"]
        good = green if v["expect"] == "pass" else bool(failed)
        ok_all &= good
        mark = "ok  " if good else "BAD "
        say = lambda line: (print(line), log.write(line + "\n"))
        say(f"{mark}{task} v{v['name']} (expect {v['expect']}): hidden {g['passed']}/{g['total']}, tsc {'ok' if g['tsc']['ok'] else g['tsc']['errors']}  -- {v['why']}")
        for f in failed:
            say(f"        fails: {f}")
        if not g["tsc"]["ok"]:
            for e in g["tsc"]["first_errors"][:3]:
                say(f"        tsc: {e}")
sys.exit(0 if ok_all else 1)
