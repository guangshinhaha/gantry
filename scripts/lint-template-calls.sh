#!/bin/sh
# Lints template/ callers, and checks that each passes only inputs and secrets
# the shared workflow it calls still declares. Callers point at
# guangshinhaha/gantry/.github/workflows/X.yml@main, which actionlint can't
# read, so this copies them into a scratch repo next to this checkout's shared
# workflows, repoints them at ./.github/workflows/X.yml, and lets actionlint
# check each call. Options left commented out in a template are not checked.
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
status=0
for f in "$root"/template/.github/workflows/*.yml "$root"/template/.github/workflows/*.yaml; do
  [ -e "$f" ] || continue
  out="$tmp/.github/workflows/caller-$(basename "$f")"
  sed -E 's#guangshinhaha/gantry/(\.github/workflows/[^@ "]+)@[^ "'"'"']+#./\1#' "$f" > "$out"
  # A shared-workflow call this didn't repoint is remote, so actionlint can't
  # check it. Fail rather than pass it unchecked.
  if grep -nE '^[^#]*uses: *["'"'"']?[^."'"'"' ][^ ]*/\.github/workflows/' "$out" > "$tmp/remote"; then
    while IFS=: read -r line _; do
      echo "::error file=template/.github/workflows/$(basename "$f"),line=$line::uses: is not guangshinhaha/gantry/.github/workflows/<file>@<ref>, so its inputs aren't checked"
    done < "$tmp/remote"
    status=1
  fi
done

cd "$tmp"
out=$(actionlint -format '{{range $}}::error file={{.Filepath}},line={{.Line}},col={{.Column}}::{{.Message}}\n{{end}}' \
  .github/workflows/caller-*) || status=$?
[ -z "$out" ] || printf '%s\n' "$out" | sed 's#file=\.github/workflows/caller-#file=template/.github/workflows/#'
exit "$status"
