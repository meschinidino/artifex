#!/usr/bin/env bun
/**
 * Toaster pre-publish check (T4): before any push or share, prove
 * no ARCA key material lives in the repo. Scans tracked files
 * (git ls-files) for PEM private keys and certificates, and
 * refuses if the creds dir sits inside the repo. Prints paths
 * only — never matched content. Exit 1 on any hit.
 *
 * Run: bun run scripts/toaster-prepublish.ts
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { credsDir, scanForKeyMaterial } from "../agent-interface/toaster-creds.ts";

const repo = resolve(import.meta.dir, "..");
const dir = credsDir();
if (dir === repo || dir.startsWith(`${repo}/`)) {
  console.error(`FAIL: creds dir is inside the repo (${dir})`);
  process.exit(1);
}

const listed = execFileSync("git", ["ls-files", "-z"], { cwd: repo }).toString().split("\0").filter(Boolean);
const files: { path: string; content: string }[] = [];
for (const path of listed) {
  try {
    const buf = readFileSync(resolve(repo, path));
    if (buf.includes(0)) continue; // binary: cannot hold a PEM block
    files.push({ path, content: buf.toString("utf8") });
  } catch {
    // Tracked but unreadable (deleted in worktree): nothing to leak.
  }
}

const hits = scanForKeyMaterial(files);
if (hits.length > 0) {
  for (const h of hits) console.error(`FAIL: ${h.kind} material in tracked file ${h.path}`);
  process.exit(1);
}
console.log(`pre-publish OK: ${files.length} tracked files scanned, no key material; creds dir outside repo.`);
