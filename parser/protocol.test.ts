import { describe, expect, test } from "bun:test";
import {
  decodeParseRequest,
  decodeParseResponse,
  encodeParseRequest,
  encodeParseResponse,
  languageForPath,
  parseStateForResult,
} from "./protocol.ts";
import { createParserClient } from "./index.ts";

describe("parser protocol codec", () => {
  test("request/response roundtrip; malformed input fails closed", () => {
    const req = encodeParseRequest(7, [{ path: "a.ts", content: "export {}" }]);
    expect(decodeParseRequest(req)).toEqual(req);
    expect(decodeParseRequest({ ...req, v: 2 })).toBeUndefined();
    expect(decodeParseRequest({ ...req, files: [{ path: 1 }] })).toBeUndefined();
    expect(decodeParseRequest(null)).toBeUndefined();

    const res = encodeParseResponse(7, [{
      path: "a.ts",
      ok: true,
      parsed: true,
      imports: [
        { lang: "ts", specifier: "./b", line: 3 },
        { lang: "py", level: 1, module: "mod", names: ["thing"], line: 7 },
      ],
    }]);
    expect(decodeParseResponse(res)).toEqual(res);
    expect(decodeParseResponse({ v: 1, id: 7, results: [{ path: "a.ts", ok: "yes", parsed: true }] })).toBeUndefined();
    // imports[] is required and validated entry by entry.
    expect(decodeParseResponse({
      v: 1,
      id: 7,
      results: [{ path: "a.ts", ok: true, parsed: true }],
    })).toBeUndefined();
    expect(decodeParseResponse({
      v: 1,
      id: 7,
      results: [{ path: "a.ts", ok: true, parsed: true, imports: [{ lang: "ts" }] }],
    })).toBeUndefined();
    expect(decodeParseResponse({
      v: 1,
      id: 7,
      results: [{ path: "a.ts", ok: true, parsed: true, imports: [{ lang: "py", level: -1, module: "", names: [], line: 1 }] }],
    })).toBeUndefined();
    expect(decodeParseResponse({
      v: 1,
      id: 7,
      results: [{ path: "a.ts", ok: true, parsed: true, imports: [{ lang: "rs", specifier: "x" }] }],
    })).toBeUndefined();
    // A ref without a proven 1-based line fails closed: the trace
    // export must never cite a line it was not shown.
    for (const bad of [
      { lang: "ts", specifier: "./b" },
      { lang: "ts", specifier: "./b", line: 0 },
      { lang: "ts", specifier: "./b", line: -2 },
      { lang: "ts", specifier: "./b", line: 1.5 },
      { lang: "ts", specifier: "./b", line: "1" },
      { lang: "py", level: 0, module: "os", names: [], line: 0 },
      { lang: "jvm", fqn: "a.B", wildcard: false, isStatic: false },
      { lang: "jvm", fqn: "a.B", wildcard: false, isStatic: false, line: 0 },
      { lang: "go", specifier: "fmt", line: 0 },
    ]) {
      expect(decodeParseResponse({
        v: 1,
        id: 7,
        results: [{ path: "a.ts", ok: true, parsed: true, imports: [bad] }],
      })).toBeUndefined();
    }
    expect(decodeParseResponse("nope")).toBeUndefined();
  });

  test("language mapping covers TS/JS family and Python only", () => {
    expect(languageForPath("a/b.ts")).toBe("typescript");
    expect(languageForPath("a/b.tsx")).toBe("tsx");
    expect(languageForPath("a/b.jsx")).toBe("tsx");
    // .js may contain JSX; the tsx grammar parses both.
    expect(languageForPath("a/b.js")).toBe("tsx");
    expect(languageForPath("a/b.mjs")).toBe("tsx");
    expect(languageForPath("a/b.cjs")).toBe("tsx");
    expect(languageForPath("a/b.py")).toBe("python");
    expect(languageForPath("a/b.md")).toBeUndefined();
    expect(languageForPath("a/Makefile")).toBeUndefined();
  });
});

describe("parse state mapping (review regression)", () => {
  test("a failed parse is never shown as ok", () => {
    expect(parseStateForResult({ path: "a.ts", ok: true, parsed: true, imports: [] })).toBe("ok");
    expect(parseStateForResult({ path: "a.md", ok: true, parsed: false, imports: [] })).toBe("ok");
    expect(parseStateForResult({ path: "a.ts", ok: false, parsed: true, imports: [], error: "parse error" })).toBe("error");
    // Worker/grammar unavailable: must read unparsed, never healthy.
    expect(parseStateForResult({ path: "a.ts", ok: false, parsed: false, imports: [], error: "parser unavailable" })).toBe("unparsed");
  });
});

describe("parser subprocess (real WASM)", () => {
  test("parses TS and Python, flags errors, skips unknown", async () => {
    const client = createParserClient();
    try {
      const results = await client.parse([
        { path: "good.ts", content: "export function f(x: number): number { return x; }\n" },
        { path: "bad.ts", content: "export function f( { return ; }\n" },
        { path: "view.js", content: "export const el = <div className=\"x\">hi</div>;\n" },
        { path: "deep.ts", content: `export const x = ${"(".repeat(2000)}1;\n` },
        { path: "good.py", content: "def f(x):\n    return x\n" },
        { path: "bad.py", content: "def f(:\n    return\n" },
        { path: "notes.md", content: "# hi\n" },
      ]);
      const byPath = new Map(results.map((r) => [r.path, r]));
      expect(byPath.get("good.ts")).toMatchObject({ ok: true, parsed: true });
      expect(byPath.get("bad.ts")?.ok).toBe(false);
      expect(byPath.get("bad.ts")?.error).toContain("parse error");
      expect(byPath.get("view.js")).toMatchObject({ ok: true, parsed: true });
      expect(byPath.get("deep.ts")?.ok).toBe(false);
      expect(byPath.get("good.py")).toMatchObject({ ok: true, parsed: true });
      expect(byPath.get("bad.py")?.ok).toBe(false);
      expect(byPath.get("notes.md")).toMatchObject({ ok: true, parsed: false });
    } finally {
      client.terminate();
    }
  }, 30_000);

  test("extracts raw literal imports; skips non-literal forms, errors yield none", async () => {
    const client = createParserClient();
    try {
      const results = await client.parse([
        {
          path: "mix.ts",
          content: [
            `import def from "./def";`,
            `import { a } from "../lib/a";`,
            `import "./side";`,
            `export { x } from "@scope/pkg/sub";`,
            `export * from "./all";`,
            `const r = require("./req");`,
            `const d = await import("./dyn");`,
            `const t = await import(\`./\${name}\`);`,
            `const c = require("./" + name);`,
            `import type { T } from "./types";`,
            `import eq = require("./eq");`,
            "",
          ].join("\n"),
        },
        {
          path: "pkg/mod.py",
          content: [
            `import os`,
            `import pkg.sub`,
            `import numpy as np`,
            `from pkg.other import thing`,
            `from . import sib`,
            `from .child import deep`,
            `from ..top import up`,
            `from pkg import *`,
            "",
          ].join("\n"),
        },
        { path: "broken.ts", content: "import x from './oops';\nexport function f( { return ; }\n" },
        // TSX/JSX share the narrowed call patterns (import node +
        // require predicate); many plain calls must not leak in.
        {
          path: "comp.tsx",
          content: [
            `import { useState } from "react";`,
            `const lazy = await import("./lazy");`,
            `const old = require("./legacy");`,
            `const el = render(<div onClick={() => handle(it)}>{fmt(x)}</div>);`,
            "",
          ].join("\n"),
        },
      ]);
      const byPath = new Map(results.map((r) => [r.path, r]));
      expect(byPath.get("mix.ts")).toMatchObject({ ok: true, parsed: true });
      expect(byPath.get("mix.ts")?.imports).toEqual([
        { lang: "ts", specifier: "./def", line: 1 },
        { lang: "ts", specifier: "../lib/a", line: 2 },
        { lang: "ts", specifier: "./side", line: 3 },
        { lang: "ts", specifier: "@scope/pkg/sub", line: 4 },
        { lang: "ts", specifier: "./all", line: 5 },
        { lang: "ts", specifier: "./req", line: 6 },
        { lang: "ts", specifier: "./dyn", line: 7 },
        { lang: "ts", specifier: "./types", line: 10 },
        { lang: "ts", specifier: "./eq", line: 11 },
      ]);
      expect(byPath.get("pkg/mod.py")).toMatchObject({ ok: true, parsed: true });
      expect(byPath.get("pkg/mod.py")?.imports).toEqual([
        { lang: "py", level: 0, module: "os", names: [], line: 1 },
        { lang: "py", level: 0, module: "pkg.sub", names: [], line: 2 },
        { lang: "py", level: 0, module: "numpy", names: [], line: 3 },
        { lang: "py", level: 0, module: "pkg.other", names: ["thing"], line: 4 },
        { lang: "py", level: 1, module: "", names: ["sib"], line: 5 },
        { lang: "py", level: 1, module: "child", names: ["deep"], line: 6 },
        { lang: "py", level: 2, module: "top", names: ["up"], line: 7 },
        { lang: "py", level: 0, module: "pkg", names: [], line: 8 },
      ]);
      // A parse error trusts nothing: no belts from a broken tree.
      expect(byPath.get("broken.ts")?.ok).toBe(false);
      expect(byPath.get("broken.ts")?.imports).toEqual([]);
      expect(byPath.get("comp.tsx")).toMatchObject({ ok: true, parsed: true });
      expect(byPath.get("comp.tsx")?.imports).toEqual([
        { lang: "ts", specifier: "react", line: 1 },
        { lang: "ts", specifier: "./lazy", line: 2 },
        { lang: "ts", specifier: "./legacy", line: 3 },
      ]);
    } finally {
      client.terminate();
    }
  }, 30_000);

  test("two clients in one process parse concurrently without colliding", async () => {
    const a = createParserClient();
    const b = createParserClient();
    try {
      const [ra, rb] = await Promise.all([
        a.parse([{ path: "a.ts", content: `import "./from-a";\nexport {};\n` }]),
        b.parse([{ path: "b.ts", content: `import "./from-b";\nexport {};\n` }]),
      ]);
      expect(ra[0]).toMatchObject({ path: "a.ts", ok: true, parsed: true });
      expect(ra[0]?.imports).toEqual([{ lang: "ts", specifier: "./from-a", line: 1 }]);
      expect(rb[0]).toMatchObject({ path: "b.ts", ok: true, parsed: true });
      expect(rb[0]?.imports).toEqual([{ lang: "ts", specifier: "./from-b", line: 1 }]);
    } finally {
      a.terminate();
      b.terminate();
    }
  }, 30_000);

  test("a terminated client returns defined unparsed results, never holes", async () => {
    const client = createParserClient();
    client.terminate();
    const results = await client.parse([
      { path: "a.ts", content: "export {};\n" },
      { path: "notes.md", content: "# hi\n" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({ path: "a.ts", ok: false, parsed: false, imports: [], error: "parser unavailable" });
    expect(results[1]).toEqual({ path: "notes.md", ok: true, parsed: false, imports: [] });
    expect(parseStateForResult(results[0]!)).toBe("unparsed");
  });
});
