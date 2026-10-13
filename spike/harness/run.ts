/**
 * T1 spike harness: run one agent headless in a fresh scratch repo and record
 * (a) every stdout line with arrival time, (b) first-seen time per file via
 * 20 ms polling. The capture is the raw evidence for lead-time analysis.
 *
 * Usage: bun run spike/harness/run.ts <agent> [prompt-file]
 * Agents: muse | claude-code | codex | opencode | echo-smoke
 */
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const PROMPT =
  "Build a tiny TypeScript greeting library in this empty repo: a module that exports a greet(name: string): string function returning \"Hello, <name>!\", a public entry point that re-exports it, and a Bun test file with two tests for greet. Run the tests with bun test and fix any failures. Keep it minimal, no extra dependencies.";

/**
 * Real Claude Code binary. On this machine `Muse` on PATH is a Muse
 * shim, so resolve the newest native install under
 * ~/.local/share/claude/versions/ unless CLAUDE_BIN is set.
 */
function resolveClaudeBin(): string {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const dir = `${process.env.HOME}/.local/share/claude/versions`;
  try {
    const versions = readdirSync(dir)
      .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (versions.length > 0) return join(dir, versions[versions.length - 1]);
  } catch {
    // fall through
  }
  throw new Error("Claude Code binary not found; set CLAUDE_BIN to its path");
}
const CLAUDE_BIN = resolveClaudeBin();

function agentCommand(agent: string, scratch: string, prompt: string): { cmd: string; args: string[] } {
  switch (agent) {
    case "echo-smoke":
      return { cmd: "muse", args: ["exec", "--json", "--provider", "echo", "--workspace", scratch, prompt] };
    case "muse":
      return { cmd: "muse", args: ["exec", "--json", "--yolo", "--workspace", scratch, prompt] };
    case "claude-code":
      return {
        cmd: CLAUDE_BIN,
        args: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "bypassPermissions", prompt],
      };
    case "codex":
      return {
        cmd: "codex",
        args: ["exec", "--json", "-C", scratch, "--dangerously-bypass-approvals-and-sandbox", prompt],
      };
    case "claude-plan":
      return {
        cmd: CLAUDE_BIN,
        args: ["-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "plan", prompt],
      };
    case "opencode":
      return { cmd: "opencode", args: ["run", "--format", "json", "--auto", "--dir", scratch, prompt] };
    default:
      throw new Error(`unknown agent: ${agent}`);
  }
}

async function main() {
  const agent = process.argv[2];
  if (!agent) throw new Error("usage: run.ts <agent>");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const scratch = `/tmp/artifex-spike/runs/${agent}-${stamp}`;
  mkdirSync(scratch, { recursive: true });
  writeFileSync(join(scratch, "README.md"), "# scratch\n");
  const git = spawn("git", ["init", "-q", "-b", "main"], { cwd: scratch });
  await new Promise((r) => git.on("exit", r));
  const add = spawn("git", ["add", "-A"], { cwd: scratch });
  await new Promise((r) => add.on("exit", r));
  const commit = spawn("git", ["-c", "user.email=spike@artifex.local", "-c", "user.name=spike", "commit", "-qm", "init"], { cwd: scratch });
  await new Promise((r) => commit.on("exit", r));

  const prompt = process.env.SPIKE_PROMPT ?? PROMPT;
  const { cmd, args } = agentCommand(agent === "muse-elicited" ? "muse" : agent, scratch, prompt);
  const t0 = Date.now();
  const now = () => Date.now() - t0;
  const lines: { t: number; stream: string; line: string }[] = [];
  const files = new Map<string, { firstSeenMs: number; mtimeMs: number; size: number }>();

  const scanFiles = () => {
    const walk = (dir: string) => {
      let entries: string[] = [];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of entries) {
        if (name === ".git" || name === "node_modules") continue;
        const full = join(dir, name);
        let st;
        try {
          st = statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) walk(full);
        else {
          const rel = relative(scratch, full);
          const prev = files.get(rel);
          if (!prev || prev.mtimeMs !== st.mtimeMs || prev.size !== st.size) {
            files.set(rel, {
              firstSeenMs: prev ? prev.firstSeenMs : now(),
              mtimeMs: st.mtimeMs,
              size: st.size,
            });
          }
        }
      }
    };
    walk(scratch);
  };
  const poll = setInterval(scanFiles, 20);

  const child = spawn(cmd, args, {
    cwd: scratch,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  const collect = (buf: Buffer, stream: string, carry: { s: string }) => {
    carry.s += buf.toString("utf8");
    let idx;
    while ((idx = carry.s.indexOf("\n")) >= 0) {
      const line = carry.s.slice(0, idx);
      carry.s = carry.s.slice(idx + 1);
      if (line.length > 0) lines.push({ t: now(), stream, line });
    }
  };
  const outCarry = { s: "" };
  const errCarry = { s: "" };
  child.stdout.on("data", (b: Buffer) => collect(b, "stdout", outCarry));
  child.stderr.on("data", (b: Buffer) => collect(b, "stderr", errCarry));

  const timeoutMs = 420_000;
  const killer = setTimeout(() => {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }, timeoutMs);
  // "close" (not "exit"): fires only after stdio pipes have drained,
  // so trailing result events cannot be lost. The fallback timer is
  // cleared on close, otherwise it keeps the process alive ~7 minutes.
  const exitCode: number | null = await new Promise((r) => {
    const fallback = setTimeout(() => r(null), timeoutMs + 10_000);
    child.on("close", (c) => {
      clearTimeout(fallback);
      r(c);
    });
  });
  clearTimeout(killer);
  clearInterval(poll);
  scanFiles();
  if (outCarry.s.length > 0) lines.push({ t: now(), stream: "stdout", line: outCarry.s });
  if (errCarry.s.length > 0) lines.push({ t: now(), stream: "stderr", line: errCarry.s });

  const capture = {
    agent,
    cmd: [cmd, ...args].join(" "),
    prompt,
    scratch,
    startedAt: new Date(t0).toISOString(),
    durationMs: now(),
    exitCode,
    timedOut: exitCode === null || now() >= timeoutMs,
    lines,
    files: Object.fromEntries(files),
  };
  mkdirSync("spike/captures", { recursive: true });
  const out = `spike/captures/${agent}.json`;
  writeFileSync(out, JSON.stringify(capture, null, 2));
  console.log(`capture: ${out} lines=${lines.length} files=${files.size} exit=${exitCode} durationMs=${capture.durationMs}`);
}

await main();
