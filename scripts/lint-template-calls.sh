#!/bin/sh
# Lints template/ callers, and checks that each passes only inputs and secrets
# the shared workflow it calls still declares. Callers point at
# guangshinhaha/gantry/.github/workflows/X.yml@main, which actionlint can't
# read, so this copies them into a scratch repo next to this checkout's shared
# workflows, repoints them at ./.github/workflows/X.yml, and lets actionlint
# check each call. Options left commented out inside a job that calls a shared
# workflow are uncommented first, because those are the ones a repo turns on
# later, so an error can point at a template line that is a comment there.
# Errors are reported against the template/ path, as GitHub annotations.
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
      # a live line dedents past it), turn `# key: value` back into
      # `key: value`. Keys are input-style (lower-kebab) or secret-style
      # (UPPER_SNAKE), so prose like `# Note: ...` stays a comment, and a key
      # already live at that indent is not added twice.
      match($0, /^ *uses: "?\.\//) {
        ind = index($0, "u") - 1; inside = 1; split("", live); print; next
      }
      inside && /^ *[^ #]/ {
        match($0, /^ */); if (RLENGTH < ind) inside = 0
        else { k = substr($0, RLENGTH + 1); sub(/:.*/, "", k); live[RLENGTH ":" k] = 1 }
      }
      inside && match($0, /^ *# /) && RLENGTH >= ind + 2 {
        rest = substr($0, RLENGTH + 1)
        if (rest ~ /^ *(with:|secrets:|[a-z][a-z0-9_-]*: [^ ]|[A-Z][A-Z0-9_]*: [^ ])/) {
          line = substr($0, 1, RLENGTH - 2) rest
          match(line, /^ */); k = substr(line, RLENGTH + 1); sub(/:.*/, "", k)
          if (!((RLENGTH ":" k) in live)) { $0 = line; live[RLENGTH ":" k] = 1 }
        }
      }
      { print }
    ' > "$tmp/.github/workflows/caller-$(basename "$f")"
done

cd "$tmp"
status=0
out=$(actionlint -format '{{range $}}::error file={{.Filepath}},line={{.Line}},col={{.Column}}::{{.Message}}\n{{end}}' \
  .github/workflows/caller-*) || status=$?
[ -z "$out" ] || printf '%s\n' "$out" | sed 's#file=\.github/workflows/caller-#file=template/.github/workflows/#'
exit "$status"
