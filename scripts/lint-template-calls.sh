#!/bin/sh
# Lints template/ callers, and checks that each passes only inputs and secrets
# the shared workflow it calls still declares. Callers point at
# guangshinhaha/gantry/.github/workflows/X.yml@main, which actionlint can't
# read, so this copies them into a scratch repo next to this checkout's shared
# workflows, repoints them at ./.github/workflows/X.yml, and lets actionlint
# check each call. Options left commented out inside a job that calls a shared
# workflow are uncommented first, because those are the ones a repo turns on
# later. Errors are reported against the template/ path.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.github/workflows"
git init -q "$tmp"

for f in "$root"/.github/workflows/*.yml "$root"/.github/workflows/*.yaml; do
  [ -e "$f" ] && cp "$f" "$tmp/.github/workflows/"
done
for f in "$root"/template/.github/workflows/*.yml "$root"/template/.github/workflows/*.yaml; do
  [ -e "$f" ] || continue
  sed -E 's#guangshinhaha/gantry/(\.github/workflows/[^@ "]+)@[^ "'"'"']+#./\1#' "$f" |
    awk '
      # Inside a job that calls a shared workflow (from its `uses:` line until
      # a live line dedents past it), turn `# key: value` back into `key: value`.
      match($0, /^ *uses: \.\//) { ind = index($0, "u") - 1; inside = 1; print; next }
      inside && /^ *[^ #]/ { match($0, /^ */); if (RLENGTH < ind) inside = 0 }
      inside && match($0, /^ *# /) && RLENGTH >= ind + 2 {
        rest = substr($0, RLENGTH + 1)
        if (rest ~ /^ *(with:|secrets:|[A-Za-z_][A-Za-z0-9_-]*: [^ ])/) {
          $0 = substr($0, 1, RLENGTH - 2) rest
        }
      }
      { print }
    ' > "$tmp/.github/workflows/caller-$(basename "$f")"
done

cd "$tmp"
status=0
out=$(actionlint .github/workflows/caller-*) || status=$?
[ -z "$out" ] || printf '%s\n' "$out" | sed 's#^\.github/workflows/caller-#template/.github/workflows/#'
exit "$status"
