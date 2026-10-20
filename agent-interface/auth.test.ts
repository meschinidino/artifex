import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_TOKEN_FILE, connectSnippet, writeAgentToken } from "./auth.ts";

let dir: string | undefined;

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

function fresh(): string {
  dir = mkdtempSync(join(tmpdir(), "artifex-agent-auth-"));
  return dir;
}

describe("writeAgentToken", () => {
  test("writes the token 0600 and ignores it, creating the state dir", () => {
    // Value: protects=D19 bootstrap file; fails_when=mode/content/gitignore drift
    const repo = fresh();
    expect(writeAgentToken(repo, "tok-1")).toBe(true);
    const file = join(repo, ".artifex", AGENT_TOKEN_FILE);
    expect(readFileSync(file, "utf8")).toBe("tok-1\n");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(repo, ".artifex", ".gitignore"), "utf8")).toBe("agent-token\n");
  });

  test("rotation overwrites the previous launch token and keeps 0600", () => {
    // Value: protects=per-launch rotation; fails_when=stale tokens survive a reboot
    const repo = fresh();
    expect(writeAgentToken(repo, "tok-1")).toBe(true);
    expect(writeAgentToken(repo, "tok-2")).toBe(true);
    const file = join(repo, ".artifex", AGENT_TOKEN_FILE);
    expect(readFileSync(file, "utf8")).toBe("tok-2\n");
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(repo, ".artifex", ".gitignore"), "utf8")).toBe("agent-token\n");
  });

  test("preserves existing gitignore lines and unterminated tails", () => {
    // Value: protects=user's .artifex/.gitignore; fails_when=bootstrap clobbers or glues lines
    const repo = fresh();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    writeFileSync(join(repo, ".artifex", ".gitignore"), "*.tmp");
    expect(writeAgentToken(repo, "tok")).toBe(true);
    expect(readFileSync(join(repo, ".artifex", ".gitignore"), "utf8")).toBe("*.tmp\nagent-token\n");
  });

  test("planted symlinks refuse the write without leaking the token", () => {
    // Value: protects=token from symlink redirection outside the repo; fails_when=write follows a planted link
    const repo = fresh();
    const outside = join(repo, "outside.txt");
    // Planted token link.
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    symlinkSync(outside, join(repo, ".artifex", AGENT_TOKEN_FILE));
    expect(writeAgentToken(repo, "secret-1")).toBe(false);
    expect(() => readFileSync(outside, "utf8")).toThrow();
    rmSync(join(repo, ".artifex", AGENT_TOKEN_FILE));
    // Planted state-dir link.
    const repo2 = mkdtempSync(join(tmpdir(), "artifex-agent-auth-"));
    try {
      const target = join(repo2, "realdir");
      mkdirSync(target, { recursive: true });
      symlinkSync(target, join(repo2, ".artifex"));
      expect(writeAgentToken(repo2, "secret-2")).toBe(false);
      expect(() => readFileSync(join(target, AGENT_TOKEN_FILE), "utf8")).toThrow();
    } finally {
      rmSync(repo2, { recursive: true, force: true });
    }
    // Planted .gitignore link (the earlier refusal left a real one).
    rmSync(join(repo, ".artifex", ".gitignore"));
    symlinkSync(outside, join(repo, ".artifex", ".gitignore"));
    expect(writeAgentToken(repo, "secret-3")).toBe(false);
    expect(() => readFileSync(outside, "utf8")).toThrow();
  });

  test("blocked state dir fails closed without throwing", () => {
    // Value: protects=degraded boot when .artifex is unusable; fails_when=the write throws instead of reporting false
    const repo = fresh();
    writeFileSync(join(repo, ".artifex"), "not a dir");
    expect(writeAgentToken(repo, "tok")).toBe(false);
  });
});

describe("connectSnippet", () => {
  test("names the endpoint and token file but never the token", () => {
    // Value: protects=D18 token secrecy on stdout; fails_when=the literal token is printed
    const snippet = connectSnippet("/repo/root", 4517);
    expect(snippet).toContain("POST http://127.0.0.1:4517/agent");
    expect(snippet).toContain("/repo/root/.artifex/agent-token");
    expect(snippet).toContain("floor.listBuildings");
    expect(snippet).not.toContain("tok-");
  });
});
