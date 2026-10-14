import { describe, expect, test } from "bun:test";
import { searchBuildings, SEARCH_RESULTS_LIMIT, type SearchResults } from "./search.ts";
import type { Building } from "./wire.ts";

function b(path: string): Building {
  return {
    id: `id-${path}`,
    path,
    zoneId: path.includes("/") ? path.slice(0, path.indexOf("/")) : "(root)",
    x: 0,
    y: 0,
    band: 0,
    lines: 1,
    bytes: 10,
    mtimeMs: 0,
    binary: false,
    parse: "unparsed",
    unresolvedCount: 0,
  };
}

const paths = (r: SearchResults): string[] => r.shown.map((x) => x.path);

describe("searchBuildings", () => {
  test("matches substrings case-insensitively", () => {
    const all = [b("src/app.ts"), b("src/store.ts"), b("docs/readme.md")];
    expect(paths(searchBuildings(all, "APP"))).toEqual(["src/app.ts"]);
    expect(paths(searchBuildings(all, "src/"))).toEqual(["src/app.ts", "src/store.ts"]);
  });

  test("basename matches rank above path-only matches", () => {
    const all = [b("app/util.ts"), b("src/app.ts")];
    expect(paths(searchBuildings(all, "app"))).toEqual(["src/app.ts", "app/util.ts"]);
  });

  test("ties break by path order, deterministically", () => {
    const all = [b("z/x.ts"), b("a/x.ts"), b("m/x.ts")];
    const first = paths(searchBuildings(all, "x"));
    const second = paths(searchBuildings([...all].reverse(), "x"));
    expect(first).toEqual(second);
    expect(first).toEqual(["a/x.ts", "m/x.ts", "z/x.ts"]);
  });

  test("results cap at the limit with a truthful total", () => {
    const all = Array.from({ length: SEARCH_RESULTS_LIMIT + 30 }, (_, i) => b(`src/f${i}.ts`));
    const r = searchBuildings(all, "src/f");
    expect(r.shown.length).toBe(SEARCH_RESULTS_LIMIT);
    expect(r.total).toBe(SEARCH_RESULTS_LIMIT + 30);
  });

  test("empty or blank query matches nothing", () => {
    const all = [b("src/app.ts")];
    expect(searchBuildings(all, "")).toEqual({ shown: [], total: 0 });
    expect(searchBuildings(all, "   ")).toEqual({ shown: [], total: 0 });
  });

  test("no match yields an empty list with zero total", () => {
    const r = searchBuildings([b("src/app.ts")], "zzz-nope");
    expect(r).toEqual({ shown: [], total: 0 });
  });

  test("negative limit shows nothing but keeps the truthful total (review R1)", () => {
    const all = [b("a/x.ts"), b("m/x.ts"), b("z/x.ts")];
    const r = searchBuildings(all, "x", -1);
    expect(r.shown).toEqual([]);
    expect(r.total).toBe(3);
  });
});
