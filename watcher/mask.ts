/**
 * Content safety for file previews (T3a, issue #2): env files never
 * leave the server; secret-looking assignment values are masked with
 * a fixed token; binary detection per spec (NUL in first 8 KB or
 * invalid UTF-8).
 */

export const MASKED_TOKEN = "[masked]";

/**
 * Env-file classification is fail-closed by meaning, not by one exact
 * name: `.env`, `.env.*`, `*.env` (docker env_file convention), and
 * `.envrc` all carry environment secrets in the wild.
 *
 * Coverage boundary (review note): classification is by path name, so
 * a hardlink to an env file under an innocent name is served with
 * keyword masking only, not the full env block. Same-user local
 * attacker territory; documented, not fixed.
 */
export function isEnvFile(path: string): boolean {
  const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  return base === ".env" || base.startsWith(".env.") || base.endsWith(".env") || base === ".envrc";
}

// Spec rule (issue #2) extended to fail closed: the spec's env-style
// anchor also allows a declaration prefix (const/let/var/export) and
// a quoted key, so secrets declared in code are masked too. Capture
// the key as one token, then test it for a secret keyword: searching
// for the keyword inside the regex (two greedy token runs around it)
// backtracks quadratically on a long keyword-shaped line with no
// delimiter, and a `.*$` tail fails open on CRLF lines because `.`
// cannot match the trailing `\r`. The keyword match stays
// substring-based: over-masking is the safe error.
const SECRET_ASSIGNMENT =
  /^(\s*(?:export\s+)?(?:const\s+|let\s+|var\s+)?["']?([A-Za-z0-9_]+)["']?\s*[:=])/;
const SECRET_KEYWORD = /KEY|TOKEN|SECRET|PASSWORD/i;

/**
 * PEM blocks (certificates, private keys) are multi-line base64: no
 * single line matches the assignment rule below, so the whole block
 * is replaced before line masking runs (toaster T4/R7 probe: PEM
 * material passed through unmasked without this pass). The block
 * collapses to one masked token; headers never survive either,
 * because a header names the secret's kind.
 */
const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----.*?-----END [A-Z0-9 ]+-----/gs;

export function maskPemBlocks(text: string): { content: string; masked: boolean } {
  let masked = false;
  const content = text.replace(PEM_BLOCK, () => {
    masked = true;
    return MASKED_TOKEN;
  });
  return { content, masked };
}

/** Replace secret assignment values; report whether anything changed. */
export function maskContent(text: string): { content: string; masked: boolean } {
  const pem = maskPemBlocks(text);
  text = pem.content;
  let masked = pem.masked;
  // A formatter may wrap the value onto the next line
  // (`const API_KEY =\n  "sk-…"`): mask that quoted line too.
  let maskNextQuoted = false;
  const lines = text.split("\n").map((line) => {
    const cr = line.endsWith("\r");
    const bare = cr ? line.slice(0, -1) : line;
    if (maskNextQuoted) {
      const trimmed = bare.trimStart();
      if (trimmed.length === 0) return line;
      maskNextQuoted = false;
      if (trimmed.startsWith('"') || trimmed.startsWith("'") || trimmed.startsWith("`")) {
        masked = true;
        const indent = bare.slice(0, bare.length - trimmed.length);
        return `${indent}${MASKED_TOKEN}${cr ? "\r" : ""}`;
      }
    }
    const m = SECRET_ASSIGNMENT.exec(bare);
    if (!m || !SECRET_KEYWORD.test(m[2]!)) return line;
    masked = true;
    maskNextQuoted = bare.slice(m[1].length).trim().length === 0;
    return `${m[1]} ${MASKED_TOKEN}${cr ? "\r" : ""}`;
  });
  return { content: lines.join("\n"), masked };
}

/** Binary = NUL byte in the first 8 KB, or content is not valid UTF-8. */
export function isBinaryBuffer(buf: Uint8Array): boolean {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

/**
 * Decode a byte-capped prefix of a larger text file. A multibyte
 * character cut by the cap is dropped instead of making the whole
 * prefix look binary; NUL in the first 8 KB or any other invalid
 * UTF-8 still returns undefined (binary).
 */
export function decodeUtf8Prefix(buf: Uint8Array): string | undefined {
  if (buf.subarray(0, 8192).includes(0)) return undefined;
  let end = buf.length;
  // Find a trailing UTF-8 lead byte whose sequence is cut short.
  for (let i = Math.max(0, end - 4); i < end; i++) {
    const b = buf[i]!;
    const need = b >= 0xf0 && b <= 0xf4 ? 4 : b >= 0xe0 && b <= 0xef ? 3 : b >= 0xc2 && b <= 0xdf ? 2 : 0;
    if (need > 0 && i + need > end) {
      end = i;
      break;
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf.subarray(0, end));
  } catch {
    return undefined;
  }
}

/** Line count for banding; binary files count as 0 lines. */
export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return text.endsWith("\n") ? n : n + 1;
}
