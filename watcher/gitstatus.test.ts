/**
 * Footprint status source: the FR1 XY table, rename NUL pairs,
 * collapsed untracked dirs, spawn failure modes, and the argv
 * hardening. Pure-table tests pin the verdict contract; spawn
 * tests run the real binary (or a real sleep) — nothing mocked.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  GIT_STATUS_ARGV,
  hasLocalFilterConfig,
  parsePorcelainZ,
  readGitStatus,
  resolveGitdir,
  spawnCapture,
  verdictForXY,
} from "./gitstatus.ts";

const buf = (s: string): Uint8Array => new TextEncoder().encode(s);
const parse = (s: string, members?: ReadonlySet<string>, exists?: (p: string) => boolean): [string, string][] =>
  [...parsePorcelainZ(buf(s), { exists: exists ?? (() => true), ...(members ? { members } : {}) })].map(
    ([p, v]) => [p, v] as [string, string],
  );

describe("verdictForXY (FR1 table)", () => {
  // Value: protects=untracked/staged-new read as added while AD
  // (staged-then-deleted) nets to zero vs HEAD; fails_when=the A
  // column handling drifts (AD footprints a file identical to HEAD).
  test("untracked and staged-new are added; AD is net zero", () => {
    expect(verdictForXY("?", "?", true)).toBe("added");
    expect(verdictForXY("A", " ", true)).toBe("added");
    expect(verdictForXY("A", "M", true)).toBe("added");
    expect(verdictForXY("A", "D", false)).toBe("none");
  });

  // Value: protects=both delete halves read as removed; fails_when=a
  // D rule drops (deleted files lose their GONE marker and count).
  test("worktree and index deletes are removed", () => {
    expect(verdictForXY(" ", "D", false)).toBe("removed");
    expect(verdictForXY("M", "D", false)).toBe("removed");
    expect(verdictForXY("D", " ", false)).toBe("removed");
  });

  // Value: protects=rename/copy continuity (modified on the new
  // path, nothing on the old); fails_when=R/C falls through to
  // none (renames lose their footprint) or to removed (a rename
  // draws a bogus GONE marker).
  test("renames and copies are modified", () => {
    expect(verdictForXY("R", " ", true)).toBe("modified");
    expect(verdictForXY(" ", "R", true)).toBe("modified");
    expect(verdictForXY("C", " ", true)).toBe("modified");
    expect(verdictForXY("R", "M", true)).toBe("modified");
  });

  // Value: protects=conflict triage by disk truth (present file =
  // modified, absent file = removed); fails_when=unmerged codes
  // fall through to the A/D prefix rules (AA reads as added) or to
  // none (conflicts vanish from the floor).
  test("unmerged codes follow disk existence, including AA and DD", () => {
    for (const [x, y] of [["U", "U"], ["A", "U"], ["U", "A"], ["D", "U"], ["U", "D"], ["A", "A"], ["D", "D"]] as const) {
      expect(verdictForXY(x, y, true)).toBe("modified");
      expect(verdictForXY(x, y, false)).toBe("removed");
    }
  });

  // Value: protects=content/type edits in either column read as
  // modified; fails_when=a column is ignored (staged fixes lose
  // their footprint after `git add`).
  test("modify and typechange in either column are modified", () => {
    expect(verdictForXY(" ", "M", true)).toBe("modified");
    expect(verdictForXY("M", " ", true)).toBe("modified");
    expect(verdictForXY("M", "M", true)).toBe("modified");
    expect(verdictForXY(" ", "T", true)).toBe("modified");
    expect(verdictForXY("T", " ", true)).toBe("modified");
  });

  // Value: protects=fail-closed on ignored/unknown codes (no
  // treatment for what git cannot classify); fails_when=an unknown
  // code defaults to modified (porcelain drift footprints the
  // world) or throws (one odd entry kills the whole status read).
  test("ignored and unknown codes are none", () => {
    expect(verdictForXY("!", "!", true)).toBe("none");
    expect(verdictForXY("X", "?", true)).toBe("none");
    expect(verdictForXY(" ", " ", true)).toBe("none");
  });
});

describe("parsePorcelainZ", () => {
  // Value: protects=multi-entry parsing incl. staged/unstaged
  // mixes; fails_when=record splitting drifts (entries merge or
  // the trailing NUL yields a phantom path).
  test("mixed entries parse independently", () => {
    expect(parse("?? new.txt\0 M mod.ts\0M  staged.ts\0")).toEqual([
      ["new.txt", "added"],
      ["mod.ts", "modified"],
      ["staged.ts", "modified"],
    ]);
  });

  // Value: protects=rename NUL-pair consumption (the old path must
  // not parse as its own record, and the entry after the pair must
  // still parse); fails_when=pair handling drops (the old path
  // becomes a phantom `??`-less record or swallows its neighbor).
  test("rename entries consume the old-path field and stamp the new path", () => {
    expect(parse("R  new.ts\0old.ts\0 M after.ts\0")).toEqual([
      ["new.ts", "modified"],
      ["after.ts", "modified"],
    ]);
    // A bare path field without XY prefix is never a record, even
    // when a rename pair is truncated at the buffer end.
    expect(parse("R  lone.ts\0")).toEqual([["lone.ts", "modified"]]);
  });

  // Value: protects=collapsed untracked dirs expanding to listed
  // members (a new directory footprints its files); fails_when=the
  // prefix match drifts (siblings outside the dir get stamped) or
  // expansion without members guesses (unstamped is the honest
  // answer when no listing is available).
  test("collapsed untracked dirs expand against members only", () => {
    const members = new Set(["new/a.ts", "new/b.ts", "other.ts"]);
    expect(parse("?? new/\0", members)).toEqual([
      ["new/a.ts", "added"],
      ["new/b.ts", "added"],
    ]);
    expect(parse("?? new/\0")).toEqual([]);
  });

  // Value: protects=unmerged triage through the exists probe (the
  // probe fires for conflicts, never for plain codes);
  // fails_when=the probe is skipped (conflicts misread) or fires
  // per entry (a status read stats the whole tree).
  test("unmerged entries consult exists; plain codes never stat", () => {
    const probed: string[] = [];
    const exists = (p: string): boolean => {
      probed.push(p);
      return p === "kept.ts";
    };
    expect(parse("UU kept.ts\0UU gone.ts\0 M plain.ts\0", undefined, exists)).toEqual([
      ["kept.ts", "modified"],
      ["gone.ts", "removed"],
      ["plain.ts", "modified"],
    ]);
    expect(probed.sort()).toEqual(["gone.ts", "kept.ts"]);
  });

  // Value: protects=malformed records failing closed (short
  // records, missing XY/path separator, empty paths are skipped);
  // fails_when=the parser throws (status output is untrusted repo
  // content; one crafted byte must not kill the read).
  test("malformed records are skipped, never thrown on", () => {
    expect(parse("x\0no-separator-here\0AB\0?? \0?? ok.ts\0")).toEqual([["ok.ts", "added"]]);
    expect(parse("")).toEqual([]);
  });
});

describe("resolveGitdir", () => {
  // Value: protects=plain-repo gitdir resolution plus the linked-
  // worktree `gitdir:` pointer (relative and absolute); fails_when=
  // worktree floors lose their index/HEAD watches.
  test("directory, file pointer, and unresolvable shapes", () => {
    const root = mkdtempSync(join(tmpdir(), "artifex-gitdir-"));
    try {
      expect(resolveGitdir(join(root, "missing"))).toBeUndefined();
      const repo = join(root, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
      expect(resolveGitdir(repo)).toBe(join(repo, ".git"));
      // A .git FILE with a relative pointer (linked worktree shape).
      const wt = join(root, "wt");
      mkdirSync(wt, { recursive: true });
      writeFileSync(join(wt, ".git"), "gitdir: ../repo/.git\n");
      expect(resolveGitdir(wt)).toBe(join(repo, ".git"));
      writeFileSync(join(wt, ".git"), `gitdir: ${join(repo, ".git")}\n`);
      expect(resolveGitdir(wt)).toBe(join(repo, ".git"));
      // Garbage pointer, empty pointer, dangling pointer, and a
      // non-file non-dir .git all stay unresolvable (never throw).
      writeFileSync(join(wt, ".git"), "not a pointer\n");
      expect(resolveGitdir(wt)).toBeUndefined();
      writeFileSync(join(wt, ".git"), "gitdir: \n");
      expect(resolveGitdir(wt)).toBeUndefined();
      writeFileSync(join(wt, ".git"), "gitdir: ../nowhere\n");
      expect(resolveGitdir(wt)).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("spawnCapture", () => {
  // Value: protects=the timeout killing a hung git (a wedged
  // status read must resolve unavailable, never hang the server);
  // fails_when=the watchdog drops (status awaits forever).
  test("a hung process resolves undefined at the deadline", async () => {
    const start = Date.now();
    expect(await spawnCapture(["sleep", "30"], tmpdir(), 50)).toBeUndefined();
    expect(Date.now() - start).toBeLessThan(10_000);
  });

  // Value: protects=non-zero exit and unspawnable binaries
  // resolving unavailable (plain `git` failure, git missing from
  // PATH); fails_when=either throws (the status trigger crashes
  // the watcher callback) or resolves bytes (failure misread).
  test("non-zero exit and missing binaries resolve undefined", async () => {
    expect(await spawnCapture(["sh", "-c", "exit 3"], tmpdir(), 5_000)).toBeUndefined();
    expect(await spawnCapture(["artifex-definitely-not-a-binary"], tmpdir(), 5_000)).toBeUndefined();
  });

  // Value: protects=stdout bytes surviving intact (the parser's
  // input, NULs included); fails_when=capture decodes or trims
  // (porcelain records corrupt).
  test("successful runs resolve raw stdout bytes", async () => {
    const out = await spawnCapture(["sh", "-c", "printf 'a\\0b'"], tmpdir(), 5_000);
    expect(out).toEqual(new Uint8Array([0x61, 0x00, 0x62]));
  });
});

describe("git status argv + readGitStatus", () => {
  // Value: protects=the read-only hardened argv (porcelain v1 -z,
  // normal untracked, fsmonitor/untrackedCache neutralized);
  // fails_when=a flag drops (C-quoting returns, or the repo's own
  // config runs helpers during a read-only status).
  test("argv carries porcelain, -z, untracked mode, and config hardening", () => {
    expect([...GIT_STATUS_ARGV]).toEqual([
      "git",
      "-c",
      "core.fsmonitor=",
      "-c",
      "core.untrackedCache=false",
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=normal",
    ]);
  });

  const git = (cwd: string, ...args: string[]): void => {
    const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) {
      throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim().slice(0, 200)}`);
    }
  };

  // Value: protects=end-to-end status over a real repo (added,
  // modified, removed verdicts from live git output) plus the
  // hard-exclude filter (a modified file under node_modules can
  // never carry a verdict); fails_when=the spawn/parse/filter
  // chain drifts from real git behavior.
  test("real repo reads verdicts; excluded paths are dropped", async () => {
    if (!Bun.which("git")) return; // CI always has git; a bare box degrades honestly
    const repo = mkdtempSync(join(tmpdir(), "artifex-gitstatus-"));
    try {
      mkdirSync(join(repo, "node_modules", "lib"), { recursive: true });
      writeFileSync(join(repo, "keep.ts"), "export const k = 1;\n");
      writeFileSync(join(repo, "edit.ts"), "export const e = 1;\n");
      writeFileSync(join(repo, "drop.ts"), "export const d = 1;\n");
      writeFileSync(join(repo, "node_modules", "lib", "x.js"), "module.exports = 1;\n");
      git(repo, "init", "-b", "main");
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base");
      writeFileSync(join(repo, "edit.ts"), "export const e = 2;\n");
      writeFileSync(join(repo, "node_modules", "lib", "x.js"), "module.exports = 2;\n");
      writeFileSync(join(repo, "fresh.ts"), "export const f = 1;\n");
      rmSync(join(repo, "drop.ts"));
      const status = await readGitStatus(repo);
      expect(status).toBeDefined();
      expect([...status!]).toEqual([
        ["drop.ts", "removed"],
        ["edit.ts", "modified"],
        ["fresh.ts", "added"],
      ]);
      // A non-repo directory is unavailable, not clean.
      const bare = mkdtempSync(join(tmpdir(), "artifex-nogit-"));
      try {
        expect(await readGitStatus(bare)).toBeUndefined();
      } finally {
        rmSync(bare, { recursive: true, force: true });
      }
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  // Value: protects=the filter-driver RCE guard (a planted
  // filter.<name>.clean driver makes status unavailable instead
  // of executing during the status re-hash); fails_when=the
  // probe drops (merely viewing a repo runs its clean driver —
  // the sentinel file appears).
  test("a repo-local filter driver makes status unavailable without running it", async () => {
    if (!Bun.which("git")) return;
    const repo = mkdtempSync(join(tmpdir(), "artifex-gitfilter-"));
    const sentinel = join(repo, "driver-ran.txt");
    try {
      writeFileSync(join(repo, "data.dat"), "payload\n");
      git(repo, "init", "-b", "main");
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
      git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", "base");
      expect(await hasLocalFilterConfig(repo, 5_000)).toBe(false);
      // Plant the driver the way a hostile repo would: attributes
      // name it, local config defines it (repo-controlled scope).
      writeFileSync(join(repo, ".gitattributes"), "*.dat filter=evil\n");
      git(repo, "config", "--local", "filter.evil.clean", `touch ${sentinel}`);
      expect(await hasLocalFilterConfig(repo, 5_000)).toBe(true);
      // Dirty the file so a status run would re-hash it (and run
      // the driver without the probe).
      writeFileSync(join(repo, "data.dat"), "payload v2\n");
      expect(await readGitStatus(repo)).toBeUndefined();
      expect(() => statSync(sentinel)).toThrow();
      // Unsetting the driver restores status (never cached as unsafe).
      git(repo, "config", "--local", "--unset", "filter.evil.clean");
      rmSync(join(repo, ".gitattributes"));
      const status = await readGitStatus(repo);
      expect(status?.get("data.dat")).toBe("modified");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  // Value: protects=git-missing degradation (empty PATH: git
  // unspawnable resolves unavailable); fails_when=the spawn
  // throws instead (status failure crashes the trigger).
  test("git missing from PATH resolves unavailable", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-nogitbin-"));
    const saved = process.env.PATH;
    try {
      process.env.PATH = repo; // no git binary on this PATH
      expect(await readGitStatus(repo)).toBeUndefined();
    } finally {
      process.env.PATH = saved;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
