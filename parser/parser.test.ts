/**
 * Parser client failure contract: every failure mode resolves
 * per-file `unavailable` results — the server never catches out of
 * parse(), so a throw here would break boot and every batch.
 *
 * Plus direct extractor tests: parseBatch is imported in-process
 * (small batches only — the subprocess boundary exists to reclaim
 * WASM memory on huge ones) and parse-run spawn tests for the CLI
 * surface the client depends on.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBatch } from "./extract.ts";
import { createParserClient } from "./index.ts";

describe("parser client failures", () => {
  // Value: protects=temp-dir failure degradation (the batch dir
  // cannot be created: unavailable results, not a throw out of
  // boot); fails_when=the outer catch drops (repos fail to open
  // when TMPDIR is broken); why_new=re-audit (parser/index.ts:134).
  test("an unwritable temp dir yields unavailable results, never a throw", async () => {
    const saved = process.env.TMPDIR;
    process.env.TMPDIR = "/nonexistent-artifex-tmpdir-qa/artifex-parse-";
    const client = createParserClient();
    try {
      const results = await client.parse([
        { path: "a.ts", content: "export const a = 1;\n" },
        { path: "notes.md", content: "# hi\n" },
      ]);
      expect(results).toEqual([
        { path: "a.ts", ok: false, parsed: false, imports: [], error: "parser unavailable" },
        { path: "notes.md", ok: true, parsed: false, imports: [] },
      ]);
    } finally {
      // Assigning undefined would set the string "undefined".
      if (saved === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = saved;
      client.terminate();
    }
  });
});

describe("parseBatch extraction", () => {
  // Value: protects=TS static import shapes (side-effect, named,
  // default, export-from, import-equals); fails_when=a query form
  // drops (missing belt) after grammar drift; why_new=re-audit
  // (extract.ts ran only inside the subprocess, invisible).
  test("static TS forms all extract", async () => {
    const [r] = await parseBatch([
      {
        path: "a.ts",
        content: [
          'import "./side";',
          'import def, { named } from "./mod";',
          'export { x } from "./reexp";',
          'import eq = require("./eq");',
          "export const local = 1;",
        ].join("\n"),
      },
    ]);
    expect(r).toMatchObject({ path: "a.ts", ok: true, parsed: true });
    expect(r!.imports).toEqual([
      { lang: "ts", specifier: "./side" },
      { lang: "ts", specifier: "./mod" },
      { lang: "ts", specifier: "./reexp" },
      { lang: "ts", specifier: "./eq" },
    ]);
  });

  // Value: protects=dynamic import capture + literal-only backstop
  // (templates, concatenations, multi-arg requires are skipped, never
  // guessed); fails_when=the backstop drops (phantom belts to
  // "./${x}") or dynamic forms stop matching; why_new=re-audit.
  test("dynamic require/import extract only literal single args", async () => {
    const [r] = await parseBatch([
      {
        path: "d.ts",
        content: [
          'const a = require("./a");',
          'const b = await import("./b");',
          'const c = require("./c", "extra");',
          "const d = require(`./${name}`);",
          'const e = require("./" + name);',
          "const f = require(name);",
        ].join("\n"),
      },
    ]);
    expect(r!.ok).toBe(true);
    expect(r!.imports).toEqual([
      { lang: "ts", specifier: "./a" },
      { lang: "ts", specifier: "./b" },
    ]);
  });

  // Value: protects=Python import shapes (multi-import, aliases,
  // from-import names, relative levels); fails_when=the query or
  // the positional name matching drifts (missing/wrong belts);
  // why_new=re-audit.
  test("python imports map to levels, modules, and names", async () => {
    const [r] = await parseBatch([
      {
        path: "m.py",
        content: ["import os, sys as s", "from pkg import a, b as c", "from . import sib", "from ..sub import x"].join(
          "\n",
        ),
      },
    ]);
    expect(r!.ok).toBe(true);
    expect(r!.imports).toEqual([
      { lang: "py", level: 0, module: "os", names: [] },
      { lang: "py", level: 0, module: "sys", names: [] },
      { lang: "py", level: 0, module: "pkg", names: ["a", "b"] },
      { lang: "py", level: 1, module: "", names: ["sib"] },
      { lang: "py", level: 2, module: "sub", names: ["x"] },
    ]);
  });

  // Value: protects=parse errors failing closed (no imports from a
  // recovered tree) with a located message; fails_when=errors yield
  // guessed imports (phantom belts) or lose their location;
  // why_new=re-audit.
  test("syntax errors fail closed with a located message", async () => {
    const [r] = await parseBatch([{ path: "bad.ts", content: "export function broken( { return ; }\n" }]);
    expect(r).toMatchObject({ path: "bad.ts", ok: false, parsed: true, imports: [] });
    expect(r!.error).toMatch(/^parse error at line 1, column \d+$/);
  });

  // Value: protects=per-file batch isolation (one bad file neither
  // voids its neighbors nor shifts result alignment);
  // fails_when=isolation drops (a syntax error empties the batch);
  // why_new=re-audit.
  test("one bad file leaves its batch neighbors intact", async () => {
    const results = await parseBatch([
      { path: "good1.ts", content: 'import "./x";\n' },
      { path: "bad.ts", content: "def broken(:\n" },
      { path: "notes.md", content: "# hi\n" },
      { path: "good2.ts", content: 'import "./y";\n' },
    ]);
    expect(results.map((r) => [r.path, r.ok, r.parsed])).toEqual([
      ["good1.ts", true, true],
      ["bad.ts", false, true],
      ["notes.md", true, false],
      ["good2.ts", true, true],
    ]);
    expect(results[0]!.imports).toEqual([{ lang: "ts", specifier: "./x" }]);
    expect(results[3]!.imports).toEqual([{ lang: "ts", specifier: "./y" }]);
  });

  // Value: protects=Java extraction (package, declared types,
  // plain/static/wildcard imports, referenced type names);
  // fails_when=a query leg drops (JVM belts vanish or the FQN
  // index loses its declaring files); why_new=connections milestone.
  test("java imports, package, declared and referenced types extract", async () => {
    const [r] = await parseBatch([
      {
        path: "src/main/java/acme/shop/OrderController.java",
        content: [
          "package acme.shop;",
          "import acme.shop.service.OrderService;",
          "import static acme.shop.util.Ids.newId;",
          "import acme.shop.model.*;",
          "import java.util.List;",
          "public class OrderController {",
          "  private final OrderService orderService;",
          "  public List<Order> all() { return orderService.all(); }",
          "}",
        ].join("\n"),
      },
    ]);
    expect(r).toMatchObject({ ok: true, parsed: true, packageName: "acme.shop" });
    expect(r!.imports).toEqual([
      { lang: "jvm", fqn: "acme.shop.service.OrderService", wildcard: false, isStatic: false },
      { lang: "jvm", fqn: "acme.shop.util.Ids.newId", wildcard: false, isStatic: true },
      { lang: "jvm", fqn: "acme.shop.model", wildcard: true, isStatic: false },
      { lang: "jvm", fqn: "java.util.List", wildcard: false, isStatic: false },
    ]);
    expect(r!.declaredTypes).toEqual(["OrderController"]);
    expect(r!.typeRefs).toContain("OrderService");
    expect(r!.typeRefs).toContain("Order");
    expect(r!.typeRefs).not.toContain("OrderController");
  });

  // Value: protects=nested types NOT registering as top-level
  // FQNs (they would hijack same-named imports) and single-segment
  // packages indexing; fails_when=queries lose their root anchor;
  // why_new=outside review P1.
  test("nested java types stay out of the FQN index; single-segment packages work", async () => {
    const [nested, single] = await parseBatch([
      {
        path: "Outer.java",
        content: "package acme;\npublic class Outer {\n  public static class Builder { }\n  public interface Inner { }\n}\n",
      },
      { path: "Lonely.java", content: "package acme;\nclass Lonely { }\n" },
    ]);
    expect(nested!.declaredTypes).toEqual(["Outer"]);
    expect(single!.packageName).toBe("acme");
    expect(single!.declaredTypes).toEqual(["Lonely"]);
  });

  // Value: protects=Kotlin extraction on the interface-repository
  // shape real repos use (generics + nullable returns);
  // fails_when=the kotlin query legs drift; why_new=connections.
  test("kotlin imports, package and declared types extract", async () => {
    const [r] = await parseBatch([
      {
        path: "src/main/java/acme/shop/kotlin/OrderRepository.kt",
        content: [
          "package acme.shop.kotlin",
          "import acme.shop.kotlin.model.Order",
          "import acme.shop.util.*",
          "interface OrderRepository {",
          "    fun findById(id: Long): Order?",
          "}",
        ].join("\n"),
      },
    ]);
    expect(r).toMatchObject({ ok: true, parsed: true, packageName: "acme.shop.kotlin" });
    expect(r!.imports).toEqual([
      { lang: "jvm", fqn: "acme.shop.kotlin.model.Order", wildcard: false, isStatic: false },
      { lang: "jvm", fqn: "acme.shop.util", wildcard: true, isStatic: false },
    ]);
    expect(r!.declaredTypes).toContain("OrderRepository");
    expect(r!.typeRefs).toContain("Order");
  });

  // Value: protects=Go import extraction (grouped, aliased, dot,
  // blank, single); fails_when=the spec walk drops a form (missing
  // package belts); why_new=connections milestone.
  test("go imports extract as literal paths", async () => {
    const [r] = await parseBatch([
      {
        path: "main.go",
        content: [
          "package main",
          "import (",
          '  "fmt"',
          '  alias "example.com/mod/pkg"',
          '  _ "example.com/mod/blank"',
          ")",
          'import "os"',
          "func main() { fmt.Println(os.Args) }",
        ].join("\n"),
      },
    ]);
    expect(r).toMatchObject({ ok: true, parsed: true });
    expect(r!.imports).toEqual([
      { lang: "go", specifier: "fmt" },
      { lang: "go", specifier: "example.com/mod/pkg" },
      { lang: "go", specifier: "example.com/mod/blank" },
      { lang: "go", specifier: "os" },
    ]);
  });

  // Value: protects=star imports contributing the module without
  // phantom names (nothing to resolve `*` to); fails_when=the
  // fallthrough drops (a crash on the wildcard node) or invents
  // names; why_new=re-audit (extract.ts:126-127).
  test("star imports keep the module with no names", async () => {
    const [r] = await parseBatch([{ path: "s.py", content: "from pkg import *\n" }]);
    expect(r!.ok).toBe(true);
    expect(r!.imports).toEqual([{ lang: "py", level: 0, module: "pkg", names: [] }]);
  });

  // Value: protects=the error-search visit cap (an error buried past
  // 20k nodes still terminates with an unlocated message);
  // fails_when=the cap drops (a hostile file walks unboundedly);
  // why_new=re-audit (extract.ts:202).
  test("an error past the visit cap terminates unlocated", async () => {
    const [r] = await parseBatch([{ path: "deep.ts", content: `f(`.repeat(25_000) + "###" + `)`.repeat(25_000) }]);
    expect(r!.ok).toBe(false);
    expect(r!.error).toBe("parse error");
  }, 30_000);

  // Value: protects=per-file isolation when extraction itself throws
  // (WASM fault shape: only that file goes unavailable, neighbors
  // and alignment survive); fails_when=the catch drops (one bad
  // file voids the batch); why_new=re-audit (extract.ts:240-241).
  test("a throwing file goes unavailable without voiding its batch", async () => {
    const results = await parseBatch([
      { path: "good1.ts", content: 'import "./x";\n' },
      // Deliberately mistyped: stands in for a WASM fault, which no
      // string content triggers (tree-sitter fails closed instead).
      { path: "evil.ts", content: null as unknown as string },
      { path: "good2.ts", content: 'import "./y";\n' },
    ]);
    expect(results.map((r) => [r.path, r.ok, r.parsed])).toEqual([
      ["good1.ts", true, true],
      ["evil.ts", false, false],
      ["good2.ts", true, true],
    ]);
    expect(results[1]!.error).toMatch(/^parser unavailable: /);
    expect(results[1]!.imports).toEqual([]);
  });

  // Value: protects=pathological nesting failing gracefully (visit
  // cap: an error, never a stack overflow or a hang);
  // fails_when=the cap drops (a hostile file hangs the batch);
  // why_new=re-audit.
  test("pathological nesting errors instead of hanging", async () => {
    const start = Date.now();
    const [r] = await parseBatch([{ path: "deep.ts", content: "(".repeat(50_000) }]);
    expect(Date.now() - start).toBeLessThan(30_000);
    expect(r!.ok).toBe(false);
    expect(r!.error).toBeDefined();
  }, 60_000);
});

describe("parse-run CLI", () => {
  const run = (args: string[]) =>
    spawnSync("bun", ["parser/parse-run.ts", ...args], { cwd: process.cwd(), encoding: "utf8" });

  // Value: protects=the batch subprocess contract the client parses
  // (exit 0 + encoded response echoing the batch id);
  // fails_when=the shape drifts (every batch decodes unavailable);
  // why_new=re-audit.
  test("a valid batch prints the encoded response", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-parse-run-"));
    try {
      const batch = join(dir, "batch.json");
      writeFileSync(batch, JSON.stringify({ id: 7, files: [{ path: "a.ts", content: 'import "./b";\n' }] }));
      const result = run([batch]);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        v: 1,
        id: 7,
        results: [{ path: "a.ts", ok: true, parsed: true, imports: [{ lang: "ts", specifier: "./b" }] }],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);

  // Value: protects=protocol failures exiting non-zero with a named
  // cause (the client turns these into unavailable, never a wedge);
  // fails_when=an exit-0-with-garbage path appears (client decodes
  // junk); why_new=re-audit.
  test("bad input exits 2 with a named cause", () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-parse-run-"));
    try {
      const notJson = join(dir, "bad.json");
      writeFileSync(notJson, "{nope");
      const r1 = run([notJson]);
      expect(r1.status).toBe(2);
      expect(r1.stderr).toContain("not valid JSON");
      const badShape = join(dir, "shape.json");
      writeFileSync(badShape, JSON.stringify({ id: "x", files: [] }));
      const r2 = run([badShape]);
      expect(r2.status).toBe(2);
      expect(r2.stderr).toContain("bad shape");
      const r3 = run([]);
      expect(r3.status).toBe(2);
      expect(r3.stderr).toContain("usage:");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("parser client degraded runner paths", () => {
  function stubRunner(name: string, body: string): string {
    const dir = mkdtempSync(join(tmpdir(), "artifex-parser-stub-"));
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  }

  // Value: protects=the batch failure contract against a runner
  // that crashes, speaks garbage, answers for another batch, or
  // hangs (every mode resolves unavailable, never a throw, never a
  // wedge); fails_when=any degraded path leaks a throw or a hole;
  // why_new=these paths were spawn-only coverage (invisible in-proc).
  test("crash, garbage, wrong-id, and hang all resolve unavailable", async () => {
    const files = [{ path: "a.ts", content: "export {}" }];
    const errors: unknown[][] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const crash = createParserClient({ runner: stubRunner("crash.ts", "process.exit(3);\n") });
      const r1 = await crash.parse(files);
      expect(r1).toEqual([{ path: "a.ts", ok: false, parsed: false, imports: [], error: "parser unavailable" }]);
      expect(errors.some((a) => String(a[0]).includes("parser batch failed (exit 3)"))).toBe(true);
      crash.terminate();

      const garbage = createParserClient({ runner: stubRunner("garbage.ts", "console.log('not json');\n") });
      expect((await garbage.parse(files))[0]!.error).toBe("parser unavailable");
      garbage.terminate();

      const wrongId = createParserClient({
        runner: stubRunner(
          "wrong-id.ts",
          "console.log(JSON.stringify({ v: 1, id: 999999, results: [] }));\n",
        ),
      });
      expect((await wrongId.parse(files))[0]!.error).toBe("parser unavailable");
      wrongId.terminate();

      const hang = createParserClient({
        runner: stubRunner("hang.ts", "setTimeout(() => {}, 60_000);\n"),
        timeoutMs: 250,
      });
      const t0 = Date.now();
      expect((await hang.parse(files))[0]!.error).toBe("parser unavailable");
      expect(Date.now() - t0).toBeLessThan(10_000);
      hang.terminate();
    } finally {
      console.error = origError;
    }
  }, 30_000);

  // Value: protects=terminate during an in-flight batch (kills the
  // child, batch resolves empty, later parses never spawn again);
  // fails_when=stop() leaves a parser process or a pending parse.
  test("terminate kills an in-flight batch", async () => {
    const client = createParserClient({
      runner: stubRunner("slow.ts", "setTimeout(() => {}, 60_000);\n"),
      timeoutMs: 60_000,
    });
    const pending = client.parse([{ path: "a.ts", content: "export {}" }]);
    await Bun.sleep(250);
    client.terminate();
    // The killed batch resolves fast; the parse() wrapper fills
    // every input with an unavailable result, never a hole.
    expect(await pending).toEqual([
      { path: "a.ts", ok: false, parsed: false, imports: [], error: "parser unavailable" },
    ]);
    // Terminal: a parse queued after terminate resolves the same
    // without spawning.
    const after = await client.parse([{ path: "a.ts", content: "export {}" }]);
    expect(after).toEqual([
      { path: "a.ts", ok: false, parsed: false, imports: [], error: "parser unavailable" },
    ]);
  }, 30_000);
});
