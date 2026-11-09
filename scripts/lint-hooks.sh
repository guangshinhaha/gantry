#!/bin/sh
# Validates the hook YAML with lefthook itself, which rejects duplicate keys
# (yq accepts them). Checks every hooks/*.yml, template/lefthook.yml as
# committed, and template/lefthook.yml with its commented `# - hooks/x.yml`
# lines turned on, the form gantry-init leaves behind. Also checks that each
# `configs:` path, live or commented, exists under hooks/.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git init -q "$tmp"
status=0

# validate <source file> <file to report against> [label]
validate() {
  cp "$1" "$tmp/lefthook.yml"
  if ! out=$(cd "$tmp" && lefthook validate 2>&1); then
    msg=$(printf '%s' "$out" | tr '\n' ' ')
    echo "::error file=$2::${3:+$3: }$msg"
    status=1
  fi
}

for f in "$root"/hooks/*.yml "$root"/hooks/*.yaml; do
  [ -e "$f" ] || continue
  validate "$f" "hooks/$(basename "$f")"
done

t="$root/template/lefthook.yml"
validate "$t" template/lefthook.yml
sed -E 's/^( *)# (- hooks\/)/\1\2/' "$t" > "$tmp/enabled.yml"
validate "$tmp/enabled.yml" template/lefthook.yml "with commented configs enabled"

grep -nE '^ *#? ?- hooks/' "$t" | while IFS=: read -r line rest; do
  p=$(printf '%s' "$rest" | sed -E 's/^ *#? ?- //; s/ *#.*$//')
  [ -e "$root/$p" ] || echo "::error file=template/lefthook.yml,line=$line::configs: $p does not exist"
done > "$tmp/missing"
if [ -s "$tmp/missing" ]; then cat "$tmp/missing"; status=1; fi
exit "$status"
