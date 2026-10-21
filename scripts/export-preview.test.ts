import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "../server/index.ts";
import {
  EXPORT_PREVIEW_HELP,
  captureSnapshot,
  exportPreview,
  fetchAsset,
  parseExportPreviewArgs,
  resolveArtifexRev,
  runExportPreview,
} from "./export-preview.ts";

const MINI_FLOOR = join(import.meta.dir, "..", "e2e", "fixtures", "mini-floor");

function copyMiniFloor(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-preview-"));
  cpSync(MINI_FLOOR, dir, { recursive: true });
  return dir;
}

function tinyRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-preview-tiny-"));
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  return dir;
}

/** Capture console output around an in-process CLI run. */
async function capture(run: () => Promise<number>): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => void out.push(a.join(" "));
  console.error = (...a: unknown[]) => void err.push(a.join(" "));
  try {
    const code = await run();
    return { code, out, err };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

describe("parseExportPreviewArgs", () => {
  test("accepts --repo/--out, --force, and --help", () => {
    // Value: protects=the CLI surface (flags, force gate, help);
    // fails_when=a flag is renamed, dropped, or misparsed
    const dir = mkdtempSync(join(tmpdir(), "artifex-preview-args-"));
    try {
      const out = join(dir, "p.html");
      expect(parseExportPreviewArgs(["--repo", dir, "--out", out])).toEqual({
        kind: "args",
        args: { repo: dir, out, force: false },
      });
      expect(parseExportPreviewArgs(["--repo", dir, "--out", out, "--force"])).toEqual({
        kind: "args",
        args: { repo: dir, out, force: true },
      });
      expect(parseExportPreviewArgs(["--help"])).toEqual({ kind: "help" });
      expect(parseExportPreviewArgs(["-h"])).toEqual({ kind: "help" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("every refusal is non-zero-able and names the offending value", () => {
    // Value: protects=V2 (arg validation refuses loudly with the
    // value attached); fails_when=a refusal is silent or misnames
    const dir = mkdtempSync(join(tmpdir(), "artifex-preview-args-"));
    try {
      const file = join(dir, "f.ts");
      writeFileSync(file, "export const x = 1;\n");
      const out = join(dir, "p.html");
      expect(parseExportPreviewArgs(["--out", out])).toEqual({
        kind: "error",
        error: "export-preview: missing required --repo <dir>",
      });
      expect(parseExportPreviewArgs(["--repo", join(dir, "missing"), "--out", out])).toEqual({
        kind: "error",
        error: `export-preview: repo is not a directory: ${join(dir, "missing")}`,
      });
      expect(parseExportPreviewArgs(["--repo", file, "--out", out]).kind).toBe("error");
      expect(parseExportPreviewArgs(["--repo", dir])).toEqual({
        kind: "error",
        error: "export-preview: missing required --out <file.html>",
      });
      expect(parseExportPreviewArgs(["--repo", dir, "--out", join(dir, "p.txt")])).toEqual({
        kind: "error",
        error: `export-preview: --out must end in .html: ${join(dir, "p.txt")}`,
      });
      expect(parseExportPreviewArgs(["--repo", dir, "--out"])).toEqual({
        kind: "error",
        error: "export-preview: --out needs a value",
      });
      expect(parseExportPreviewArgs(["--repo"])).toEqual({
        kind: "error",
        error: "export-preview: --repo needs a value",
      });
      expect(parseExportPreviewArgs(["--repo", dir, "--out", out, "--bogus"])).toEqual({
        kind: "error",
        error: "export-preview: unknown flag: --bogus",
      });
      expect(parseExportPreviewArgs(["--repo", dir, "--out", out, "stray"])).toEqual({
        kind: "error",
        error: "export-preview: unexpected argument: stray",
      });
      writeFileSync(out, "<html></html>");
      const refused = parseExportPreviewArgs(["--repo", dir, "--out", out]);
      expect(refused.kind).toBe("error");
      expect(refused.kind === "error" ? refused.error : "").toContain(out);
      expect(parseExportPreviewArgs(["--repo", dir, "--out", out, "--force"]).kind).toBe("args");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveArtifexRev", () => {
  test("reads the checkout rev, and says unknown when git cannot", () => {
    // Value: protects=provenance honesty (a rev or an honest
    // unknown, never blank or crashed); fails_when=rev-parse
    // handling throws or misreads
    expect(resolveArtifexRev()).toMatch(/^([0-9a-f]{7,40}|unknown)$/);
    const plain = mkdtempSync(join(tmpdir(), "artifex-preview-nogit-"));
    try {
      expect(resolveArtifexRev(plain)).toBe("unknown");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
    expect(resolveArtifexRev(join(tmpdir(), "artifex-preview-no-such-dir-qa"))).toBe("unknown");
  });
});

describe("export preview over public surfaces", () => {
  let server: FloorServer | undefined;

  beforeAll(async () => {
    const repo = copyMiniFloor();
    server = await createFloorServer({ repo, port: 0, agent: false });
    // The repo copy outlives the server (watcher reads); removed in afterAll.
    (server as unknown as { __repo: string }).__repo = repo;
  }, 60000);

  afterAll(() => {
    const repo = (server as unknown as { __repo?: string } | undefined)?.__repo;
    server?.stop();
    server = undefined;
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  test("fetchAsset reads the served bundle and stylesheet", async () => {
    // Value: protects=the export reading exactly what the server
    // ships (no second bundle path); fails_when=a route moves
    const base = `http://127.0.0.1:${server!.port}`;
    const appJs = await fetchAsset(base, "/app.js");
    expect(appJs.length).toBeGreaterThan(1000);
    expect(appJs).toContain("__ARTIFEX_TOKEN__");
    const css = await fetchAsset(base, "/styles.css");
    expect(css).toContain("--floor");
  });

  test("fetchAsset fails loud on HTTP errors and refused connections", async () => {
    // Value: protects=fail-loud-before-partial-write (no silent
    // empty asset in the file); fails_when=a fetch failure is
    // swallowed or misnamed
    const base = `http://127.0.0.1:${server!.port}`;
    await expect(fetchAsset(base, "/does-not-exist")).rejects.toThrow(
      "export-preview: fetch /does-not-exist failed: HTTP 404",
    );
    const probe = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const dead = `http://127.0.0.1:${probe.port}`;
    probe.stop(true);
    await expect(fetchAsset(dead, "/app.js")).rejects.toThrow("export-preview: fetch /app.js failed: ");
  });

  test("captureSnapshot takes the first v1 snapshot", async () => {
    // Value: protects=the frozen frame (first snapshot, authed as
    // any client); fails_when=auth, the snapshot shape, or the
    // building count drifts
    const snapshot = await captureSnapshot(server!);
    expect(snapshot.v).toBe(1);
    expect(snapshot.type).toBe("snapshot");
    expect(snapshot.buildings.length).toBe(server!.buildingCount());
    expect(snapshot.buildings.length).toBeGreaterThan(0);
  });

  test("captureSnapshot against a dead server fails naming the snapshot", async () => {
    // Value: protects=the snapshot failure mode (named, non-zero);
    // fails_when=a dead server hangs or errors anonymously
    const repo = tinyRepo();
    try {
      const dead = await createFloorServer({ repo, port: 0, agent: false });
      dead.stop();
      await expect(captureSnapshot(dead)).rejects.toThrow("export-preview: snapshot failed: ");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

describe("exportPreview round trip", () => {
  test("one self-contained file whose snapshot matches ground truth", async () => {
    // Value: protects=V4 (single file, success line, snapshot ===
    // server truth incl. a proven import belt); fails_when=the
    // embed, the counts, or the belt wiring drifts
    const repo = copyMiniFloor();
    const dir = mkdtempSync(join(tmpdir(), "artifex-preview-out-"));
    try {
      const out = join(dir, "sub", "floor.html");
      const { code, out: logs } = await capture(() => runExportPreview(["--repo", repo, "--out", out]));
      expect(code).toBe(0);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain(out);
      expect(logs[0]).toMatch(/\d+ bytes/);
      const html = readFileSync(out, "utf8");
      expect(statSync(out).size).toBe(Buffer.byteLength(html, "utf8"));
      expect(logs[0]).toContain(`${statSync(out).size} bytes`);
      const start = html.indexOf("<script>window.__ARTIFEX_SNAPSHOT__ = ");
      expect(start).toBeGreaterThanOrEqual(0);
      const snapJson = html.slice(
        start + "<script>window.__ARTIFEX_SNAPSHOT__ = ".length,
        html.indexOf(";\nwindow.__ARTIFEX_PREVIEW__", start),
      );
      const snap = JSON.parse(snapJson);
      expect(snap.v).toBe(1);
      expect(snap.type).toBe("snapshot");
      expect(logs[0]).toContain(`${snap.buildings.length} buildings`);
      expect(logs[0]).toContain(`${snap.belts.length} belts`);
      expect(logs[0]).toContain("exported ");
      // Trace-level ground truth: the main→util import pair in the
      // fixture resolves to a belt between the two building ids.
      const byPath = new Map(snap.buildings.map((b: { id: string; path: string }) => [b.path, b.id]));
      const from = byPath.get("src/main.ts");
      const to = byPath.get("src/util.ts");
      expect(from).toBeDefined();
      expect(to).toBeDefined();
      expect(snap.belts).toContainEqual({ fromId: from, toId: to, via: ['line 1: import { helper } from "./util.ts";'] });
      // The launch token never travels: empty token, no placeholder.
      expect(html).toContain('window.__ARTIFEX_TOKEN__ = "";');
      expect(html).not.toContain("%ARTIFEX_TOKEN%");
      // Self-contained: no relative asset fetches, no socket opener
      // reachable at boot (the bundle opens none in preview mode —
      // V8/V9 pin the runtime half from file://).
      expect(html).not.toContain('src="/app.js"');
      expect(html).not.toContain("/styles.css");
      expect(existsSync(join(dir, "sub"))).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});

describe("exportPreview failures", () => {
  test("--help exits 0 and documents the flags plus exactly what travels", async () => {
    // Value: protects=V2 (help) and the honest embed list in the
    // operator's face (ledger/notes ride along, served contents
    // and the token never do); fails_when=help exits non-zero or
    // the list goes undocumented
    expect(EXPORT_PREVIEW_HELP).toContain("--repo");
    expect(EXPORT_PREVIEW_HELP).toContain("--out");
    expect(EXPORT_PREVIEW_HELP).toContain("--force");
    expect(EXPORT_PREVIEW_HELP).toContain("run ledger with agent");
    expect(EXPORT_PREVIEW_HELP).toContain("Served file contents and");
    expect(EXPORT_PREVIEW_HELP).toContain("the launch token never travel");
    const { code, out } = await capture(() => runExportPreview(["--help"]));
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain("run ledger with agent");
  });

  test("arg refusals exit 2 naming the value", async () => {
    // Value: protects=V2 over the real CLI entry (not just the
    // parser); fails_when=a refusal exits 0 or swallows the value
    const dir = mkdtempSync(join(tmpdir(), "artifex-preview-cli-"));
    try {
      const missing = join(dir, "nope");
      const { code, err } = await capture(() => runExportPreview(["--repo", missing, "--out", join(dir, "o.html")]));
      expect(code).toBe(2);
      expect(err).toHaveLength(1);
      expect(err[0]).toContain(missing);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a repo deleted after validation fails boot naming the repo", async () => {
    // Value: protects=the boot failure mode (named, non-zero, no
    // partial write); fails_when=boot throws anonymously or writes anyway
    const repo = tinyRepo();
    const out = join(mkdtempSync(join(tmpdir(), "artifex-preview-cli-")), "o.html");
    const parsed = parseExportPreviewArgs(["--repo", repo, "--out", out]);
    if (parsed.kind !== "args") throw new Error("expected args to parse");
    rmSync(repo, { recursive: true, force: true });
    // Through exportPreview directly: the CLI entry would re-validate
    // (exit 2); this pins the boot leg failing loud instead.
    await expect(exportPreview(parsed.args)).rejects.toThrow(`export-preview: boot failed for ${repo}`);
    expect(existsSync(out)).toBe(false);
  });

  test("an unreadable template fails before booting", async () => {
    // Value: protects=fail-before-boot when the checkout is
    // damaged; fails_when=a missing template boots a server anyway
    // or errors anonymously
    const repo = tinyRepo();
    try {
      await expect(exportPreview(
        { repo, out: join(repo, "o.html"), force: false },
        { uiDir: join(repo, "no-ui-here") },
      )).rejects.toThrow(/export-preview: cannot read the floor-ui template in .*no-ui-here/);
      expect(existsSync(join(repo, "o.html"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a drifted template fails render naming the stage", async () => {
    // Value: protects=the render failure mode (template drift maps
    // to a named render failure, no partial write);
    // fails_when=drift ships a half-live page or errors anonymously
    const repo = tinyRepo();
    try {
      const uiDir = join(repo, "ui");
      mkdirSync(uiDir);
      writeFileSync(join(uiDir, "index.html"), "<html>drifted past the anchors</html>");
      await expect(exportPreview({ repo, out: join(repo, "o.html"), force: false }, { uiDir }))
        .rejects.toThrow("export-preview: render failed: ");
      expect(existsSync(join(repo, "o.html"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a --out that appears after validation refuses without --force, overwrites with it", async () => {
    // Value: protects=the write-time exclusivity gate (parse-time
    // exists checks race; the `wx` open is the real refusal);
    // fails_when=a late-appearing file is clobbered without --force
    const repo = tinyRepo();
    const out = join(mkdtempSync(join(tmpdir(), "artifex-preview-race-")), "o.html");
    try {
      writeFileSync(out, "<html>someone else won</html>");
      await expect(exportPreview({ repo, out, force: false })).rejects.toThrow(
        `export-preview: write failed for ${out}`,
      );
      expect(readFileSync(out, "utf8")).toBe("<html>someone else won</html>");
      const r = await exportPreview({ repo, out, force: true });
      expect(r.path).toBe(out);
      expect(readFileSync(out, "utf8")).toContain("__ARTIFEX_SNAPSHOT__");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(out, { force: true });
    }
  });

  test("an unwritable --out fails naming the path", async () => {
    // Value: protects=V5 (fail-loud-before-partial-write on the
    // write leg); fails_when=a write failure exits 0 or misnames
    const repo = tinyRepo();
    try {
      const blocker = join(repo, "blocker");
      writeFileSync(blocker, "not a dir");
      const out = join(blocker, "o.html");
      const { code, err } = await capture(() => runExportPreview(["--repo", repo, "--out", out]));
      expect(code).toBe(1);
      expect(err).toHaveLength(1);
      expect(err[0]).toContain("export-preview: write failed");
      expect(err[0]).toContain(out);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
