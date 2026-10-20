/**
 * Slice: footprint diff contents. Real git fixtures: hunk shaping,
 * counts, untracked-new, clean, non-git, and the line cap — plus a
 * WS round trip proving the get-diff/diff contract.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMessage } from "../floor-ui/wire.ts";
import { createFloorServer, type FloorServer } from "./index.ts";
import { authedClient, closeAllClients } from "./test-client.ts";
import { DIFF_HUNK_LINES, readDiff } from "./diff.ts";

const git = (cwd: string, ...args: string[]): void => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim().slice(0, 200)}`);
};

const commitAll = (repo: string, msg: string): void => {
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git(repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg);
};

describe("readDiff", () => {
  // Value: protects=hunk shaping (headers stripped, @@ hunks kept)
  // plus numstat counts; fails_when=the parse drifts (counts lie
  // or headers pollute the inspector).
  test("a modified file returns counts and bare hunks", async () => {
    if (!Bun.which("git")) return;
    const repo = mkdtempSync(join(tmpdir(), "artifex-diff-mod-"));
    try {
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\nexport const b = 1;\n");
      git(repo, "init", "-b", "main");
      commitAll(repo, "base");
      writeFileSync(join(repo, "a.ts"), "export const a = 2;\nexport const b = 1;\nexport const c = 3;\n");
      const d = await readDiff(repo, "a.ts", false);
      expect(d).toBeDefined();
      expect(d!.added).toBe(2);
      expect(d!.removed).toBe(1);
      expect(d!.truncated).toBe(false);
      expect(d!.untracked).toBe(false);
      expect(d!.hunks).toContain("@@");
      expect(d!.hunks).toContain("-export const a = 1;");
      expect(d!.hunks).toContain("+export const a = 2;");
      expect(d!.hunks).not.toContain("diff --git");
      expect(d!.hunks).not.toContain("+++");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  // Value: protects=untracked-new reading (footed-added with empty
  // output flags untracked instead of a fake empty); fails_when=
  // the flag drops (new files show a blank Changes section).
  test("an untracked file flags untracked only when footed-added", async () => {
    if (!Bun.which("git")) return;
    const repo = mkdtempSync(join(tmpdir(), "artifex-diff-new-"));
    try {
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
      git(repo, "init", "-b", "main");
      commitAll(repo, "base");
      writeFileSync(join(repo, "fresh.ts"), "export const f = 1;\n");
      const flagged = await readDiff(repo, "fresh.ts", true);
      expect(flagged).toEqual({ added: 0, removed: 0, hunks: "", truncated: false, untracked: true });
      const plain = await readDiff(repo, "fresh.ts", false);
      expect(plain?.untracked).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);

  // Value: protects=clean reads empty (no hunks, no flags) and
  // non-git roots resolving undefined (no Changes section, never
  // an error); fails_when=empty diffs grow flags or the spawn
  // throws outside a work tree.
  test("clean files read empty; non-git roots resolve undefined", async () => {
    if (!Bun.which("git")) return;
    const repo = mkdtempSync(join(tmpdir(), "artifex-diff-clean-"));
    const plain = mkdtempSync(join(tmpdir(), "artifex-diff-plain-"));
    try {
      writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
      git(repo, "init", "-b", "main");
      commitAll(repo, "base");
      expect(await readDiff(repo, "a.ts", false)).toEqual({
        added: 0,
        removed: 0,
        hunks: "",
        truncated: false,
        untracked: false,
      });
      expect(await readDiff(plain, "a.ts", false)).toBeUndefined();
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(plain, { recursive: true, force: true });
    }
  }, 30_000);

  // Value: protects=the hunk cap (120 lines + visible tail);
  // fails_when=the cap drops (a huge diff floods the socket) or
  // the tail hides (truncation is silent).
  test("hunks cap at 120 lines with a visible tail", async () => {
    if (!Bun.which("git")) return;
    const repo = mkdtempSync(join(tmpdir(), "artifex-diff-cap-"));
    try {
      writeFileSync(join(repo, "big.txt"), "base\n");
      git(repo, "init", "-b", "main");
      commitAll(repo, "base");
      writeFileSync(join(repo, "big.txt"), Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n") + "\n");
      const d = await readDiff(repo, "big.txt", false);
      expect(d!.truncated).toBe(true);
      expect(d!.hunks.split("\n")).toHaveLength(DIFF_HUNK_LINES + 1);
      expect(d!.hunks.endsWith("… truncated")).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("get-diff round trip", () => {
  let floor: FloorServer | undefined;
  let repo: string | undefined;
  const extraRepos: string[] = [];
  afterEach(async () => {
    closeAllClients();
    await floor?.stop();
    floor = undefined;
    for (const r of [repo, ...extraRepos]) if (r) rmSync(r, { recursive: true, force: true });
    repo = undefined;
    extraRepos.length = 0;
  });

  // Value: protects=the WS contract (get-diff validates like
  // open-file and answers masked hunks); fails_when=the case,
  // the label root, or the message shape drifts.
  test("a modified file answers hunks over the socket", async () => {
    if (!Bun.which("git")) return;
    repo = mkdtempSync(join(tmpdir(), "artifex-diff-ws-"));
    writeFileSync(join(repo, "a.ts"), "export const a = 1;\n");
    git(repo, "init", "-b", "main");
    commitAll(repo, "base");
    writeFileSync(join(repo, "a.ts"), "export const a = 2;\n");
    floor = await createFloorServer({ repo: repo!, port: 0 });
    const { client } = await authedClient(floor);
    const mark = client.messages.length;
    client.send({ v: 1, type: "get-diff", path: "a.ts" });
    const diff = (await client.waitFor((m) => m.type === "diff", "diff message", 10_000, mark)) as Extract<
      ServerMessage,
      { type: "diff" }
    >;
    expect(diff.path).toBe("a.ts");
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toContain("+export const a = 2;");
    expect(diff.untracked).toBe(false);
  }, 30_000);
});
