#!/bin/bash
# Builds the two unpacked test packages, side by side in Chrome:
#   <out>/develop/ + develop.zip  = origin/develop, blue icons, "Open Scraper (develop)"
#   <out>/current/ + current.zip  = origin/develop + BRANCHES merged, orange icons, "Open Scraper (current)"
# Usage: scripts/test-builds/build.sh [out-dir] [branch...]
#   out-dir   default: ../open-scraper-test next to this clone
#   branch    default: the lines of scripts/test-builds/branches.local (gitignored, one branch per line)
# Never touches this checkout: builds from origin/* in a temporary worktree.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
REPO="$(git -C "$DIR" rev-parse --show-toplevel)"
OUT="${1:-$REPO/../open-scraper-test}"; [ $# -gt 0 ] && shift
if [ $# -gt 0 ]; then BRANCHES="$*"
elif [ -f "$DIR/branches.local" ]; then BRANCHES="$(grep -v '^[[:space:]]*#' "$DIR/branches.local" | xargs || true)"
else BRANCHES=""; fi
mkdir -p "$OUT"; OUT="$(cd "$OUT" && pwd)"

GIT=(git -C "$REPO" -c user.name=build -c user.email=build@local)
WT="$(mktemp -d)"; TMP="$(mktemp -d)"
trap '"${GIT[@]}" worktree remove -f "$WT" 2>/dev/null; rm -rf "$WT" "$TMP"' EXIT
"${GIT[@]}" fetch -q --prune origin
"${GIT[@]}" worktree add -q --detach "$WT" origin/develop

# build <name>: packages the worktree's HEAD as <out>/<name>/ + <name>.zip with its icons and a suffixed name.
build() {
    local name=$1
    rm -rf "${TMP:?}"/* && git -C "$WT" archive HEAD | tar -x -C "$TMP"
    cp "$DIR/icons/$name"/icon{16,32,64,128}.png "$TMP/"
    node -e '
        const fs = require("fs"), f = process.argv[1], name = "Open Scraper (" + process.argv[2] + ")";
        const src = fs.readFileSync(f, "utf8"), out = src.replace(/^(\s{3}"name":\s*)"[^"]*"/m, (_, k) => k + JSON.stringify(name));
        if (out === src || JSON.parse(out).name !== name) throw new Error("manifest name not replaced");
        fs.writeFileSync(f, out);' "$TMP/manifest.json" "$name"
    node "$TMP/scripts/package.mjs" >/dev/null
    rm -rf "${OUT:?}/$name" && mkdir "$OUT/$name"
    cp "$TMP"/dist/open-scraper-*.zip "$OUT/$name.zip"
    unzip -q "$OUT/$name.zip" -d "$OUT/$name"
    echo "$name: $(git -C "$WT" log -1 --format='%h %s')"
}

build develop
for b in $BRANCHES; do
    git -C "$WT" rev-parse -q --verify "origin/$b" >/dev/null || { echo "MISSING branch origin/$b (not pushed?)"; exit 1; }
    if ! git -C "$WT" -c user.name=build -c user.email=build@local merge -q --no-edit "origin/$b" >/dev/null; then
        echo "CONFLICT merging $b:"; git -C "$WT" diff --name-only --diff-filter=U
        exit 1
    fi
done
build current
echo "current = develop + ${BRANCHES:-(no branch)}"
