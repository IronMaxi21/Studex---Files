#!/bin/bash
# Parses every frontend module as ESM. node --check does not execute the file,
# so browser-only globals are irrelevant — this catches syntax errors only.
set -u
web="$(cd "$(dirname "$0")/../web" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fail=0
while IFS= read -r f; do
  cp "$f" "$tmp/mod.mjs"
  if ! out=$(node --check "$tmp/mod.mjs" 2>&1); then
    echo "✗ ${f#"$web"/}"
    echo "$out" | sed -n '1,6p'
    fail=1
  fi
done < <(find "$web/js" -name '*.js')
[ $fail -eq 0 ] && echo "✓ all modules parse"
exit $fail
