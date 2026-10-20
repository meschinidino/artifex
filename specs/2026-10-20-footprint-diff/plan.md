# Footprint diff contents: plan

## Touch list

- `server/diff.ts` (new): `readDiff(root, rel)` — `git diff HEAD
  --numstat` + `git diff HEAD -U3` via `spawnCapture` (fixed
  argv, `--` separator), 120-line hunk cap, `{ added, removed,
  hunks, truncated, untracked } | undefined`. Untracked =
  empty output while footed-added (caller passes the verdict).
- `floor-ui/wire.ts`: `get-diff` client message, `diff` server
  message (path, added, removed, hunks, truncated, masked,
  untracked).
- `server/index.ts`: `get-diff` case → `handleGetDiff`
  (open-file validation reused: contained + member + !excluded;
  label root via `rootByLabel`; mask via `maskContent`).
- `floor-ui/{index.html,app.ts,styles.css}`: Changes section
  (`#insp-diff-title` + `#insp-diff`), fetched on selection and
  with `requestPreviewSoon` for footed buildings, hidden on
  stale/deselect/empty.
- `package.json`: typecheck argv gains `server/diff.ts` +
  `server/diff.test.ts`.
- Tests: `server/diff.test.ts` (real-git: modified/untracked/
  clean/non-git/cap), server round-trip (WS `get-diff` →
  `diff`), `e2e/floor.test.ts` (trio fixture hunks for
  `src/a.ts`).

## Not in scope

Removed-file deleted-line recovery (`git show HEAD:path`),
word-diff, diff for staged-only vs unstaged splits, hunk
staging actions.
