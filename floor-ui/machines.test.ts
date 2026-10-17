/**
 * Slice 1: machine-identity + machine-readout math. Every test pins an
 * observable (glyph drawn, string shown, count rendered) with the
 * credible regression that would flip it — no tautologies.
 */
import { describe, expect, test } from "bun:test";
import {
  BAND_NAMES,
  ago,
  farNamePriority,
  inspectorRows,
  kindOf,
  newestBuilding,
  nextAddress,
  pathHash,
  pipShown,
  pointAt,
  previewStale,
  searchHeadline,
  shortName,
  showName,
} from "./machines.ts";
import type { Building } from "./wire.ts";

function building(over: Partial<Building> = {}): Building {
  return {
    id: "b1",
    path: "src/main.ts",
    zoneId: "src",
    x: 0,
    y: 0,
    band: 0,
    lines: 42,
    bytes: 1200,
    mtimeMs: 1000,
    binary: false,
    parse: "ok",
    unresolvedCount: 0,
    ...over,
  };
}

describe("kindOf", () => {
  // Value: protects=test/doc/config/code corner glyphs; fails_when=the
  // classifier regex drifts; why_new=Slice 1 extraction; seam=none.
  test("test conventions get the flask, including __tests__ dirs", () => {
    for (const p of [
      "src/app.test.ts",
      "src/app.spec.js",
      "tests/app.ts",
      "test/app.ts",
      "test_runner",
      "a/test_runner",
      "src/app_test.ts",
      "src/__tests__/app.ts",
      "src/__test__/app.ts",
      "__tests__/app.ts",
    ]) {
      expect(kindOf(p)).toBe("test");
    }
  });

  // Value: protects=doc/config glyphs + code fallback; fails_when=a
  // regex widens (e.g. `.test` without trailing dot swallows
  // "latest.ts") or narrows; why_new=Slice 1; seam=none.
  test("doc, config, and code kinds with near-miss guards", () => {
    for (const p of ["docs/notes.md", "a.mdx", "r.txt", "r.rst", "r.adoc"]) expect(kindOf(p)).toBe("doc");
    for (const p of ["package.json", "c.jsonc", "c.toml", "c.yaml", "c.yml", "c.ini", "c.cfg", "c.lock"]) {
      expect(kindOf(p)).toBe("config");
    }
    for (const p of [".env", "a/.env", ".gitignore", ".editorconfig"]) expect(kindOf(p)).toBe("config");
    // Near misses that must stay code: the test regex needs ".test."
    // with both dots, "tests" as a path segment, "__tests__" wrapped
    // in underscores — bare substrings don't count.
    for (const p of [
      "src/latest.ts",
      "src/contest.ts",
      "src/attested.ts",
      "src/mytests/app.ts",
      "src/testsuite/app.ts",
      "src/tests2/app.ts",
      "src/__tests2__/app.ts",
      "src/atest/app.ts",
      "test",
      "src/main.ts",
    ]) {
      expect(kindOf(p)).toBe("code");
    }
  });
});

describe("pathHash", () => {
  // Value: protects=stable window patterns per file; fails_when=the
  // hash is swapped for Math.random (windows flicker every frame) or
  // the constants drift; why_new=Slice 1; seam=none.
  test("FNV-1a known vectors", () => {
    expect(pathHash("")).toBe(2166136261);
    expect(pathHash("a")).toBe(3826002220);
    expect(pathHash("lib/store.ts")).toBe(335007209);
  });

  // Value: protects=determinism across frames; fails_when=nondeterminism
  // creeps in; why_new=supplements the vectors (never the sole assert).
  test("same input, same output", () => {
    expect(pathHash("src/main.ts")).toBe(pathHash("src/main.ts"));
  });
});

describe("pointAt", () => {
  // Value: protects=belt-tick placement along routed paths;
  // fails_when=distance math drifts (ticks bunch or detach);
  // why_new=Slice 1; seam=none.
  test("walks segments and clamps past the end", () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 0],
      [10, 10],
    ];
    expect(pointAt(pts, 0)).toEqual([0, 0]);
    expect(pointAt(pts, 5)).toEqual([5, 0]);
    expect(pointAt(pts, 15)).toEqual([10, 5]);
    expect(pointAt(pts, 20)).toEqual([10, 10]);
    expect(pointAt(pts, 999)).toEqual([10, 10]);
    expect(pointAt(pts, -5)).toEqual([0, 0]);
  });

  // Value: protects=ticks on degenerate routes; fails_when=a
  // zero-length segment yields NaN (tick disappears or throws in
  // canvas); why_new=Slice 1 edge pin; seam=none.
  test("zero-length segments never produce NaN", () => {
    const [x, y] = pointAt(
      [
        [4, 4],
        [4, 4],
        [8, 4],
      ],
      2,
    );
    expect(Number.isNaN(x) || Number.isNaN(y)).toBe(false);
    expect([x, y]).toEqual([6, 4]);
  });

  // Value: protects=honest failure on broken routes; fails_when=the
  // guard is dropped and empty input crashes with an accidental
  // TypeError deep in tick code; why_new=A9 edge decision; seam=none.
  test("empty polyline throws a RangeError, not a TypeError", () => {
    expect(() => pointAt([], 5)).toThrow(RangeError);
    expect(() => pointAt([], 5)).toThrow("at least one point");
  });
});

describe("ago", () => {
  // Value: protects=last-change readout copy; fails_when=unit
  // boundaries drift ("60 min ago" instead of "1 h ago") or future
  // timestamps (clock skew) print negative durations; why_new=Slice 1.
  test("unit boundaries and future timestamps", () => {
    const now = 1_000_000_000;
    expect(ago(now, now)).toBe("just now");
    expect(ago(now - 59_000, now)).toBe("just now");
    expect(ago(now + 60_000, now)).toBe("just now");
    expect(ago(now - 60_000, now)).toBe("1 min ago");
    expect(ago(now - 3_599_000, now)).toBe("59 min ago");
    expect(ago(now - 3_600_000, now)).toBe("1 h ago");
    expect(ago(now - 86_399_000, now)).toBe("23 h ago");
    expect(ago(now - 86_400_000, now)).toBe("1 d ago");
    expect(ago(now - 3 * 86_400_000, now)).toBe("3 d ago");
  });
});

describe("newestBuilding", () => {
  // Value: protects=first-run landing target; fails_when=comparison
  // flips to oldest (camera lands on stale code); why_new=Slice 1.
  test("picks max mtime, first on ties, undefined when empty", () => {
    const a = building({ id: "a", mtimeMs: 100 });
    const b = building({ id: "b", mtimeMs: 300 });
    const c = building({ id: "c", mtimeMs: 200 });
    expect(newestBuilding([a, b, c])).toBe(b);
    const x = building({ id: "x", mtimeMs: 300 });
    expect(newestBuilding([x, b])).toBe(x);
    expect(newestBuilding([])).toBeUndefined();
  });
});

describe("pipShown", () => {
  // Value: protects=rendered pip counts (no overflow past the machine
  // edge); fails_when=the fit formula drifts; why_new=Slice 1. Counts
  // asserted, never the formula text.
  test("far hides, zero fan hides, cap is 5, small shows what fits", () => {
    expect(pipShown(76, 1, 9, "far")).toBe(0);
    expect(pipShown(76, 1, 0, "mid")).toBe(0);
    expect(pipShown(76, 1, 9, "mid")).toBe(5);
    expect(pipShown(40, 1, 3, "near")).toBe(3);
    // S machine at far-zoom-out: nothing fits, zero pips (no overflow).
    expect(pipShown(28, 0.25, 5, "mid")).toBe(0);
    // S machine at unit scale: fits 3 of 5.
    expect(pipShown(28, 1, 5, "mid")).toBe(3);
  });
});

describe("showName / shortName / farNamePriority", () => {
  // Value: protects=far-band decluttering that never hides errors,
  // selections, or priority machines; fails_when=a disjunct drops
  // (errors go unlabeled at far zoom); why_new=Slice 1.
  test("far hides healthy names only", () => {
    const base = { binary: false, band: "far" as const, parse: "ok" as const, selected: false, farName: false };
    expect(showName(base)).toBe(false);
    expect(showName({ ...base, parse: "error" })).toBe(true);
    expect(showName({ ...base, selected: true })).toBe(true);
    expect(showName({ ...base, farName: true })).toBe(true);
    expect(showName({ ...base, band: "mid" })).toBe(true);
    expect(showName({ ...base, band: "near" })).toBe(true);
    expect(showName({ ...base, binary: true, parse: "error", selected: true, farName: true })).toBe(false);
  });

  // Value: protects=nameplate copy; fails_when=basename/uppercase
  // formatting drifts; why_new=Slice 1.
  test("shortName uppercases the basename", () => {
    expect(shortName("lib/store.ts")).toBe("STORE.TS");
    expect(shortName("main.ts")).toBe("MAIN.TS");
  });

  // Value: protects=large-or-congested priority labeling;
  // fails_when=the band threshold moves (L machines lose labels);
  // why_new=Slice 1.
  test("band 2+ or congested stays labeled", () => {
    expect(farNamePriority(0, false)).toBe(false);
    expect(farNamePriority(1, false)).toBe(false);
    expect(farNamePriority(2, false)).toBe(true);
    expect(farNamePriority(3, false)).toBe(true);
    expect(farNamePriority(0, true)).toBe(true);
  });

  // Value: protects=inspector band copy; fails_when=band label copy
  // drifts from the legend; why_new=Slice 1 (also seen by E2E).
  test("BAND_NAMES copy", () => {
    expect([...BAND_NAMES]).toEqual(["S (<100 lines)", "M (100–499)", "L (500–1999)", "XL (≥2000)"]);
  });
});

describe("inspectorRows", () => {
  // Value: protects=exact inspector copy for code files; fails_when=row
  // formatting drifts; why_new=Slice 1. Exact strings, never toBeDefined.
  test("code file rows", () => {
    const rows = inspectorRows(building({ id: "b2", lines: 7, bytes: 99, band: 1, unresolvedCount: 2 }), [
      { fromId: "b9", toId: "b2" },
      { fromId: "b8", toId: "b2" },
      { fromId: "b2", toId: "b3" },
      { fromId: "b2", toId: "b2" },
    ]);
    expect(rows).toEqual({
      lines: "7",
      bytes: "99",
      band: "M (100–499)",
      parse: "ok",
      // A self-loop counts both ways (independent ifs, not else-if).
      belts: "3 / 2",
      unresolved: "2",
      errorHidden: true,
      errorText: "",
      noteHidden: true,
      noteText: "",
    });
  });

  // Value: protects=binary inspector copy + visible error rows;
  // fails_when=binary/ok special-cases swap; why_new=Slice 1.
  test("binary and error rows", () => {
    const bin = inspectorRows(building({ binary: true, lines: 0, parse: "ok" }), []);
    expect(bin.lines).toBe("— (binary)");
    expect(bin.parse).toBe("binary file, no preview");
    expect(bin.belts).toBe("0 / 0");
    const err = inspectorRows(building({ parse: "error", parseError: "Expected }" }), []);
    expect(err.errorHidden).toBe(false);
    expect(err.errorText).toBe("Expected }");
  });

  // Value: protects=the unparsed-note 3-way branch; fails_when=the
  // size threshold or binary guard drifts (giant files mislabeled);
  // why_new=Slice 1.
  test("unparsed note branches on size and binary", () => {
    const small = inspectorRows(building({ parse: "unparsed", bytes: 10 }), []);
    expect(small.noteHidden).toBe(false);
    expect(small.noteText).toBe("Not parsed (parser unavailable); rendered solid.");
    const big = inspectorRows(building({ parse: "unparsed", bytes: 1024 * 1024 + 1 }), []);
    expect(big.noteHidden).toBe(false);
    expect(big.noteText).toBe("Too large to parse (>1 MiB); rendered solid.");
    const atLimit = inspectorRows(building({ parse: "unparsed", bytes: 1024 * 1024 }), []);
    expect(atLimit.noteText).toBe("Not parsed (parser unavailable); rendered solid.");
    const bin = inspectorRows(building({ parse: "unparsed", binary: true, bytes: 10 }), []);
    expect(bin.noteHidden).toBe(true);
    expect(bin.noteText).toBe("");
  });

  // Value: protects=preview survival across same-building refreshes;
  // fails_when=the guard inverts (previews blank on every patch, or
  // stale previews survive selection changes); why_new=Slice 1.
  test("previewStale hides only on first or changed selection", () => {
    expect(previewStale(undefined, "a.ts")).toBe(true);
    expect(previewStale("a.ts", "a.ts")).toBe(false);
    expect(previewStale("a.ts", "b.ts")).toBe(true);
  });
});

describe("searchHeadline", () => {
  // Value: protects=listbox header copy in all four states;
  // fails_when=pluralization or truncation copy drifts; why_new=Slice 1.
  test("all four headline states", () => {
    expect(searchHeadline(0, 0)).toBe("no matches");
    expect(searchHeadline(5, 3)).toBe("3 of 5 matches");
    expect(searchHeadline(1, 1)).toBe("1 match");
    expect(searchHeadline(4, 4)).toBe("4 matches");
  });
});

describe("nextAddress", () => {
  // Value: protects=dispatch addressing that never clobbers composed
  // prompts; fails_when=the guard drops (clicking machines eats typed
  // text); why_new=Slice 1.
  test("addresses empty or auto-written prompts, preserves composed text", () => {
    expect(nextAddress("", "", "a.ts")).toEqual({ value: "@a.ts ", lastPrefix: "@a.ts " });
    expect(nextAddress("@a.ts ", "@a.ts ", "b.ts")).toEqual({ value: "@b.ts ", lastPrefix: "@b.ts " });
    // Composed text (differs from the last auto-write) survives intact.
    expect(nextAddress("@a.ts fix it", "@a.ts ", "b.ts")).toEqual({ value: "@a.ts fix it", lastPrefix: "@a.ts " });
    expect(nextAddress("hello", "", "b.ts")).toEqual({ value: "hello", lastPrefix: "" });
  });
});
