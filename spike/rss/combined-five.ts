/**
 * D14 combined baseline: measure the five Artifex-owned units as five
 * separate Bun processes (4 empty + 1 parser) and sum their actual RSS
 * via `ps`, at grammar-loaded idle and after a full corpus parse.
 * The orchestrating parent process is excluded from the sum.
 *
 * Usage: bun run spike/rss/combined-five.ts
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.ARTIFEX_CORPUS_DIR ?? "/tmp/artifex-spike/corpus1000";

async function parserChild() {
  if (!existsSync(root)) {
    console.error(`error: corpus not found at ${root}; run bun run spike/rss/gen-corpus.ts first`);
    process.exit(1);
  }
  const { default: Parser } = await import("web-tree-sitter");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|py)$/.test(name)) files.push(full);
    }
  };
  walk(root);
  await Parser.init();
  const tsLang = await Parser.Language.load(
    Bun.resolveSync("tree-sitter-wasms/out/tree-sitter-typescript.wasm", import.meta.dir),
  );
  const pyLang = await Parser.Language.load(
    Bun.resolveSync("tree-sitter-wasms/out/tree-sitter-python.wasm", import.meta.dir),
  );
  console.log("GRAMMARS_READY");
  // Hold at a genuine idle point until the parent has sampled RSS.
  await new Promise<void>((resolve) => process.stdin.once("data", () => resolve()));
  const parser = new Parser();
  for (const f of files) {
    parser.setLanguage(f.endsWith(".py") ? pyLang : tsLang);
    const tree = parser.parse(readFileSync(f, "utf8"));
    tree?.delete();
  }
  console.log(`PARSED ${files.length}`);
  await Bun.sleep(60_000);
}

function totalRssMiB(pids: number[]): { each: number[]; total: number } {
  const out = spawnSync("ps", ["-o", "rss=", "-p", pids.join(",")], { encoding: "utf8" });
  const each = out.stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((kb) => Number(kb) / 1024);
  return { each, total: each.reduce((a, b) => a + b, 0) };
}

async function parent() {
  const children: ChildProcess[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      children.push(spawn("bun", ["-e", "await Bun.sleep(60000)"], { stdio: "ignore" }));
    }
    await Bun.sleep(1_000);
    const parser = spawn("bun", ["run", fileURLToPath(import.meta.url), "parser-child"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    children.push(parser);
    const pids = children.map((c) => c.pid as number);

    let buffer = "";
    const waiters = new Map<string, () => void>();
    const waitFor = (marker: string) =>
      buffer.includes(marker)
        ? Promise.resolve()
        : new Promise<void>((resolve, reject) => {
            waiters.set(marker, resolve);
            setTimeout(() => reject(new Error(`timeout waiting for ${marker}; got: ${buffer}`)), 60_000);
          });
    parser.stdout?.on("data", (d: Buffer) => {
      buffer += d.toString();
      for (const [marker, resolve] of [...waiters]) {
        if (buffer.includes(marker)) {
          waiters.delete(marker);
          resolve();
        }
      }
    });
    let parserErr = "";
    parser.stderr?.on("data", (d: Buffer) => (parserErr += d.toString()));

    await waitFor("GRAMMARS_READY");
    const idle = totalRssMiB(pids);
    console.log(`grammars-loaded idle (synchronized): each_mib=[${idle.each.map((v) => v.toFixed(1)).join(", ")}] total_mib=${idle.total.toFixed(1)}`);
    parser.stdin?.write("START_PARSE\n");
    parser.stdin?.end();

    await waitFor("PARSED");
    await Bun.sleep(250);
    const after = totalRssMiB(pids);
    console.log(`after full parse:    each_mib=[${after.each.map((v) => v.toFixed(1)).join(", ")}] total_mib=${after.total.toFixed(1)}`);
    if (parserErr.trim()) console.error(`parser stderr: ${parserErr.trim()}`);
  } finally {
    for (const c of children) c.kill("SIGKILL");
  }
}

try {
  if (process.argv[2] === "parser-child") await parserChild();
  else await parent();
} catch (e) {
  console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
