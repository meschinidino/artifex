/**
 * Zero-install preview exporter: boots the library server over a
 * repo on an ephemeral port, captures the served bundle, stylesheet,
 * and first snapshot over the existing public surfaces only (no
 * server changes, no new route, no auth bypass — the agent-comfort
 * precedent: this script is a client), and writes one
 * self-contained HTML file via preview/render.ts.
 *
 * Usage: bun run scripts/export-preview.ts --repo <dir> --out <file.html> [--force]
 * Exit 0 on success; 2 on arg refusal; 1 on any runtime failure,
 * naming the first failure (boot, fetch, snapshot, render, write).
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SnapshotMessage } from "../floor-ui/wire.ts";
import { renderPreview, type PreviewMeta } from "../preview/render.ts";
import { createFloorServer, type FloorServer } from "../server/index.ts";
import { authedClient, closeAllClients } from "../server/test-client.ts";

/** The artifex checkout root (this script lives in its scripts/). */
export const ARTIFEX_ROOT = join(import.meta.dir, "..");

export const EXPORT_PREVIEW_HELP = [
  "export-preview: write one self-contained artifex floor preview",
  "",
  "usage: bun run scripts/export-preview.ts --repo <dir> --out <file.html> [--force]",
  "",
  "  --repo <dir>    repo to map (must be a directory)",
  "  --out <file>    output path, must end in .html (parent dirs are",
  "                  created; refuses to overwrite without --force)",
  "  --force         overwrite an existing --out file",
  "  --help          print this help",
  "",
  "The preview embeds the frozen snapshot: zones, machines,",
  "belts, ghosts, removal marks, and the run ledger with agent",
  "notes (prompts, answers, and notes are secret-masked but may",
  "quote file text pasted into them). Served file contents and",
  "the launch token never travel. The page boots offline from",
  "file:// with no server and no WebSocket.",
].join("\n");

export type ExportPreviewArgs = { repo: string; out: string; force: boolean };

export type ParsedExportPreviewArgs =
  | { kind: "help" }
  | { kind: "error"; error: string }
  | { kind: "args"; args: ExportPreviewArgs };

export function parseExportPreviewArgs(argv: string[]): ParsedExportPreviewArgs {
  let repo: string | undefined;
  let out: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--help" || a === "-h") return { kind: "help" };
    if (a === "--force") {
      force = true;
      continue;
    }
    if (a === "--repo" || a === "--out") {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("-")) return { kind: "error", error: `export-preview: ${a} needs a value` };
      i++;
      if (a === "--repo") repo = v;
      else out = v;
      continue;
    }
    if (a.startsWith("-")) return { kind: "error", error: `export-preview: unknown flag: ${a}` };
    return { kind: "error", error: `export-preview: unexpected argument: ${a}` };
  }
  if (repo === undefined) return { kind: "error", error: "export-preview: missing required --repo <dir>" };
  let repoIsDir = false;
  try {
    repoIsDir = statSync(repo).isDirectory();
  } catch {
    repoIsDir = false;
  }
  if (!repoIsDir) return { kind: "error", error: `export-preview: repo is not a directory: ${repo}` };
  if (out === undefined) return { kind: "error", error: "export-preview: missing required --out <file.html>" };
  if (!out.endsWith(".html")) return { kind: "error", error: `export-preview: --out must end in .html: ${out}` };
  if (!force && existsSync(out)) {
    return { kind: "error", error: `export-preview: --out already exists (use --force to overwrite): ${out}` };
  }
  return { kind: "args", args: { repo, out, force } };
}

/** Short rev of the artifex checkout; "unknown" on any failure (best-effort). */
export function resolveArtifexRev(cwd: string = ARTIFEX_ROOT): string {
  try {
    const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) return "unknown";
    const rev = proc.stdout.toString().trim();
    return rev === "" ? "unknown" : rev;
  } catch {
    return "unknown";
  }
}

/** GET one served asset; throws naming the asset on any failure. */
export async function fetchAsset(baseUrl: string, path: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`);
  } catch (err) {
    throw new Error(`export-preview: fetch ${path} failed: ${errText(err)}`);
  }
  if (!res.ok) throw new Error(`export-preview: fetch ${path} failed: HTTP ${res.status}`);
  return await res.text();
}

/** Auth as any client and take the first snapshot; throws named on failure. */
export async function captureSnapshot(floor: FloorServer): Promise<SnapshotMessage> {
  try {
    const { snapshot } = await authedClient(floor);
    return snapshot;
  } catch (err) {
    throw new Error(`export-preview: snapshot failed: ${errText(err)}`);
  } finally {
    closeAllClients();
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type ExportPreviewResult = {
  path: string;
  bytes: number;
  buildings: number;
  belts: number;
  exportedAt: string;
};

export async function exportPreview(
  args: ExportPreviewArgs,
  opts: { uiDir?: string } = {},
): Promise<ExportPreviewResult> {
  const uiDir = opts.uiDir ?? join(ARTIFEX_ROOT, "floor-ui");
  let template: string;
  try {
    template = readFileSync(join(uiDir, "index.html"), "utf8");
  } catch {
    throw new Error(`export-preview: cannot read the floor-ui template in ${uiDir}`);
  }
  let floor: FloorServer;
  try {
    floor = await createFloorServer({ repo: args.repo, port: 0, agent: false });
  } catch (err) {
    throw new Error(`export-preview: boot failed for ${args.repo}: ${errText(err)}`);
  }
  try {
    const base = `http://127.0.0.1:${floor.port}`;
    const [appJs, css] = await Promise.all([fetchAsset(base, "/app.js"), fetchAsset(base, "/styles.css")]);
    const snapshot = await captureSnapshot(floor);
    const exportedAt = new Date().toISOString();
    const meta: PreviewMeta = {
      repo: snapshot.repo,
      exportedAt,
      artifexRev: resolveArtifexRev(),
      files: snapshot.buildings.length,
      belts: snapshot.belts.length,
    };
    let html: string;
    try {
      html = renderPreview({ template, css, appJs, snapshot, meta });
    } catch (err) {
      throw new Error(`export-preview: render failed: ${errText(err)}`);
    }
    try {
      mkdirSync(dirname(args.out), { recursive: true });
      // The parse-time exists check races a concurrent creator; the
      // open flag is the real gate (`wx` refuses the pre-existing
      // file even when it appeared after validation).
      writeFileSync(args.out, html, { flag: args.force ? "w" : "wx" });
    } catch (err) {
      throw new Error(`export-preview: write failed for ${args.out}: ${errText(err)}`);
    }
    return {
      path: args.out,
      bytes: Buffer.byteLength(html, "utf8"),
      buildings: meta.files,
      belts: meta.belts,
      exportedAt,
    };
  } finally {
    floor.stop();
  }
}

export async function runExportPreview(argv: string[]): Promise<number> {
  const parsed = parseExportPreviewArgs(argv);
  if (parsed.kind === "help") {
    console.log(EXPORT_PREVIEW_HELP);
    return 0;
  }
  if (parsed.kind === "error") {
    console.error(parsed.error);
    return 2;
  }
  try {
    const r = await exportPreview(parsed.args);
    console.log(
      `preview: wrote ${r.path} (${r.bytes} bytes, ${r.buildings} buildings, ${r.belts} belts, exported ${r.exportedAt})`,
    );
    return 0;
  } catch (err) {
    console.error(err instanceof Error ? err.message : `export-preview: ${String(err)}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await runExportPreview(process.argv.slice(2)));
}
