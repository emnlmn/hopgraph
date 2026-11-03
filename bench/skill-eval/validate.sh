#!/usr/bin/env bash
# Validates the tasks: for each task and condition, grades the bare starter once and the starter
# with the reference solution laid over it three times (determinism). The runs live in
# validation/runs/ (never in runs/, where agents' runs go: these hold reference solutions), each
# with its grade.json; the log goes to validation/validation.txt.
#
#   ./validate.sh                 # every task, conditions A and B
#   ./validate.sh t1-add-source   # one task
set -euo pipefail
E="$(cd "$(dirname "$0")" && pwd)"
tasks=("$@"); [ ${#tasks[@]} -gt 0 ] || tasks=($(ls "$E/tasks"))
conds=(${CONDS:-A B})
export RUNS_DIR="$E/validation/runs"
mkdir -p "$RUNS_DIR"
out="$E/validation/validation.txt"
: >"$out"
for task in "${tasks[@]}"; do
  for cond in "${conds[@]}"; do
    for rep in starter ref1 ref2 ref3; do
      rm -rf "$RUNS_DIR/$task-$cond-$rep"
      run="$("$E/new-run.sh" "$task" "$cond" "$rep")"
      if [ "$rep" != starter ]; then cp -R "$E/tasks/$task/reference/." "$run/"; fi
      # the visible tests too, as an agent would run them: the project's own config
      (cd "$run" && node_modules/.bin/tsc --noEmit >/dev/null 2>&1 && echo "  project tsc ok" || echo "  project tsc FAILED") >>"$out"
      "$E/grade.sh" "$run" | tee -a "$out"
    done
  done
done
