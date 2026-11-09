#!/bin/sh
# Lints template/ callers, and checks that each passes only inputs and secrets
# the shared workflow it calls still declares. Callers point at
# guangshinhaha/gantry/.github/workflows/X.yml@main, which actionlint can't
# read, so this copies them into a scratch repo next to this checkout's shared
# workflows, repoints them at ./.github/workflows/X.yml, and lets actionlint
# check each call. Options left commented out are checked too when the comment
# block starts with a `# gantry:optional` line: the block is uncommented in the
# scratch copy, as a repo would when it turns the options on. Prose comments
# elsewhere are left alone.
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
  # The marker line becomes a blank line so line numbers still match the template.
  awk '
    /^[ \t]*# gantry:optional[ \t]*$/ { on = 1; print ""; next }
    on && /^[ \t]*#/ { sub(/# ?/, ""); print; next }
    { on = 0; print }
  ' "$f" |
    sed -E 's#guangshinhaha/gantry/(\.github/workflows/[^@ "]+)@[^ "'"'"']+#./\1#' > "$out"
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
# Same severity as the actionlint step in own-ci.yml: info-level notes pass.
export SHELLCHECK_OPTS="${SHELLCHECK_OPTS:---severity=warning}"
out=$(actionlint -format '{{range $}}::error file={{.Filepath}},line={{.Line}},col={{.Column}}::{{.Message}}\n{{end}}' \
  .github/workflows/caller-*) || status=$?
[ -z "$out" ] || printf '%s\n' "$out" | sed 's#file=\.github/workflows/caller-#file=template/.github/workflows/#'
exit "$status"
