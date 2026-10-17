import { describe, expect, test } from "bun:test";
import {
  buildResolverContext,
  parseJsonc,
  resolveFileImports,
  resolvePyRef,
  resolveTsSpecifier,
  type ResolverContext,
} from "./resolver.ts";

function ctx(files: string[], json: Record<string, string> = {}): ResolverContext {
  return buildResolverContext(new Set(files), (p) => json[p]);
}

describe("resolver: TS relative specifiers", () => {
  const c = ctx(["src/a.ts", "src/b.ts", "src/dir/index.ts", "src/esm.ts"]);
  test("sibling, parent, and directory/index probing", () => {
    expect(resolveTsSpecifier("./b", "src/a.ts", c)).toEqual({ kind: "resolved", target: "src/b.ts" });
    expect(resolveTsSpecifier("./b.ts", "src/a.ts", c)).toEqual({ kind: "resolved", target: "src/b.ts" });
    expect(resolveTsSpecifier("./dir", "src/a.ts", c)).toEqual({ kind: "resolved", target: "src/dir/index.ts" });
    expect(resolveTsSpecifier("../b", "src/dir/index.ts", c)).toEqual({ kind: "resolved", target: "src/b.ts" });
  });
  test("a sibling file wins over a same-named directory", () => {
    const c2 = ctx(["src/a.ts", "src/dir/index.ts", "src/dir.ts"]);
    expect(resolveTsSpecifier("./dir", "src/a.ts", c2)).toEqual({ kind: "resolved", target: "src/dir.ts" });
  });
  test("ESM .js specifiers reach the .ts source", () => {
    expect(resolveTsSpecifier("./esm.js", "src/a.ts", c)).toEqual({ kind: "resolved", target: "src/esm.ts" });
  });
  test("misses and escapes are unresolved, never guessed", () => {
    expect(resolveTsSpecifier("./missing", "src/a.ts", c)).toEqual({ kind: "unresolved" });
    expect(resolveTsSpecifier("../../outside", "src/a.ts", c)).toEqual({ kind: "unresolved" });
    expect(resolveTsSpecifier("", "src/a.ts", c)).toEqual({ kind: "unresolved" });
    expect(resolveTsSpecifier("/abs/path", "src/a.ts", c)).toEqual({ kind: "unresolved" });
  });
  test("dot and dot-dot reach directory indexes including the root", () => {
    const c2 = ctx(["index.ts", "pkg/a.ts", "pkg/nested/deep.ts"]);
    expect(resolveTsSpecifier(".", "index.ts", c2)).toEqual({ kind: "resolved", target: "index.ts" });
    expect(resolveTsSpecifier("..", "pkg/a.ts", c2)).toEqual({ kind: "resolved", target: "index.ts" });
    expect(resolveTsSpecifier("..", "pkg/nested/deep.ts", c2)).toEqual({ kind: "unresolved" });
  });
  test("targets under excluded dirs are external, not dangling", () => {
    const c2 = ctx(["pkg/a.ts", "pkg/package.json"], {
      "pkg/package.json": JSON.stringify({ name: "self" }),
    });
    c2.isExcluded = (p) => p.split("/").includes("dist");
    const withDist = ctx(["pkg/a.ts", "pkg/package.json"], {
      "pkg/package.json": JSON.stringify({ name: "self", main: "./dist/a.js" }),
    });
    withDist.isExcluded = c2.isExcluded;
    // A self-reference into dist/ is mapped-but-unshown.
    expect(resolveTsSpecifier("self", "pkg/a.ts", withDist)).toEqual({ kind: "external" });
    // Same for a relative hop into an excluded dir.
    expect(resolveTsSpecifier("../dist/b", "pkg/a.ts", c2)).toEqual({ kind: "external" });
    // A genuinely dangling self-name still counts.
    expect(resolveTsSpecifier("self", "pkg/a.ts", c2)).toEqual({ kind: "unresolved" });
  });
});

describe("resolver: package self-reference", () => {
  const files = ["pkg/a.ts", "pkg/dist/main.js", "pkg/dist/feat.js", "pkg/lib/legacy.js", "pkg/package.json"];
  const json = {
    "pkg/package.json": JSON.stringify({
      name: "@scope/pkg",
      main: "./lib/legacy.js",
      exports: { ".": "./dist/main.js", "./feat": "./dist/feat.js" },
    }),
  };
  const c = ctx(files, json);
  test("exports map resolves the root and subpaths", () => {
    expect(resolveTsSpecifier("@scope/pkg", "pkg/a.ts", c)).toEqual({ kind: "resolved", target: "pkg/dist/main.js" });
    expect(resolveTsSpecifier("@scope/pkg/feat", "pkg/a.ts", c)).toEqual({ kind: "resolved", target: "pkg/dist/feat.js" });
  });
  test("unexported subpaths and missing export targets are unresolved", () => {
    expect(resolveTsSpecifier("@scope/pkg/hidden", "pkg/a.ts", c)).toEqual({ kind: "unresolved" });
    expect(resolveTsSpecifier("@scope/pkg/lib/legacy.js", "pkg/a.ts", c)).toEqual({ kind: "unresolved" });
  });
  test("string exports and main fallback", () => {
    const c2 = ctx(["p/i.ts", "p/out.js", "p/package.json"], { "p/package.json": JSON.stringify({ name: "solo", exports: "./out.js" }) });
    // String exports expose only the package root.
    expect(resolveTsSpecifier("solo", "p/i.ts", c2)).toEqual({ kind: "resolved", target: "p/out.js" });
    expect(resolveTsSpecifier("solo/deep", "p/i.ts", c2)).toEqual({ kind: "unresolved" });
    const c3 = ctx(["q/i.ts", "q/lib/legacy.js", "q/package.json"], { "q/package.json": JSON.stringify({ name: "oldie", main: "./lib/legacy.js" }) });
    expect(resolveTsSpecifier("oldie", "q/i.ts", c3)).toEqual({ kind: "resolved", target: "q/lib/legacy.js" });
  });
  test("another package's name does not self-resolve", () => {
    expect(resolveTsSpecifier("react", "pkg/a.ts", c)).toEqual({ kind: "external" });
  });
  test("conditions-only exports are the root sugar form", () => {
    const c2 = ctx(["p/i.ts", "p/dist/a.mjs", "p/package.json"], {
      "p/package.json": JSON.stringify({ name: "cond", exports: { import: "./dist/a.mjs", require: "./dist/a.cjs" } }),
    });
    expect(resolveTsSpecifier("cond", "p/i.ts", c2)).toEqual({ kind: "resolved", target: "p/dist/a.mjs" });
    expect(resolveTsSpecifier("cond/sub", "p/i.ts", c2)).toEqual({ kind: "unresolved" });
  });
  test("subpath patterns resolve with longest-prefix wins", () => {
    const c2 = ctx(["p/i.ts", "p/dist/x.js", "p/dist/deep/y.js", "p/package.json"], {
      "p/package.json": JSON.stringify({
        name: "pat",
        exports: { "./*": "./dist/*.js", "./deep/*": "./dist/deep/*.js" },
      }),
    });
    expect(resolveTsSpecifier("pat/x", "p/i.ts", c2)).toEqual({ kind: "resolved", target: "p/dist/x.js" });
    expect(resolveTsSpecifier("pat/deep/y", "p/i.ts", c2)).toEqual({ kind: "resolved", target: "p/dist/deep/y.js" });
    expect(resolveTsSpecifier("pat/nope", "p/i.ts", c2)).toEqual({ kind: "unresolved" });
  });
  test("array exports take the first entry that picks", () => {
    const c2 = ctx(["p/i.ts", "p/a.mjs", "p/b.mjs", "p/package.json"], {
      "p/package.json": JSON.stringify({ name: "arr", exports: { ".": ["./a.mjs", "./b.mjs"] } }),
    });
    expect(resolveTsSpecifier("arr", "p/i.ts", c2)).toEqual({ kind: "resolved", target: "p/a.mjs" });
  });
  // Value: protects=array-exports total miss (no entry picks: a
  // miss, never a throw or a guess); fails_when=the fallthrough
  // drops (null/number/object entries crash the picker);
  // why_new=re-audit (resolver.ts:272-273).
  test("array exports where nothing picks are unresolved", () => {
    const c2 = ctx(["p/i.ts", "p/package.json"], {
      "p/package.json": JSON.stringify({ name: "none", exports: { ".": [null, 42, {}] } }),
    });
    expect(resolveTsSpecifier("none", "p/i.ts", c2)).toEqual({ kind: "unresolved" });
  });
  test("hostile exports nesting fails as a miss, never a stack overflow", () => {
    let deep: unknown = "./x.js";
    for (let i = 0; i < 1000; i++) deep = { [`k${i % 10}`]: deep };
    const c2 = ctx(["p/i.ts", "p/package.json"], {
      "p/package.json": JSON.stringify({ name: "deep", exports: { ".": deep } }),
    });
    expect(resolveTsSpecifier("deep", "p/i.ts", c2)).toEqual({ kind: "unresolved" });
  });
  test("repeated condition keys with a dead leaf resolve fast, not 2^depth", () => {
    // Each level visited its "default" child twice (preferred loop +
    // values loop): 2^32 calls on a 32-deep chain. This returns
    // instantly now; pre-fix it hangs past the test timeout.
    let deep: unknown = null;
    for (let i = 0; i < 100; i++) deep = { default: deep };
    const c2 = ctx(["p/i.ts", "p/package.json"], {
      "p/package.json": JSON.stringify({ name: "wide", exports: { ".": deep } }),
    });
    expect(resolveTsSpecifier("wide", "p/i.ts", c2)).toEqual({ kind: "unresolved" });
  });
});

describe("resolver: tsconfig baseUrl + paths", () => {
  const files = ["src/a.ts", "src/lib/deep.ts", "src/base-only.ts", "tsconfig.json"];
  const json = {
    "tsconfig.json": `{
      // JSONC tolerated: comments and trailing commas are fine,
      "compilerOptions": {
        "baseUrl": "src",
        "paths": {
          "@lib/*": ["lib/*"],
          "exact": ["lib/deep.ts"],
        },
      },
    }`,
  };
  const c = ctx(files, json);
  test("star patterns and exact aliases resolve", () => {
    expect(resolveTsSpecifier("@lib/deep", "src/a.ts", c)).toEqual({ kind: "resolved", target: "src/lib/deep.ts" });
    expect(resolveTsSpecifier("exact", "src/a.ts", c)).toEqual({ kind: "resolved", target: "src/lib/deep.ts" });
  });
  test("baseUrl covers the rest; unmatched misses fall through to external", () => {
    expect(resolveTsSpecifier("base-only", "src/a.ts", c)).toEqual({ kind: "resolved", target: "src/base-only.ts" });
    // "@lib/*" has a literal prefix: the alias dangles in-repo, so
    // it counts. An unmatched third-party name falls through to
    // node_modules like TypeScript.
    expect(resolveTsSpecifier("@lib/missing", "src/a.ts", c)).toEqual({ kind: "unresolved" });
    expect(resolveTsSpecifier("react", "src/a.ts", c)).toEqual({ kind: "external" });
  });
  test("longest-prefix pattern wins; its miss does not try worse patterns", () => {
    const c2 = ctx(["src/a.ts", "src/lib/deep.ts", "tsconfig.json"], {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: "src",
          paths: { "*": ["lib/*"], "@lib/*": ["nowhere/*"] },
        },
      }),
    });
    // "@lib/*" is the longest match; it misses and counts (literal
    // prefix). The catch-all must not rescue the specifier with a
    // belt tsc would not draw.
    expect(resolveTsSpecifier("@lib/deep", "src/a.ts", c2)).toEqual({ kind: "unresolved" });
  });
  test("a catch-all miss falls through to a baseUrl hit", () => {
    const c2 = ctx(["src/a.ts", "src/real/hit.ts", "tsconfig.json"], {
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          baseUrl: "src",
          paths: { "*": ["nowhere/*"] },
        },
      }),
    });
    expect(resolveTsSpecifier("real/hit", "src/a.ts", c2)).toEqual({ kind: "resolved", target: "src/real/hit.ts" });
  });
  test("dollar sequences in the specifier stay literal in substitution", () => {
    const c2 = ctx(["src/a.ts", "src/lib/$&.ts", "tsconfig.json"], {
      "tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: "src", paths: { "@x/*": ["lib/*"] } } }),
    });
    expect(resolveTsSpecifier("@x/$&", "src/a.ts", c2)).toEqual({ kind: "resolved", target: "src/lib/$&.ts" });
  });
  test("invalid tsconfig JSON falls back to external", () => {
    const bad = ctx(["src/a.ts", "tsconfig.json"], { "tsconfig.json": "{not json" });
    expect(resolveTsSpecifier("base-only", "src/a.ts", bad)).toEqual({ kind: "external" });
  });
});

describe("resolver: Python absolute imports", () => {
  const c = ctx([
    "pkg/__init__.py",
    "pkg/mod.py",
    "pkg/sub.py",
    "pkg/sub/__init__.py",
    "top.py",
    "main.py",
  ]);
  test("dotted names map to files and packages", () => {
    expect(resolvePyRef({ lang: "py", level: 0, module: "top", names: [] }, "main.py", c)).toEqual({
      targets: ["top.py"],
      unresolved: 0,
      external: false,
    });
    expect(resolvePyRef({ lang: "py", level: 0, module: "pkg.mod", names: [] }, "main.py", c)).toEqual({
      targets: ["pkg/mod.py"],
      unresolved: 0,
      external: false,
    });
    expect(resolvePyRef({ lang: "py", level: 0, module: "pkg", names: [] }, "main.py", c)).toEqual({
      targets: ["pkg/__init__.py"],
      unresolved: 0,
      external: false,
    });
  });
  test("from-import submodule names add edges only on real files", () => {
    expect(resolvePyRef({ lang: "py", level: 0, module: "pkg", names: ["sub", "CONSTANT"] }, "main.py", c)).toEqual({
      targets: ["pkg/__init__.py", "pkg/sub.py"],
      unresolved: 0,
      external: false,
    });
  });
  test("stdlib and site-packages misses are external", () => {
    expect(resolvePyRef({ lang: "py", level: 0, module: "os", names: [] }, "main.py", c).external).toBe(true);
    expect(resolvePyRef({ lang: "py", level: 0, module: "os.path", names: [] }, "main.py", c).external).toBe(true);
    expect(resolvePyRef({ lang: "py", level: 0, module: "requests", names: [] }, "main.py", c)).toEqual({
      targets: [],
      unresolved: 0,
      external: true,
    });
  });
  test("repo-local modules shadow stdlib names", () => {
    const c2 = ctx(["main.py", "types.py", "os.py"]);
    expect(resolvePyRef({ lang: "py", level: 0, module: "types", names: [] }, "main.py", c2)).toEqual({
      targets: ["types.py"],
      unresolved: 0,
      external: false,
    });
    // A stdlib subpath with no local file still falls through.
    expect(resolvePyRef({ lang: "py", level: 0, module: "os.path", names: [] }, "main.py", c2).external).toBe(true);
  });
  test("package directories are not import roots", () => {
    // "sub" must not hit "pkg/sub.py": pkg/ is a package, not a
    // sys.path entry. Same for nested dirs and plain source dirs.
    for (const module of ["sub", "mod"]) {
      expect(resolvePyRef({ lang: "py", level: 0, module, names: [] }, "main.py", c)).toEqual({
        targets: [],
        unresolved: 0,
        external: true,
      });
    }
  });
  test("src-layout top-level packages resolve from their parent", () => {
    const c2 = ctx(["src/pkg/__init__.py", "src/pkg/mod.py", "main.py"]);
    expect(resolvePyRef({ lang: "py", level: 0, module: "pkg.mod", names: [] }, "main.py", c2)).toEqual({
      targets: ["src/pkg/mod.py"],
      unresolved: 0,
      external: false,
    });
    // The nested package dir itself is still not a root.
    expect(resolvePyRef({ lang: "py", level: 0, module: "mod", names: [] }, "main.py", c2).external).toBe(true);
  });
});

describe("resolver: Python relative imports", () => {
  const c = ctx([
    "pkg/__init__.py",
    "pkg/mod.py",
    "pkg/sib.py",
    "pkg/child.py",
    "pkg/sub/__init__.py",
    "pkg/sub/deep.py",
    "pkg/top.py",
    "top.py",
  ]);
  test("dot levels anchor at the importing directory", () => {
    expect(resolvePyRef({ lang: "py", level: 1, module: "", names: ["sib"] }, "pkg/mod.py", c)).toEqual({
      targets: ["pkg/sib.py"],
      unresolved: 0,
      external: false,
    });
    expect(resolvePyRef({ lang: "py", level: 1, module: "child", names: ["x"] }, "pkg/mod.py", c)).toEqual({
      targets: ["pkg/child.py"],
      unresolved: 0,
      external: false,
    });
    expect(resolvePyRef({ lang: "py", level: 2, module: "top", names: ["up"] }, "pkg/sub/deep.py", c)).toEqual({
      targets: ["pkg/top.py"],
      unresolved: 0,
      external: false,
    });
  });
  test("__init__.py anchors at its own package", () => {
    expect(resolvePyRef({ lang: "py", level: 1, module: "", names: ["mod"] }, "pkg/__init__.py", c)).toEqual({
      targets: ["pkg/mod.py"],
      unresolved: 0,
      external: false,
    });
  });
  test("dotted directory names survive relative resolution", () => {
    const c2 = ctx(["foo.bar/__init__.py", "foo.bar/baz.py", "foo.bar/mod.py"]);
    expect(
      resolvePyRef({ lang: "py", level: 1, module: "mod", names: ["x"] }, "foo.bar/baz.py", c2),
    ).toEqual({ targets: ["foo.bar/mod.py"], unresolved: 0, external: false });
  });
  // Value: protects=relative from-package submodule edges (`from
  // .sub import deep`: the package init plus the real submodule
  // file, attributes ignored); fails_when=the expansion drops (a
  // missing belt) or fires on non-files (phantom belts);
  // why_new=re-audit (resolver.ts:522-527).
  test("relative from-package imports add edges for real submodules", () => {
    expect(resolvePyRef({ lang: "py", level: 1, module: "sub", names: ["deep", "CONSTANT"] }, "pkg/mod.py", c)).toEqual({
      targets: ["pkg/sub/__init__.py", "pkg/sub/deep.py"],
      unresolved: 0,
      external: false,
    });
  });
  // Value: protects=dotted from-import names counted unresolved
  // (never a crash on the split); fails_when=the guard drops (a
  // malformed extractor ref throws instead of counting);
  // why_new=re-audit (resolver.ts:536-537).
  test("dotted from-import names are unresolved, not fatal", () => {
    expect(resolvePyRef({ lang: "py", level: 1, module: "", names: ["a.b"] }, "pkg/mod.py", c)).toEqual({
      targets: [],
      unresolved: 1,
      external: false,
    });
    expect(resolvePyRef({ lang: "py", level: 1, module: "", names: ["sib", "a.b"] }, "pkg/mod.py", c)).toEqual({
      targets: ["pkg/sib.py"],
      unresolved: 1,
      external: false,
    });
  });
  test("over-climbing and missing siblings are unresolved", () => {
    expect(resolvePyRef({ lang: "py", level: 5, module: "", names: ["x"] }, "pkg/mod.py", c)).toEqual({
      targets: [],
      unresolved: 1,
      external: false,
    });
    expect(resolvePyRef({ lang: "py", level: 1, module: "", names: ["gone"] }, "pkg/mod.py", c)).toEqual({
      targets: [],
      unresolved: 1,
      external: false,
    });
    // Partial hits still report the missing half.
    expect(resolvePyRef({ lang: "py", level: 1, module: "", names: ["sib", "gone"] }, "pkg/mod.py", c)).toEqual({
      targets: ["pkg/sib.py"],
      unresolved: 1,
      external: false,
    });
  });
});

describe("resolver: external classification", () => {
  const c = ctx(["src/a.ts"]);
  test("node builtins and bare third-party specifiers are external", () => {
    expect(resolveTsSpecifier("node:fs", "src/a.ts", c)).toEqual({ kind: "external" });
    expect(resolveTsSpecifier("node:path/posix", "src/a.ts", c)).toEqual({ kind: "external" });
    expect(resolveTsSpecifier("lodash", "src/a.ts", c)).toEqual({ kind: "external" });
  });
});

describe("resolver: unresolved counting at file level", () => {
  test("resolved dedupe and sort; only in-repo misses count", () => {
    const c = ctx(["src/a.ts", "src/b.ts"]);
    const belts = resolveFileImports(
      "src/a.ts",
      [
        { lang: "ts", specifier: "./b" },
        { lang: "ts", specifier: "./b" },
        { lang: "ts", specifier: "./missing" },
        { lang: "ts", specifier: "lodash" },
        { lang: "ts", specifier: "./a" },
      ],
      c,
    );
    expect(belts).toEqual({ targets: ["src/b.ts"], unresolved: 1 });
  });
  test("self-edges are dropped", () => {
    const c = ctx(["a.ts"]);
    expect(resolveFileImports("a.ts", [{ lang: "ts", specifier: "./a" }], c)).toEqual({
      targets: [],
      unresolved: 0,
    });
  });
});

describe("resolver: context building", () => {
  test("parseJsonc tolerates comments and trailing commas", () => {
    expect(parseJsonc(`{ "a": 1, /* block */ "b": [1, 2,], // line\n}`)).toEqual({ a: 1, b: [1, 2] });
    // Minimal trigger: a comma stays trailing across an intervening comment.
    expect(parseJsonc(`{ "a": 1, "b": 2, // line\n}`)).toEqual({ a: 1, b: 2 });
    expect(parseJsonc(`{ "a": 1, /* block */ "b": 2 }`)).toEqual({ a: 1, b: 2 });
    // Comment markers inside strings are data, not comments.
    expect(parseJsonc(`{ "u": "http://x/y", "v": "/* not a comment */" }`)).toEqual({ u: "http://x/y", v: "/* not a comment */" });
    // A UTF-8 BOM does not void the whole config.
    expect(parseJsonc(`\uFEFF{ "a": 1 }`)).toEqual({ a: 1 });
    expect(() => parseJsonc("{oops")).toThrow();
  });
  test("invalid package.json is skipped, not fatal", () => {
    const c = ctx(["p/i.ts", "p/package.json"], { "p/package.json": "{oops" });
    expect(c.packages.size).toBe(0);
    expect(resolveTsSpecifier("anything", "p/i.ts", c)).toEqual({ kind: "external" });
  });
});
