#!/bin/sh
# Checks that every template/ caller passes only inputs and secrets the shared
# workflow it calls still declares. Callers point at
# guangshinhaha/gantry/.github/workflows/X.yml@main, which actionlint can't
# read, so this copies them into a scratch repo next to this checkout's shared
# workflows, repoints them at ./.github/workflows/X.yml, and lets actionlint
# check each call. Options left commented out under `with:` are uncommented
# first, because those are the ones a repo turns on later.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/.github/workflows"
git init -q "$tmp"

cp "$root"/.github/workflows/*.yml "$tmp/.github/workflows/"
for f in "$root"/template/.github/workflows/*.yml; do
  sed -E \
    -e 's#guangshinhaha/gantry/(\.github/workflows/[^@ ]+)@[^ ]+#./\1#' \
    -e 's/^( *)# ( *)(with:|secrets:|[a-z][a-z0-9-]*: [^ ])/\1\2\3/' \
    "$f" > "$tmp/.github/workflows/caller-$(basename "$f")"
done

cd "$tmp"
actionlint -shellcheck= -pyflakes= .github/workflows/caller-*.yml
