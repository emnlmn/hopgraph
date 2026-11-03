#!/usr/bin/env bash
# Makes a fresh run directory for one agent: the template, the task's starter on top, and the
# condition's installed dependencies.
#
#   ./new-run.sh <task> <cond> <rep>      e.g. ./new-run.sh t1-add-source A 1
#   RUNS_DIR=/private/tmp/hg-runs ./new-run.sh t1-add-source A 1   # runs elsewhere (recommended:
#                                         # outside this harness, away from tasks/*/hidden)
#
# Prints the run's absolute path. The run holds no trace of the condition or the task's hidden
# tests or reference: task, cond and rep are read back from the directory name by grade.sh.
# node_modules is an APFS clone (cp -c: copy-on-write, near instant) of envs/<cond>/node_modules,
# or a plain copy where cloning is not supported. The starter is committed to a fresh git repo so
# grade.sh can list what the agent changed.
set -euo pipefail
E="$(cd "$(dirname "$0")" && pwd)"
[ $# -eq 3 ] || { echo "usage: $0 <task> <cond> <rep>" >&2; exit 2; }
task="$1"; cond="$2"; rep="$3"
case "$cond$rep" in *-*|*/*) echo "new-run.sh: cond and rep may not contain '-' or '/' (grade.sh reads them back from the name)" >&2; exit 2;; esac
[ -d "$E/tasks/$task/starter" ] || { echo "new-run.sh: no task $task" >&2; exit 1; }
[ -d "$E/envs/$cond/node_modules" ] || { echo "new-run.sh: no env $cond (run setup-env.sh $cond)" >&2; exit 1; }
runs="${RUNS_DIR:-$E/runs}"
mkdir -p "$runs"
run="$(cd "$runs" && pwd)/$task-$cond-$rep"
[ -e "$run" ] && { echo "new-run.sh: $run exists" >&2; exit 1; }

mkdir -p "$run"
cp -R "$E/template/." "$run/"
cp -R "$E/tasks/$task/starter/." "$run/"
cp "$E/envs/$cond/package-lock.json" "$run/package-lock.json"
cp -R "$E/envs/$cond/vendor" "$run/vendor"
cp -cR "$E/envs/$cond/node_modules" "$run/node_modules" 2>/dev/null || {
  rm -rf "$run/node_modules"
  cp -R "$E/envs/$cond/node_modules" "$run/node_modules"
}
(
  cd "$run"
  git init -q
  git add -A
  git -c user.name=starter -c user.email=starter@example.com commit -qm "starter" --no-gpg-sign
)
echo "$run"
