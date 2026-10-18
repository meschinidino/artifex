#!/usr/bin/env bash
# Raw-coverage gate: the committed bar is >=95% functions AND lines
# on Bun's text reporter (docs/coverage-reaudit.md §9). Runs the
# full unit suite with coverage and fails if either axis drops
# below the bar or the totals row cannot be found.
set -u

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

if ! bun test --coverage >"$OUT" 2>&1; then
  cat "$OUT" >&2
  echo "coverage-gate: bun test failed" >&2
  exit 1
fi

ROW="$(grep "All files" "$OUT" || true)"
if [ -z "$ROW" ]; then
  cat "$OUT" >&2
  echo "coverage-gate: 'All files' totals row not found" >&2
  exit 1
fi

FUNCS="$(printf '%s' "$ROW" | awk -F'|' '{gsub(/ /, "", $2); print $2}')"
LINES="$(printf '%s' "$ROW" | awk -F'|' '{gsub(/ /, "", $3); print $3}')"
echo "coverage: funcs ${FUNCS}% lines ${LINES}% (bar: 95/95)"

awk -v f="$FUNCS" -v l="$LINES" 'BEGIN { exit (f + 0 >= 95 && l + 0 >= 95) ? 0 : 1 }' || {
  echo "coverage-gate: below the 95% bar (funcs ${FUNCS}, lines ${LINES})" >&2
  exit 1
}
