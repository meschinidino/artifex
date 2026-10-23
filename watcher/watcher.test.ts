import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findEnclosingGoModule, isExcluded, listFiles } from "./scan.ts";
import { countLines, decodeUtf8Prefix, isBinaryBuffer, isEnvFile, maskContent } from "./mask.ts";
import { diffListing, watchRepo, type FileMeta, type WatchChange } from "./index.ts";
import { isRepoRelativePath, resolveInsideRepo } from "../server/paths.ts";

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-fixture-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
  writeFileSync(join(dir, "src", "b.py"), "x = 1\n");
  writeFileSync(join(dir, "README.md"), "# hi\n");
  writeFileSync(join(dir, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
  writeFileSync(join(dir, "dist", "bundle.js"), "console.log(1);\n");
  return dir;
}

describe("scan", () => {
  test("walk listing excludes hard-excluded dirs; git listing agrees", () => {
    const dir = fixtureRepo();
    try {
      expect(listFiles(dir)).toEqual(["README.md", "src/a.ts", "src/b.py"]);
      const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      expect(init.exitCode).toBe(0);
      // dist/ is untracked and not gitignored, so git lists it and the
      // hard exclude must still drop it.
      expect(listFiles(dir)).toEqual(["README.md", "src/a.ts", "src/b.py"]);
      expect(isExcluded("a/node_modules/b.js")).toBe(true);
      expect(isExcluded("src/.artifex/x")).toBe(true);
      expect(isExcluded("src/ok.ts")).toBe(false);
      // Output names are packages inside a source tree, outputs outside it.
      expect(isExcluded("src/main/java/um/x/domain/ports/out/Repo.java")).toBe(false);
      expect(isExcluded("src/main/java/um/x/build/Gen.java")).toBe(false);
      expect(isExcluded("out/classes/A.class")).toBe(true);
      expect(isExcluded("mod/target/A.class")).toBe(true);
      expect(isExcluded("dist/app.js")).toBe(true);
      expect(isExcluded("src/node_modules/x.js")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=enclosing go.mod discovery (nearest wins, deep
  // prefixes relativize, the root itself is never consulted, total
  // misses stay undefined); fails_when=the walk drifts (subdir Go
  // belts vanish, or a root go.mod double-counts as enclosing).
  test("enclosing go.mod resolves nearest-first above the root", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-gomod-"));
    try {
      mkdirSync(join(dir, "mod", "sub", "deep"), { recursive: true });
      writeFileSync(join(dir, "mod", "go.mod"), "module example.com/mod\n");
      expect(findEnclosingGoModule(join(dir, "mod", "sub", "deep"))).toEqual({
        module: "example.com/mod",
        prefix: "sub/deep",
      });
      // The root's own go.mod is the resolver's in-tree job and is
      // never consulted here: the walk still reports the parent's.
      writeFileSync(join(dir, "mod", "sub", "go.mod"), "module example.com/inner\n");
      expect(findEnclosingGoModule(join(dir, "mod", "sub"))).toEqual({
        module: "example.com/mod",
        prefix: "sub",
      });
      // No go.mod anywhere above: outside any module.
      expect(findEnclosingGoModule(dir)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=nearest-decides (a garbage nearest go.mod ends
  // the search instead of falling through to a farther module);
  // fails_when=the walk skips garbage (imports misattribute to the
  // wrong module and belt foreign packages).
  test("a garbage nearest go.mod stops the search", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-gomod-garbage-"));
    try {
      mkdirSync(join(dir, "outer", "inner", "sub"), { recursive: true });
      writeFileSync(join(dir, "outer", "go.mod"), "module example.com/outer\n");
      writeFileSync(join(dir, "outer", "inner", "go.mod"), "not a module line\n");
      expect(findEnclosingGoModule(join(dir, "outer", "inner", "sub"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Value: protects=unreadable/oversize go.mod failing closed (no
  // enclosing module rather than a throw or a farther module);
  // fails_when=the read throws (a chmodded go.mod crashes the
  // resolver rebuild) or size is unbounded (a hostile file is
  // swallowed whole).
  test("unreadable and oversize go.mod fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-gomod-unread-"));
    try {
      mkdirSync(join(dir, "mod", "sub"), { recursive: true });
      const mod = join(dir, "mod", "go.mod");
      writeFileSync(mod, "module example.com/mod\n");
      chmodSync(mod, 0o000);
      try {
        expect(findEnclosingGoModule(join(dir, "mod", "sub"))).toBeUndefined();
      } finally {
        chmodSync(mod, 0o644);
      }
      writeFileSync(mod, `module example.com/mod\n// ${"x".repeat(257 * 1024)}\n`);
      expect(findEnclosingGoModule(join(dir, "mod", "sub"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("mask", () => {
  test("env detection is fail-closed across env-file conventions", () => {
    expect(isEnvFile(".env")).toBe(true);
    expect(isEnvFile("config/.env.local")).toBe(true);
    expect(isEnvFile("config/prod.env")).toBe(true);
    expect(isEnvFile("src/.envrc")).toBe(true);
    expect(isEnvFile(".ENV")).toBe(true);
    expect(isEnvFile("env.ts")).toBe(false);
  });

  test("secret assignments are masked with the fixed token", () => {
    const input = [
      "const API_TOKEN = 'abc123';",
      "export MY_SECRET_KEY=hunter2",
      "password: correct-horse",
      "const monkey = 1;",
      "const name = 'value';",
    ].join("\n");
    const { content, masked } = maskContent(input);
    expect(masked).toBe(true);
    expect(content).not.toContain("abc123");
    expect(content).not.toContain("hunter2");
    expect(content).not.toContain("correct-horse");
    // Substring rule over-masks "monkey" (contains KEY): the safe error.
    expect(content).toContain("const name = 'value';");
    expect(content.match(/\[masked\]/g)?.length).toBe(4);
  });

  test("CRLF secret assignments are masked too (Claude review regression)", () => {
    const { content, masked } = maskContent("API_KEY=abc\r\nTOKEN: xyz\r\nok=1\r\n");
    expect(masked).toBe(true);
    expect(content).not.toContain("abc");
    expect(content).not.toContain("xyz");
    expect(content).toContain("[masked]\r\n");
    expect(content).toContain("ok=1\r\n");
  });

  test("a wrapped quoted secret value on the next line is masked", () => {
    const { content, masked } = maskContent('const API_KEY =\n  "sk-live-123";\nconst other = "visible";\n');
    expect(masked).toBe(true);
    expect(content).not.toContain("sk-live-123");
    expect(content).toContain('"visible"');
  });

  test("PEM blocks collapse to one masked token (toaster T4 probe)", () => {
    // Headers built dynamically: the literal block must never sit
    // in a tracked file (the T4 pre-publish scan hunts exactly it).
    const kind = "PRIVATE KEY";
    const pem = [
      `-----BEGIN ${kind}-----`,
      "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
      "fakebase64materialthatmustnotsurvive",
      `-----END ${kind}-----`,
    ].join("\n");
    const { content, masked } = maskContent(`before\n${pem}\nafter\n`);
    expect(masked).toBe(true);
    expect(content).not.toContain("fakebase64materialthatmustnotsurvive");
    expect(content).not.toContain("PRIVATE KEY");
    expect(content).toContain("before");
    expect(content).toContain("after");
    expect(content.match(/\[masked\]/g)?.length).toBe(1);
  });

  test("a long keyword-shaped line with no delimiter does not backtrack", () => {
    const start = performance.now();
    const { masked } = maskContent("key".repeat(20_000));
    expect(masked).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  test("UTF-8 prefix decode drops only a character cut by the cap", () => {
    const cut = new TextEncoder().encode("€".repeat(10)).subarray(0, 29);
    expect(isBinaryBuffer(cut)).toBe(true); // as a whole buffer it is invalid
    expect(decodeUtf8Prefix(cut)).toBe("€".repeat(9));
    expect(decodeUtf8Prefix(new Uint8Array([0x41, 0x00, 0x42]))).toBeUndefined();
    expect(decodeUtf8Prefix(new Uint8Array([0xff, 0xfe]))).toBeUndefined();
  });

  test("binary detection and line counting", () => {
    expect(isBinaryBuffer(new Uint8Array([0x41, 0x00, 0x42]))).toBe(true);
    expect(isBinaryBuffer(new TextEncoder().encode("hola\n"))).toBe(false);
    expect(isBinaryBuffer(new Uint8Array([0xff, 0xfe, 0xfd]))).toBe(true);
    expect(countLines("")).toBe(0);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
  });
});

describe("paths", () => {
  test("shape rejects absolute, traversal, backslash, dot segments", () => {
    expect(isRepoRelativePath("src/a.ts")).toBe(true);
    expect(isRepoRelativePath("/etc/passwd")).toBe(false);
    expect(isRepoRelativePath("../secret")).toBe(false);
    expect(isRepoRelativePath("src/../secret")).toBe(false);
    expect(isRepoRelativePath("src\\a.ts")).toBe(false);
    expect(isRepoRelativePath("")).toBe(false);
    expect(isRepoRelativePath(42)).toBe(false);
  });

  test("symlink escape is rejected; real file resolves", () => {
    const dir = fixtureRepo();
    const outside = mkdtempSync(join(tmpdir(), "artifex-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "shh\n");
      symlinkSync(join(outside, "secret.txt"), join(dir, "src", "link.txt"));
      expect(listFiles(dir)).not.toContain("src/link.txt");
      expect(resolveInsideRepo(dir, "src/link.txt")).toEqual({ ok: false, code: "bad-path" });
      const good = resolveInsideRepo(dir, "src/a.ts");
      expect(good.ok).toBe(true);
      expect(resolveInsideRepo(dir, "src/missing.ts")).toEqual({ ok: false, code: "not-found" });
      expect(resolveInsideRepo(dir, "../x")).toEqual({ ok: false, code: "bad-path" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("watchRepo", () => {
  // Value: protects=deleted-directory fan-out (a removed tree may
  // report only itself; every known child must still resolve as a
  // deletion); fails_when=the descendant sweep drops (ghost
  // buildings for files under a deleted dir); why_new=re-audit
  // (watcher/index.ts:171-174; no test ever drove watchRepo live).
  test("deleting a directory reports every known child deleted", async () => {
    const dir = fixtureRepo();
    mkdirSync(join(dir, "sub", "deep"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.ts"), "export {};\n");
    writeFileSync(join(dir, "sub", "deep", "b.ts"), "export {};\n");
    const seen: WatchChange[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      () => {},
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      rmSync(join(dir, "sub"), { recursive: true, force: true });
      const deadline = Date.now() + 8_000;
      for (;;) {
        const gone = (p: string) => seen.some((c) => c.kind === "deleted" && c.path === p);
        if (gone("sub/a.ts") && gone("sub/deep/b.ts")) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for deletes; got: ${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      // Exact set: the climb-sweep must not over-report siblings
      // outside the deleted tree (macOS delivers a single event for
      // one deep file; everything else comes from the sweep).
      await new Promise((r) => setTimeout(r, 400));
      expect(seen).toHaveLength(2);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=single-file delete precision (exactly one
  // change, no sweep: the parent still exists so the climb stops);
  // fails_when=the fast-path skip drops (every delete scans, or
  // siblings get swept along); why_new=re-audit (climb-sweep guard).
  test("deleting one file reports exactly one delete", async () => {
    const dir = fixtureRepo();
    const seen: WatchChange[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      () => {},
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      rmSync(join(dir, "src", "a.ts"));
      const deadline = Date.now() + 8_000;
      for (;;) {
        if (seen.some((c) => c.kind === "deleted" && c.path === "src/a.ts")) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for delete; got: ${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 400));
      expect(seen).toEqual([{ kind: "deleted", path: "src/a.ts" }]);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=directory renames pairing per file (the new
  // dir has no known descendants, so a rescan diff pairs old↔new by
  // inode instead of delete+create churn); fails_when=the rescan
  // fallback drops (ids/slots churn on every folder move);
  // why_new=re-audit (rescan pairing untested).
  test("renaming a directory pairs every child as renamed", async () => {
    const dir = fixtureRepo();
    mkdirSync(join(dir, "old"), { recursive: true });
    writeFileSync(join(dir, "old", "a.ts"), "export {};\n");
    writeFileSync(join(dir, "old", "b.ts"), "export {};\n");
    const seen: WatchChange[] = [];
    const states: string[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      (s) => {
        states.push(s);
      },
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      renameSync(join(dir, "old"), join(dir, "new"));
      const deadline = Date.now() + 8_000;
      for (;;) {
        const paired = (p: string) => seen.some((c) => c.kind === "renamed" && c.path === p);
        if (paired("new/a.ts") && paired("new/b.ts")) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for renames; got: ${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(states).toContain("rescanning");
      expect(seen).toHaveLength(2);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=burst deletes under event coalescing (9
  // unlinks may arrive as 1 event: the delete-triggered verify
  // surfaces silent siblings as a catch-up batch, never ghosts);
  // fails_when=the verify drops (8 ghosts on every mass delete —
  // observed: total stuck at 8); why_new=re-audit (E2E empty-floor
  // caught it; third watcher bug from the coverage push).
  test("deleting every file reports every delete despite coalescing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-burst-"));
    for (const d of ["src", "lib", "docs"]) mkdirSync(join(dir, d), { recursive: true });
    mkdirSync(join(dir, "src", "tests"), { recursive: true });
    const files = [
      "docs/notes.md",
      "package.json",
      "data.bin",
      "lib/types.ts",
      "lib/store.ts",
      "src/broken.ts",
      "src/tests/app.ts",
      "src/util.ts",
      "src/main.ts",
    ];
    for (const f of files) writeFileSync(join(dir, f), "x\n");
    const seen: WatchChange[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      () => {},
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      for (const f of files) unlinkSync(join(dir, f));
      const deadline = Date.now() + 10_000;
      for (;;) {
        const gone = seen.filter((c) => c.kind === "deleted").map((c) => c.path).sort();
        if (gone.length === files.length) {
          expect(gone).toEqual([...files].sort());
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for all deletes; got: ${JSON.stringify(seen)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      // Settle past the verify tick: no duplicates, no extras.
      await new Promise((r) => setTimeout(r, 500));
      expect(seen).toHaveLength(files.length);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=burst creates under event coalescing (the
  // delete-verify's mirror: silent recreated files surface via the
  // membership verify, never a half-missing floor);
  // fails_when=creates skip the verify (refills stall short);
  // why_new=re-audit (E2E refill caught it).
  test("creating every file reports every create despite coalescing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-burst-create-"));
    for (const d of ["src", "lib", "docs"]) mkdirSync(join(dir, d), { recursive: true });
    mkdirSync(join(dir, "src", "tests"), { recursive: true });
    const files = [
      "docs/notes.md",
      "package.json",
      "data.bin",
      "lib/types.ts",
      "lib/store.ts",
      "src/broken.ts",
      "src/tests/app.ts",
      "src/util.ts",
      "src/main.ts",
    ];
    const seen: WatchChange[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      () => {},
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      for (const f of files) writeFileSync(join(dir, f), "x\n");
      const deadline = Date.now() + 10_000;
      for (;;) {
        const born = seen.filter((c) => c.kind === "created").map((c) => c.path).sort();
        if (born.length === files.length) {
          expect(born).toEqual([...files].sort());
          break;
        }
        if (Date.now() > deadline) {
          throw new Error(`timed out waiting for all creates; got: ${JSON.stringify(seen)}`);
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 800));
      expect(seen).toHaveLength(files.length);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=the verify backstop ticking silently when clean
  // (plus close() cancelling it — no interval leaks);
  // fails_when=the tick drops (total event loss ghosts forever) or
  // fires phantom changes; why_new=re-audit (backstop wiring; the
  // healing half needs event loss and stays untestable by design).
  test("the verify backstop ticks silently and stops on close", async () => {
    const dir = fixtureRepo();
    const seen: WatchChange[] = [];
    const states: string[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      (s) => {
        states.push(s);
      },
      { verifyIntervalMs: 150 },
    );
    try {
      await new Promise((r) => setTimeout(r, 500));
      expect(states).toContain("rescanning");
      expect(states.at(-1)).toBe("watching");
      expect(seen).toEqual([]);
      const count = states.length;
      h.close();
      await new Promise((r) => setTimeout(r, 400));
      expect(states.length).toBe(count);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=one membership policy (a gitignored file
  // created live never becomes a building, exactly as at boot —
  // the scan honors .gitignore, so the watcher must too);
  // fails_when=flush admits unknown paths without the listing
  // check (an ignored file appears, then the verify rescan
  // deletes it: appear/vanish flapping against floor-equals-disk);
  // why_new=membership policy decision 2026-10-18 (option A).
  test("a gitignored file created live never enters the floor", async () => {
    const dir = fixtureRepo();
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    expect(init.exitCode).toBe(0);
    writeFileSync(join(dir, ".gitignore"), "*.tmp\n");
    const seen: WatchChange[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      () => {},
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      writeFileSync(join(dir, "src", "ignored.tmp"), "scratch\n");
      writeFileSync(join(dir, "src", "real.ts"), "export {};\n");
      const deadline = Date.now() + 8_000;
      for (;;) {
        if (seen.some((c) => c.kind === "created" && c.path === "src/real.ts")) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for real.ts; got: ${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      // Settle past the 500 ms verify rescan: the ignored path must
      // never have been mentioned (pre-fix it flaps created→deleted).
      await new Promise((r) => setTimeout(r, 700));
      expect(seen.filter((c) => c.path === "src/ignored.tmp")).toEqual([]);
      expect(h.known.has("src/ignored.tmp")).toBe(false);
      // The transition matters too: un-ignoring the file admits it
      // without a restart (a .gitignore edit rescans membership).
      writeFileSync(join(dir, ".gitignore"), "# nothing ignored\n");
      const deadline2 = Date.now() + 8_000;
      for (;;) {
        if (seen.some((c) => c.kind === "created" && c.path === "src/ignored.tmp")) break;
        if (Date.now() > deadline2) throw new Error(`timed out waiting for un-ignored create; got: ${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(h.known.has("src/ignored.tmp")).toBe(true);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=one membership policy for renames (renaming a
  // member onto an ignored name is a deletion, not a rename — the
  // target is not a member of the floor); fails_when=the admission
  // check runs before inode pairing or not at all (the building
  // lives on under an ignored name until restart);
  // why_new=membership policy decision 2026-10-18 (option A).
  test("renaming a file onto an ignored name reports a delete", async () => {
    const dir = fixtureRepo();
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    expect(init.exitCode).toBe(0);
    writeFileSync(join(dir, ".gitignore"), "*.tmp\n");
    const seen: WatchChange[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      () => {},
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      renameSync(join(dir, "src", "a.ts"), join(dir, "src", "a.tmp"));
      const deadline = Date.now() + 8_000;
      for (;;) {
        if (seen.some((c) => c.kind === "deleted" && c.path === "src/a.ts")) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for delete; got: ${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 700));
      expect(seen).toEqual([{ kind: "deleted", path: "src/a.ts" }]);
      expect(h.known.has("src/a.tmp")).toBe(false);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=the tracked-file exception to gitignore (git
  // lists tracked files even when ignore-matched, so a tracked
  // *.tmp recreated live IS a member); fails_when=the admission
  // check uses raw ignore rules instead of the listing (tracked
  // files vanish from the floor while git still tracks them);
  // why_new=membership policy decision 2026-10-18 (option A).
  test("a tracked file matching .gitignore is admitted live", async () => {
    const dir = fixtureRepo();
    const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    expect(init.exitCode).toBe(0);
    writeFileSync(join(dir, ".gitignore"), "*.tmp\n");
    writeFileSync(join(dir, "src", "kept.tmp"), "tracked\n");
    const add = Bun.spawnSync(["git", "add", "-f", "src/kept.tmp"], { cwd: dir });
    expect(add.exitCode).toBe(0);
    // In the index but absent on disk at boot: not a member yet.
    rmSync(join(dir, "src", "kept.tmp"));
    expect(listFiles(dir)).not.toContain("src/kept.tmp");
    const seen: WatchChange[] = [];
    const h = watchRepo(
      dir,
      listFiles(dir),
      (changes) => {
        seen.push(...changes);
      },
      () => {},
    );
    try {
      await new Promise((r) => setTimeout(r, 400));
      writeFileSync(join(dir, "src", "kept.tmp"), "tracked again\n");
      const deadline = Date.now() + 8_000;
      for (;;) {
        if (seen.some((c) => c.kind === "created" && c.path === "src/kept.tmp")) break;
        if (Date.now() > deadline) throw new Error(`timed out waiting for kept.tmp; got: ${JSON.stringify(seen)}`);
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(h.known.has("src/kept.tmp")).toBe(true);
    } finally {
      h.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);

  // Value: protects=start-failure degradation (recursive watch
  // unavailable: warn, stay truthful via rescan, keep retrying —
  // never throw out of the constructor); fails_when=the catch drops
  // (boot crashes where a warning plus retries belong);
  // why_new=re-audit (watcher/index.ts:313-318).
  test("watching a missing path warns instead of throwing", () => {
    const orig = console.error;
    let warned = "";
    console.error = (msg?: unknown) => {
      warned += String(msg);
    };
    try {
      const missing = join(tmpdir(), "artifex-watch-missing-qa");
      rmSync(missing, { recursive: true, force: true });
      const h = watchRepo(missing, [], () => {}, () => {});
      try {
        expect(warned).toContain("recursive watch unavailable");
      } finally {
        h.close();
      }
    } finally {
      console.error = orig;
    }
  });
});

describe("scan fallback", () => {
  // Value: protects=walk fallback when git is unusable (git missing
  // or unspawnable: same listing, no throw); fails_when=the spawn
  // catch drops (repos fail to open on gitless machines);
  // why_new=re-audit (watcher/scan.ts:41).
  test("an unusable git falls back to the walk listing", () => {
    const dir = fixtureRepo();
    try {
      const init = Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
      expect(init.exitCode).toBe(0);
      const viaGit = listFiles(dir);
      expect(viaGit).toEqual(["README.md", "src/a.ts", "src/b.py"]);
      const savedPath = process.env.PATH;
      process.env.PATH = "";
      try {
        expect(listFiles(dir)).toEqual(viaGit);
      } finally {
        // Assigning undefined would set the string "undefined".
        if (savedPath === undefined) delete process.env.PATH;
        else process.env.PATH = savedPath;
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("diffListing", () => {
  const meta = (ino: number, size = 10, mtimeMs = 1): FileMeta => ({ dev: 1, ino, size, mtimeMs });

  test("inode-only replacement counts as modified (review regression)", () => {
    const known = new Map([["a.ts", meta(1)]]);
    const current = new Map([["a.ts", meta(2)]]); // same size + mtime, new inode
    expect(diffListing(known, current)).toEqual([{ kind: "modified", path: "a.ts" }]);
  });

  test("reused inode with different size/mtime is create+delete, not a rename", () => {
    const known = new Map([["old.ts", meta(7, 10, 1)]]);
    const current = new Map([["new.ts", meta(7, 999, 2)]]);
    const changes = diffListing(known, current);
    expect(changes).toContainEqual({ kind: "created", path: "new.ts" });
    expect(changes).toContainEqual({ kind: "deleted", path: "old.ts" });
    expect(changes.some((c) => c.kind === "renamed")).toBe(false);
  });

  test("create/modify/delete and inode rename pairing", () => {
    const known = new Map([
      ["a.ts", meta(1)],
      ["b.ts", meta(2)],
      ["gone.ts", meta(3)],
    ]);
    const current = new Map([
      ["a.ts", meta(1, 99)], // modified (size)
      ["b-renamed.ts", meta(2)], // same inode as b.ts
      ["new.ts", meta(9)],
    ]);
    const changes = diffListing(known, current);
    expect(changes).toContainEqual({ kind: "modified", path: "a.ts" });
    expect(changes).toContainEqual({ kind: "renamed", path: "b-renamed.ts", fromPath: "b.ts" });
    expect(changes).toContainEqual({ kind: "created", path: "new.ts" });
    expect(changes).toContainEqual({ kind: "deleted", path: "gone.ts" });
    expect(changes).not.toContainEqual({ kind: "deleted", path: "b.ts" });
    expect(changes.length).toBe(4);
  });
});
