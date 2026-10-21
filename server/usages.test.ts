import { describe, expect, test } from "bun:test";
import {
  formatPrefixedUses,
  formatUses,
  goAliasUses,
  goDeclaredSymbols,
  goImportAlias,
  goPackageClause,
  stripGoNonCode,
  tsStatementNames,
} from "./usages.ts";

describe("formatUses", () => {
  test("empty is undefined; over-cap folds into +N more", () => {
    expect(formatUses([])).toBeUndefined();
    expect(formatUses(["a"])).toBe("uses a");
    expect(formatUses(["a", "b"])).toBe("uses a, b");
    expect(formatUses(["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"])).toBe("uses a, b, c, d, e, f, g, h, +2 more");
    expect(formatPrefixedUses("domain", [])).toBeUndefined();
    expect(formatPrefixedUses("domain", ["Leave"])).toBe("uses domain: Leave");
    expect(formatPrefixedUses("domain", ["a", "b", "c", "d", "e", "f", "g", "h", "i"])).toBe(
      "uses domain: a, b, c, d, e, f, g, h, +1 more",
    );
  });
});

describe("stripGoNonCode", () => {
  test("blanks line comments, block comments, strings, raw strings, runes", () => {
    const src = [
      `package p // domain.Leave`,
      `/* domain.Period */ var x = domain.Leave`,
      "var s = \"domain.Fake\\\"\" + `domain.Raw",
      "domain.Raw2` + 'r'",
      "var y = domain.Real",
    ].join("\n");
    const stripped = stripGoNonCode(src);
    expect(stripped).toContain("domain.Leave");
    expect(stripped).toContain("domain.Real");
    expect(stripped).not.toContain("domain.Fake");
    expect(stripped).not.toContain("domain.Raw");
    expect(stripped).not.toContain("domain.Period");
    expect(stripped.split("\n")).toHaveLength(5);
  });

  test("unterminated constructs blank to end of input, never throw", () => {
    expect(stripGoNonCode(`var x = "abc`)).not.toContain("abc");
    expect(stripGoNonCode(`var x = /* abc`)).not.toContain("abc");
    expect(stripGoNonCode(`var x = ` + "`abc")).not.toContain("abc");
  });
});

describe("goAliasUses", () => {
  test("distinct sorted uppercase selector uses; lowercase never", () => {
    const src = [
      "package main",
      "var a = domain.LeaveRequest{}",
      "var b domain.Period",
      "f(domain.LeaveRequest{}, x.lower)",
      "var c = domain.LeaveRequest{}",
    ].join("\n");
    expect(goAliasUses(src, "domain")).toEqual(["LeaveRequest", "Period"]);
  });

  test("rejects non-identifier aliases; ignores strings and comments", () => {
    expect(goAliasUses(`var x = domain.Leave{}`, "do-main")).toEqual([]);
    expect(goAliasUses(`// var x = domain.Leave{}`, "domain")).toEqual([]);
    expect(goAliasUses(`var s = "domain.Leave"`, "domain")).toEqual([]);
  });
});

describe("goImportAlias", () => {
  test("bare, aliased, blank, dot, junk", () => {
    expect(goImportAlias(`"hrapp/x"`)).toBe("");
    expect(goImportAlias(`vacationsapi "hrapp/x" // trailing`)).toBe("vacationsapi");
    expect(goImportAlias(`_ "hrapp/x"`)).toBe("_");
    expect(goImportAlias(`. "hrapp/x"`)).toBe(".");
    expect(goImportAlias(`import "hrapp/x"`)).toBe("");
    expect(goImportAlias(`import _ "hrapp/x"`)).toBe("_");
    expect(goImportAlias(`(`)).toBeUndefined();
    expect(goImportAlias(`import (`)).toBeUndefined();
    expect(goImportAlias(``)).toBeUndefined();
  });
});

describe("goPackageClause", () => {
  test("finds the clause; ignores comments; none when absent", () => {
    expect(goPackageClause(`package domain\n\nconst X = 1\n`)).toBe("domain");
    expect(goPackageClause(`// package fake\npackage real\n`)).toBe("real");
    expect(goPackageClause(`// nothing here\n`)).toBeUndefined();
  });
});

describe("goDeclaredSymbols", () => {
  test("types, funcs, methods, vars, consts, groups — fields and closures excluded", () => {
    const src = [
      "package domain",
      "",
      "type LeaveType string",
      "type LeaveTypeMeta struct {",
      "  Key LeaveType",
      "}",
      "type (",
      "  RequestStatus string",
      "  Approval ApprovalStatus",
      ")",
      "const StatusPending RequestStatus = \"pending\"",
      "const (",
      "  StatusApproved RequestStatus = \"approved\"",
      "  lower = 1",
      ")",
      "var DefaultMeta, FallbackMeta LeaveTypeMeta",
      "var (",
      "  Cache = map[string]int{}",
      ")",
      "func NormalizeLeaveTypeID(s string) string { return s }",
      "func (m LeaveTypeMeta) Validate() bool { return true }",
      "func (r *Repo) Save() { f := func() {}; _ = f }",
      "func lower() {}",
      "var impl = func() int { return 1 }",
    ].join("\n");
    expect(goDeclaredSymbols(src)).toEqual([
      "Approval",
      "Cache",
      "DefaultMeta",
      "FallbackMeta",
      "LeaveType",
      "LeaveTypeMeta",
      "NormalizeLeaveTypeID",
      "RequestStatus",
      "Save",
      "StatusApproved",
      "StatusPending",
      "Validate",
    ]);
  });

  test("generics, multiline structs in groups, empty file", () => {
    const src = [
      "package g",
      "func Map[T any](xs []T) []T { return xs }",
      "type Box[T any] struct { V T }",
      "type (",
      "  Pair struct {",
      "    A int",
      "    B int",
      "  }",
      "  Other int",
      ")",
    ].join("\n");
    expect(goDeclaredSymbols(src)).toEqual(["Box", "Map", "Other", "Pair"]);
    expect(goDeclaredSymbols("package doc\n")).toEqual([]);
  });
});

describe("tsStatementNames", () => {
  const lines = (s: string) => s.split("\n");

  test("single-line shapes bind every local", () => {
    expect(tsStatementNames(lines(`import { helper } from "./u";`), 1)).toEqual({
      names: ["helper"],
      endLine: 1,
      namespace: false,
    });
    expect(tsStatementNames(lines(`import Foo, { a, b as c } from "./u";`), 1)?.names).toEqual(["Foo", "a", "c"]);
    expect(tsStatementNames(lines(`import Foo from "./u";`), 1)?.names).toEqual(["Foo"]);
    expect(tsStatementNames(lines(`import * as ns from "./u";`), 1)).toEqual({
      names: ["ns.*"],
      endLine: 1,
      namespace: true,
    });
    expect(tsStatementNames(lines(`import Foo, * as ns from "./u";`), 1)?.names).toEqual(["Foo", "ns.*"]);
    expect(tsStatementNames(lines(`export { a } from "./u";`), 1)?.names).toEqual(["a"]);
    expect(tsStatementNames(lines(`import type { A } from "./u";`), 1)?.names).toEqual(["A"]);
  });

  test("multiline statements report the end line", () => {
    const stmt = [`import {`, `  helper,`, `  load,`, `} from "./u";`, `const x = 1;`];
    expect(tsStatementNames(stmt, 1)).toEqual({ names: ["helper", "load"], endLine: 4, namespace: false });
  });

  test("unrecognized shapes fall back to undefined", () => {
    expect(tsStatementNames(lines(`import "./u";`), 1)).toBeUndefined();
    expect(tsStatementNames(lines(`const x = require("./u");`), 1)).toBeUndefined();
    expect(tsStatementNames(lines(`export * from "./u";`), 1)).toBeUndefined();
    expect(tsStatementNames(lines(`import { a } from "./u";`), 2)).toBeUndefined();
    expect(tsStatementNames(lines(`import { /* x */ a } from "./u";`), 1)).toBeUndefined();
    expect(tsStatementNames(lines(`import { a }`), 1)).toBeUndefined();
    expect(tsStatementNames(lines(`const x = 1;`), 1)).toBeUndefined();
  });
});
