/**
 * Instruction write-back: guarded append of human-authored lessons
 * into the viewed repo's `AGENTS.md`. Propose-mode only — this
 * module formats and places text the human wrote; it never
 * generates lesson content. Same untrusted-repo discipline as
 * `server/store.ts`: no writes through planted symlinks, bounded
 * reads, every refusal in plain words, the floor otherwise
 * unaffected. Never commits, stages, or touches version control.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { join } from "node:path";
import { MAX_INSTRUCTIONS_BYTES, MAX_LESSONS_PER_RUN, WRITEBACK_SECTION_HEADER } from "../floor-ui/wire.ts";
import type { RunRecord } from "../floor-ui/wire.ts";
import { buildLessonEntry, formatEntryDate, prepareLessonLines, splitLessonText } from "../floor-ui/runs.ts";

export type WritebackResult = { ok: boolean; text: string };

/** Device + inode identity of the file the block was prepared against. */
export type WritebackIdentity = { dev: number; ino: number };

/**
 * Test seam: production appends through `safeAppendFile` (an
 * `O_APPEND` descriptor write, never a path re-resolve).
 */
export type WritebackFs = {
  appendFile: (file: string, block: string, expected: WritebackIdentity | undefined) => void;
};

const ok = (text: string): WritebackResult => ({ ok: true, text });
const refuse = (text: string): WritebackResult => ({ ok: false, text });

/** Line-exact section check: a lesson mentioning the header is not the section. */
export function targetHasSectionText(existing: string): boolean {
  return existing.split("\n").some((line) => line === WRITEBACK_SECTION_HEADER);
}

/**
 * The exact bytes to append: the fenced header first (after a blank
 * line, respecting the trailing-newline state) when the file lacks
 * it, then one newline-terminated entry line per lesson. Never
 * reads existing content for meaning, never modifies it.
 */
export function buildAppendBlock(existing: string, entryLines: readonly string[]): string {
  let out = "";
  if (!targetHasSectionText(existing)) {
    out += existing.length === 0
      ? `${WRITEBACK_SECTION_HEADER}\n`
      : existing.endsWith("\n")
        ? `\n${WRITEBACK_SECTION_HEADER}\n`
        : `\n\n${WRITEBACK_SECTION_HEADER}\n`;
  } else if (existing.length > 0 && !existing.endsWith("\n")) {
    out += "\n";
  }
  for (const entry of entryLines) out += `${entry}\n`;
  return out;
}

/**
 * Bounded read of the just-checked instruction file, mirroring the
 * store loader: never an unbounded read on an untrusted path.
 * Returns the text with the read descriptor's identity (the write
 * must hit the same file), or undefined when the file must not be
 * read. `O_NOFOLLOW` on the open: a symlink swapped in after the
 * lstat refuses instead of reading through the link.
 */
function readInstructions(file: string): { text: string; dev: number; ino: number } | undefined {
  // The open sits inside the try (the store.ts shape): a throw
  // before the fd exists must refuse, never reach the close.
  let fd: number | undefined;
  try {
    fd = openSync(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > MAX_INSTRUCTIONS_BYTES) return undefined;
    const buf = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < opened.size) {
      const n = readSync(fd, buf, offset, opened.size - offset, offset);
      if (n === 0) return undefined;
      offset += n;
    }
    return { text: buf.toString("utf8"), dev: opened.dev, ino: opened.ino };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The fd is already gone; the read already refused.
      }
    }
  }
}

/**
 * Append through a freshly opened `O_APPEND|O_NOFOLLOW` descriptor,
 * validated before the write: a symlink at open time (ELOOP), a
 * non-regular file, a hardlink (`nlink !== 1` — a second name
 * could be smuggling the bytes elsewhere), or an identity other
 * than the file the block was prepared against all throw a
 * plain-words refusal. A lstat re-check cannot do this: the path
 * can change between the check and a path-based append (TOCTOU).
 */
export function safeAppendFile(file: string, block: string, expected: WritebackIdentity | undefined): void {
  const changed = "AGENTS.md changed during recording; refusing to write.";
  let fd: number | undefined;
  try {
    fd = openSync(file, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_NOFOLLOW);
  } catch {
    throw new Error(changed);
  }
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1) throw new Error(changed);
    if (expected !== undefined && (opened.dev !== expected.dev || opened.ino !== expected.ino)) {
      throw new Error(changed);
    }
    writeSync(fd, block);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The write already landed or threw; the close cannot change that.
      }
    }
  }
}

/**
 * True when the primary repo's `AGENTS.md` already holds the fenced
 * section. Any refusal (missing, symlink, oversize, unreadable)
 * reads as absent — the snapshot flag only shapes the preview, and
 * the append re-checks at write time.
 */
export function targetHasSection(repoRoot: string): boolean {
  const file = join(repoRoot, "AGENTS.md");
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_INSTRUCTIONS_BYTES) return false;
  const existing = readInstructions(file);
  return existing === undefined ? false : targetHasSectionText(existing.text);
}

/**
 * Append one run's human-authored lessons to `<repoRoot>/AGENTS.md`.
 * The caller re-validates run state; this module re-validates the
 * lesson lines (separator-split, trimmed, empties dropped,
 * count-capped — extras refused, never silently dropped) and the
 * target (missing,
 * symlink, non-regular, and oversize refusals, each in plain
 * words). Returns the ack payload.
 */
export function appendWriteback(
  repoRoot: string,
  run: Pick<RunRecord, "id" | "startedAt" | "endedAt" | "state">,
  lessons: readonly string[],
  now: number,
  fs: WritebackFs = { appendFile: safeAppendFile },
): WritebackResult {
  // Split before counting: one wire element can smuggle several
  // lines (LF, CR, U+2028/2029), each of which would land as its
  // own entry line — the cap counts landed lines, not elements.
  const lines = lessons.flatMap(splitLessonText).map((line) => line.trim()).filter((line) => line.length > 0);
  if (lines.length === 0) return refuse("No lessons to record — write at least one line.");
  if (lines.length > MAX_LESSONS_PER_RUN) {
    return refuse(`At most ${MAX_LESSONS_PER_RUN} lessons per run — nothing recorded.`);
  }
  try {
    const parent = lstatSync(repoRoot);
    if (parent.isSymbolicLink() || !parent.isDirectory()) {
      return refuse("The repo root is not a real directory; refusing to write.");
    }
  } catch {
    return refuse("The repo root is not reachable; refusing to write.");
  }
  const file = join(repoRoot, "AGENTS.md");
  let stat;
  try {
    stat = lstatSync(file);
  } catch {
    return refuse("No AGENTS.md at the repo root — create one to record lessons.");
  }
  if (stat.isSymbolicLink()) return refuse("AGENTS.md is a symlink; refusing to write.");
  if (!stat.isFile()) return refuse("AGENTS.md is not a regular file; refusing to write.");
  if (stat.size > MAX_INSTRUCTIONS_BYTES) {
    return refuse("AGENTS.md is over 256 KiB; refusing to write.");
  }
  const existing = readInstructions(file);
  if (existing === undefined) return refuse("Could not read AGENTS.md; nothing recorded.");
  const date = formatEntryDate(now);
  const entries = prepareLessonLines(lines).map((lesson) => buildLessonEntry(run, lesson, date));
  const block = buildAppendBlock(existing.text, entries);
  try {
    // The descriptor open re-validates (symlink, hardlink,
    // identity): nothing path-based can interleave a swap.
    fs.appendFile(file, block, { dev: existing.dev, ino: existing.ino });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    // A refusal from the guarded append speaks for itself; any
    // other failure is a write error naming the cause.
    if (why.includes("refusing to write")) return refuse(why.slice(0, 140));
    return refuse(`Could not write to AGENTS.md (${why.slice(0, 120)}); nothing recorded.`);
  }
  return ok(`Recorded ${lines.length} lesson(s) in AGENTS.md.`);
}
