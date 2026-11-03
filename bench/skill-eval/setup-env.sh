#!/usr/bin/env bash
# Installs the consumer project's dependencies once per condition, into envs/<cond>/node_modules.
#
#   ./setup-env.sh A        # needs packages/hopgraph-A.tgz (packages/build.sh)
#   ./setup-env.sh A B C    # several
#
# envs/<cond>/ holds the template's package.json, vendor/hopgraph.tgz (the condition's tarball
# under the neutral name the package.json points at, the same in every condition and version), the
# package-lock.json npm writes and node_modules. new-run.sh clones all four into a run.
set -euo pipefail
E="$(cd "$(dirname "$0")" && pwd)"
for cond in "$@"; do
  tgz="$E/packages/hopgraph-$cond.tgz"
  [ -f "$tgz" ] || { echo "setup-env.sh: no $tgz; run packages/build.sh" >&2; exit 1; }
  env="$E/envs/$cond"
  rm -rf "$env"
  mkdir -p "$env/vendor"
  cp "$E/template/package.json" "$env/package.json"
  cp "$tgz" "$env/vendor/hopgraph.tgz"
  start=$(date +%s)
  (cd "$env" && npm install --prefer-offline --no-audit --no-fund --loglevel=error >/dev/null)
  echo "$cond: installed in $(( $(date +%s) - start ))s; hopgraph $(node -p 'require(process.argv[1]).version' "$env/node_modules/hopgraph/package.json"): $(ls "$env/node_modules/hopgraph" | tr '\n' ' ')"
done
