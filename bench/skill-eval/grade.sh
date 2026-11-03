#!/usr/bin/env bash
# Grades a finished run: copies the task's hidden tests in, type-checks, runs every test.
#
#   ./grade.sh <run-dir>
#
# Writes <run-dir>/grade.json:
#   { task, cond, rep,
#     tsc: { ok, errors, errors_in_hidden, first_errors },
#     tests: [{ name, ok }]  (hidden tests only),  passed, total, fully_passed,
#     visible: { passed, total },
#     changed: [files the agent changed vs the starter commit], config_changed,
#     fakes_changed: [changed files under src/sources/, the fakes the hidden tests drive],
#     seconds: { tsc, vitest } }
# The grader uses its own tsconfig and vitest config (copies of the template's, in <run>/.grade/),
# so an agent that edits tsconfig.json or vitest.config.ts cannot change what is checked;
# config_changed says whether it did. Hidden tests stay in <run>/test/hidden afterwards.
set -euo pipefail
E="$(cd "$(dirname "$0")" && pwd)"
[ $# -eq 1 ] || { echo "usage: $0 <run-dir>" >&2; exit 2; }
run="$(cd "$1" && pwd)"
name="$(basename "$run")"
rep="${name##*-}"; rest="${name%-*}"; cond="${rest##*-}"; task="${rest%-*}"
[ -d "$E/tasks/$task/hidden" ] || { echo "grade.sh: cannot tell the task of $name" >&2; exit 1; }

g="$run/.grade"
rm -rf "$g" "$run/test/hidden"
mkdir -p "$g" "$run/test"
cp -R "$E/tasks/$task/hidden" "$run/test/hidden"

# The grader's tsconfig: the template's, rooted at the run.
node -e '
  const fs = require("fs");
  const t = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  t.include = ["../src", "../test"];
  fs.writeFileSync(process.argv[2], JSON.stringify(t, null, 2));
' "$E/template/tsconfig.json" "$g/tsconfig.json"
cat >"$g/vitest.config.ts" <<'CFG'
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
CFG

cd "$run"
t0=$(date +%s)
set +e
node_modules/.bin/tsc --noEmit -p "$g/tsconfig.json" --pretty false >"$g/tsc.txt" 2>&1
tsc_status=$?
t1=$(date +%s)
node_modules/.bin/vitest run --root "$run" --config "$g/vitest.config.ts" \
  --reporter=json --outputFile="$g/vitest.json" >"$g/vitest.out" 2>&1
t2=$(date +%s)
set -e

git -C "$run" add -A -N . >/dev/null 2>&1 || true
git -C "$run" -c core.quotepath=off diff --name-only HEAD -- . ':(exclude)test/hidden' ':(exclude).grade' \
  >"$g/changed.txt" 2>/dev/null || true
git -C "$run" -c core.quotepath=off ls-files --others --exclude-standard -- . ':(exclude)test/hidden' ':(exclude).grade' \
  >>"$g/changed.txt" 2>/dev/null || true

python3 -I - "$g" "$task" "$cond" "$rep" "$tsc_status" "$((t1 - t0))" "$((t2 - t1))" <<'PY'
import json, os, re, sys
g, task, cond, rep, tsc_status, tsc_s, vitest_s = sys.argv[1:]
tsc_out = open(os.path.join(g, "tsc.txt")).read().splitlines()
errors = [l for l in tsc_out if re.search(r"error TS\d+", l)]
in_hidden = [l for l in errors if l.startswith("../test/hidden/") or l.startswith("test/hidden/")]
tests, visible = [], []
try:
    report = json.load(open(os.path.join(g, "vitest.json")))
except Exception:
    report = {"testResults": []}
for f in report.get("testResults", []):
    hidden = "/test/hidden/" in f.get("name", "")
    results = f.get("assertionResults", [])
    if not results and f.get("status") == "failed":
        # a file that failed to load: every hidden test in it is lost, reported as one failure
        entry = {"name": os.path.basename(f.get("name", "?")) + " (failed to load)", "ok": False}
        (tests if hidden else visible).append(entry)
    for a in results:
        entry = {"name": " > ".join([*a.get("ancestorTitles", [])[1:], a["title"]]), "ok": a["status"] == "passed"}
        (tests if hidden else visible).append(entry)
changed = sorted({l.strip() for l in open(os.path.join(g, "changed.txt")) if l.strip()})
grade = {
    "task": task, "cond": cond, "rep": rep,
    "tsc": {"ok": tsc_status == "0", "errors": len(errors), "errors_in_hidden": len(in_hidden),
            "first_errors": errors[:10]},
    "tests": tests,
    "passed": sum(t["ok"] for t in tests),
    "total": len(tests),
    "fully_passed": bool(tests) and all(t["ok"] for t in tests) and tsc_status == "0",
    "visible": {"passed": sum(t["ok"] for t in visible), "total": len(visible)},
    "changed": changed,
    "config_changed": any(c in changed for c in ("tsconfig.json", "vitest.config.ts", "package.json", "package-lock.json")),
    "fakes_changed": [c for c in changed if c.startswith("src/sources/")],
    "seconds": {"tsc": int(tsc_s), "vitest": int(vitest_s)},
}
json.dump(grade, open(os.path.join(os.path.dirname(g), "grade.json"), "w"), indent=2)
print(f"{task} {cond} {rep}: hidden {grade['passed']}/{grade['total']}, tsc {'ok' if grade['tsc']['ok'] else str(grade['tsc']['errors']) + ' errors'}, visible {grade['visible']['passed']}/{grade['visible']['total']}")
for t in tests:
    if not t["ok"]:
        print("  FAIL", t["name"])
PY
