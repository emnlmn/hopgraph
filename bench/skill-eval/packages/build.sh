#!/usr/bin/env bash
# Builds the hopgraph tarballs of the three documentation conditions from one commit, without
# touching the repo.
#
#   packages/build.sh <commit>            e.g. packages/build.sh main   or   packages/build.sh fb6484c
#   REPO=/path/to/hopgraph packages/build.sh <commit>     (default: the repo this harness is in)
#
# A = `npm pack` of a fresh build of <commit> without its skills/ (dist with .d.ts, src, README.md,
#     DESIGN.md, LICENSE): the package as it was before it shipped a skill.
# B = A + docs/guide.md at package/docs/guide.md (the README's link to it resolves).
# C = A + the commit's skills/hopgraph/ at package/skills/hopgraph/ (when the commit has one).
#
# How it stays out of the repo: `git archive <commit>` exports the committed tree into a temp dir
# under $E (git only reads; no worktree is registered), `npm ci` installs that commit's own
# lockfile there, `npm run build` writes dist/ there, and `npm pack --pack-destination` writes the
# tarball here. The temp dir is removed at the end. The repo's working tree, branches and
# node_modules are never used.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
E="$(cd "$HERE/.." && pwd)"
REPO="${REPO:-$(cd "$E/../.." && pwd)}"
[ $# -eq 1 ] || { echo "usage: $0 <commit>   (a commit, tag or branch of $REPO)" >&2; exit 2; }
REF="$1"
COMMIT="$(git -C "$REPO" rev-parse --verify "$REF^{commit}")"

WORK="$(mktemp -d "$E/.build.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

mkdir -p "$WORK/src-tree"
git -C "$REPO" archive --format=tar "$COMMIT" | tar -x -C "$WORK/src-tree"

(
  cd "$WORK/src-tree"
  # pack must not run code of its own: refuse a package with pack lifecycle scripts
  if ! node -e 'const s=require("./package.json").scripts||{};process.exit(["prepack","prepare","postpack","prepublishOnly"].some(k=>s[k])?1:0)'; then
    echo "build.sh: the package has pack lifecycle scripts; review them before packing" >&2
    exit 1
  fi
  # the commit's own lockfile; install scripts are not needed to compile
  npm ci --prefer-offline --no-audit --no-fund --ignore-scripts --loglevel=error >/dev/null
  npm run build --silent
)

# A
(cd "$WORK/src-tree" && npm pack --silent --ignore-scripts --pack-destination "$WORK" >/dev/null)
TGZ="$(ls "$WORK"/hopgraph-*.tgz)"
VERSION="$(basename "$TGZ" .tgz | sed 's/^hopgraph-//')"
mkdir -p "$WORK/packed"
tar -xzf "$TGZ" -C "$WORK/packed"

# A, B and C: re-tarred with the same `package/` root npm uses.
retar() { # $1 = condition, $2 = staging dir holding package/
  # files only, sorted, no macOS metadata or owner names: like npm's own tarball
  # (gzip -n: no timestamp in the header, so the same inputs give the same bytes)
  (cd "$2" && find package -type f | LC_ALL=C sort | COPYFILE_DISABLE=1 tar -cf - \
    --no-xattrs --no-mac-metadata --uid 0 --gid 0 --uname "" --gname "" -T - | gzip -n -9 >"$HERE/hopgraph-$1.tgz")
}

# A: the packed package without the skill it ships
mkdir -p "$WORK/A"
cp -Rp "$WORK/packed/package" "$WORK/A/package"
rm -rf "$WORK/A/package/skills"
retar A "$WORK/A"

mkdir -p "$WORK/B"
tar -xzf "$HERE/hopgraph-A.tgz" -C "$WORK/B"
mkdir -p "$WORK/B/package/docs"
cp -p "$WORK/src-tree/docs/guide.md" "$WORK/B/package/docs/guide.md"
retar B "$WORK/B"

if [ -d "$WORK/src-tree/skills/hopgraph" ]; then
  mkdir -p "$WORK/C"
  tar -xzf "$HERE/hopgraph-A.tgz" -C "$WORK/C"
  mkdir -p "$WORK/C/package/skills"
  cp -Rp "$WORK/src-tree/skills/hopgraph" "$WORK/C/package/skills/hopgraph"
  retar C "$WORK/C"
else
  rm -f "$HERE/hopgraph-C.tgz"
fi

{
  echo "repo:     $REPO"
  echo "ref:      $REF"
  echo "commit:   $COMMIT  $(git -C "$REPO" log -1 --format=%s "$COMMIT" | cut -c1-80)"
  echo "version:  $VERSION"
  echo "built:    $(date -u +%Y-%m-%dT%H:%M:%SZ), node $(node --version), npm $(npm --version)"
  for c in A B C; do
    f="$HERE/hopgraph-$c.tgz"
    [ -f "$f" ] || continue
    echo
    echo "== hopgraph-$c.tgz  $(shasum -a 256 "$f" | cut -c1-16)  $(tar -tzf "$f" | wc -l | tr -d ' ') files"
    tar -tzf "$f" | grep -v -E '^package/(dist|src)/' | sort
  done
} >"$HERE/BUILD-INFO.txt"
cat "$HERE/BUILD-INFO.txt"
