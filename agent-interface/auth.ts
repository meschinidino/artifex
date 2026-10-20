/**
 * Agent-interface token bootstrap (D19): the per-launch token is
 * written to a 0600 file under the floor's `.artifex/` directory
 * (rotated each launch by overwrite) and kept out of git via a
 * `.gitignore` line. Same untrusted-repo discipline as the event
 * store: no writes through planted symlinks, failures report false
 * and the floor keeps serving either way.
 */
import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../server/store.ts";

export const AGENT_TOKEN_FILE = "agent-token";

/**
 * Write the launch token for agent bootstrap. Returns false (having
 * written nothing sensitive) when the state dir or token path is
 * unsafe or the write fails — callers warn and degrade.
 */
export function writeAgentToken(repoDir: string, token: string): boolean {
  try {
    const dir = join(repoDir, STATE_DIR);
    try {
      const dirStat = lstatSync(dir);
      if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return false;
    } catch { /* missing: created below */ }
    mkdirSync(dir, { recursive: true });
    // The token must never be committed: ensure the ignore line
    // before writing anything sensitive. An append follows symlinks,
    // so a planted .gitignore link refuses the whole operation.
    const ignoreFile = join(dir, ".gitignore");
    try {
      if (lstatSync(ignoreFile).isSymbolicLink()) return false;
    } catch { /* missing: created by the append */ }
    let ignored = false;
    try {
      ignored = readFileSync(ignoreFile, "utf8").split("\n").some((line) => line.trim() === AGENT_TOKEN_FILE);
    } catch { /* missing or unreadable: the append below decides */ }
    if (!ignored) {
      let prefix = "";
      try {
        const existing = readFileSync(ignoreFile, "utf8");
        if (existing.length > 0 && !existing.endsWith("\n")) prefix = "\n";
      } catch { /* missing: no prefix needed */ }
      appendFileSync(ignoreFile, `${prefix}${AGENT_TOKEN_FILE}\n`);
    }
    // Same symlink discipline for the token itself: a planted link
    // would redirect the secret outside the repo.
    const file = join(dir, AGENT_TOKEN_FILE);
    try {
      if (lstatSync(file).isSymbolicLink()) return false;
    } catch { /* missing: created by the write */ }
    writeFileSync(file, `${token}\n`);
    chmodSync(file, 0o600);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy-ready connect snippet for launch stdout. It references the
 * token file instead of embedding the token, so D19's "copy-ready"
 * and D18's "token never in URLs or logs" both hold. repoDir is
 * absolute (the server resolves it), so the snippet works from any
 * cwd. One snippet serves every agent with shell access — v1 has a
 * single dispatch adapter, and the interface is agent-agnostic.
 */
export function connectSnippet(repoDir: string, port: number): string {
  const tokenFile = join(repoDir, STATE_DIR, AGENT_TOKEN_FILE);
  const url = `http://127.0.0.1:${port}/agent`;
  return [
    `agent interface: POST ${url} (token: ${tokenFile})`,
    `TOKEN=$(cat ${tokenFile}); curl -s -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"method":"floor.listBuildings","params":{}}' ${url}`,
  ].join("\n");
}
