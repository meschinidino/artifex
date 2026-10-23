# specs/ — agent-private diaries

This directory is agent working memory, not human documentation.
Humans judge behavior + proof in the panel; they never need to open this folder.

## Convention (2026-10-23, option A)

- One effort = one file: `specs/YYYY-MM-DD-name.md` (lowercase hyphen-case).
- No `plan.md` / `requirements.md` / `validation.md` triplets, no per-effort
  directories. (This supersedes the roadmap-next-step triplet default; that
  skill defers to a stronger repo convention, and this is it.)
- A diary holds, in order: what was agreed (requirements), how it was built
  (plan), what ran green (validation). Sections, not files.
- Living docs stay at top level: `mission.md`, `tech_stack.md`, `roadmap.md`.

## History

Before 2026-10-23 each effort was a directory with the triplet. All 20 were
collapsed into single diaries; content preserved under `## <source>` headings.
