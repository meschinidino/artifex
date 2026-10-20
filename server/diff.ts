/**
 * Footprint diff contents (DFR1): `git diff HEAD` for one listed
 * path — staged + unstaged, the FR1 baseline. Fixed argv, capped
 * hunks, secret masking left to the caller (it owns the masked
 * flag next to the file-content one). Every failure mode resolves
 * undefined: the inspector shows no Changes section, never an
 * error lamp and never a guessed empty.
 */
import { STATUS_TIMEOUT_LIVE_MS, spawnCapture } from "../watcher/gitstatus.ts";

/** Unified hunks, work-tree-relative paths forced like the status read. */
const DIFF_ARGV = ["git", "-c", "core.fsmonitor=", "-c", "core.untrackedCache=false", "diff", "HEAD", "-U3", "--"] as const;
const NUMSTAT_ARGV = ["git", "-c", "core.fsmonitor=", "-c", "core.untrackedCache=false", "diff", "HEAD", "--numstat", "--"] as const;

/** Hunk lines kept per file; past this the tail reads truncated. */
export const DIFF_HUNK_LINES = 120;

export type FileDiff = {
  added: number;
  removed: number;
  /** Unified hunks (git's own markers), capped at DIFF_HUNK_LINES. */
  hunks: string;
  truncated: boolean;
  /** Footed-added but no diff output: untracked-new, content lives in FILE. */
  untracked: boolean;
};

/** `added\tremoved\tpath` — binary reads `-\t-`, unparseable reads empty. */
function parseNumstat(text: string): { added: number; removed: number } {
  const first = text.split("\n", 1)[0] ?? "";
  const [a, r] = first.split("\t");
  const added = Number(a);
  const removed = Number(r);
  if (!Number.isInteger(added) || !Number.isInteger(removed)) return { added: 0, removed: 0 };
  return { added, removed };
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * Diff one label-root-relative path. `footedAdded` is the label's
 * verdict for the path (added vs anything else): only a footed-added
 * path with empty output reads as untracked-new.
 */
export async function readDiff(
  repoRoot: string,
  rel: string,
  footedAdded: boolean,
  timeoutMs: number = STATUS_TIMEOUT_LIVE_MS,
): Promise<FileDiff | undefined> {
  const [numstatOut, diffOut] = await Promise.all([
    spawnCapture([...NUMSTAT_ARGV, rel], repoRoot, timeoutMs),
    spawnCapture([...DIFF_ARGV, rel], repoRoot, timeoutMs),
  ]);
  if (!numstatOut || !diffOut) return undefined;
  const { added, removed } = parseNumstat(decode(numstatOut));
  const body = decode(diffOut);
  if (body.length === 0) {
    return { added, removed, hunks: "", truncated: false, untracked: footedAdded };
  }
  const lines = body.split("\n");
  // Diff header (`diff --git`, `index`, `---`/`+++`) is noise next
  // to the inspector's own path + counts; hunks carry the content.
  const out = stripFileHeaders(lines);
  if (out.length <= DIFF_HUNK_LINES) {
    return { added, removed, hunks: out.join("\n"), truncated: false, untracked: false };
  }
  return { added, removed, hunks: [...out.slice(0, DIFF_HUNK_LINES), "… truncated"].join("\n"), truncated: true, untracked: false };
}

/** Drop the `diff --git`/`index`/`---`/`+++` header, keep the hunks. */
function stripFileHeaders(lines: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.startsWith("diff --git ") || l.startsWith("index ")) continue;
    if (l.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      i++;
      continue;
    }
    out.push(l);
  }
  return out;
}
