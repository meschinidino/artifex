/**
 * Slice 5: persisted-layout validation + line counters, branch by
 * branch. Crafted states assert the reset AND which invariant tripped
 * (message match) — a bare toThrow proves nothing about the guard.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { countBufferLines, countNewlines, loadPersistedLayout, validatePersistedLayout } from "./index.ts";

function validState(over: Record<string, unknown> = {}) {
  return {
    v: 1,
    zones: { src: { x: 0, cols: 2, nextSlot: 2 } },
    buildings: { "src/a.ts": { id: "b1", zoneId: "src", slot: 0, x: 0, y: 40 } },
    nextZoneX: 240,
    nextId: 2,
    ...over,
  };
}

describe("validatePersistedLayout", () => {
  // Value: protects=honest boot from disk (valid states load,
  // coordinates re-derive); fails_when=validation rejects good
  // states (users lose layouts) or trusts stored x/y (teleports);
  // why_new=Slice 5; seam=none (production entry point, exported).
  test("valid state loads with recomputed coordinates", () => {
    const r = validatePersistedLayout(validState());
    expect(r.nextZoneX).toBe(240);
    expect(r.nextId).toBe(2);
    // Stored x/y are ignored: slot 0 of a 2-col zone at x=0.
    expect(r.buildings["src/a.ts"]).toMatchObject({ id: "b1", x: 0, y: 40 });
    const moved = validatePersistedLayout(
      validState({
        zones: { src: { x: 0, cols: 2, nextSlot: 4 } },
        buildings: { "src/a.ts": { id: "b1", zoneId: "src", slot: 3, x: 99999, y: -5 } },
      }),
    );
    expect(moved.buildings["src/a.ts"]).toMatchObject({ x: 96, y: 136 });
    expect(Object.getPrototypeOf(moved.zones)).toBeNull();
    expect(Object.getPrototypeOf(moved.buildings)).toBeNull();
  });

  // Value: protects=version/record/shape guards; fails_when=a guard
  // drops (wrong-version states load as current); why_new=Slice 5.
  test("bad version, records, and counters name their invariant", () => {
    expect(() => validatePersistedLayout(validState({ v: 999 }))).toThrow("bad version");
    expect(() => validatePersistedLayout(validState({ v: undefined }))).toThrow("bad version");
    expect(() => validatePersistedLayout(validState({ zones: null }))).toThrow("bad records");
    expect(() => validatePersistedLayout(validState({ buildings: [] }))).toThrow("bad records");
    for (const counters of [{ nextZoneX: -1 }, { nextZoneX: 1.5 }, { nextId: 0 }, { nextId: 1_000_000_001 }, { nextId: 2.5 }]) {
      expect(() => validatePersistedLayout(validState(counters))).toThrow("bad counters");
    }
  });

  // Value: protects=zone geometry bounds (cols, slots, x);
  // fails_when=a bound widens (crafted states mint giant pads);
  // why_new=Slice 5; seam=none.
  test("zone geometry outside bounds names the zone", () => {
    const bad = (z: Record<string, number>) => () => validatePersistedLayout(validState({ zones: { src: z } }));
    for (const z of [
      { x: 0, cols: 0, nextSlot: 1 },
      { x: 0, cols: 17, nextSlot: 1 },
      { x: 0, cols: 1.5, nextSlot: 1 },
      { x: 0, cols: 2, nextSlot: -1 },
      { x: 0, cols: 2, nextSlot: 1_000_001 },
      { x: -1, cols: 2, nextSlot: 1 },
      { x: 0.5, cols: 2, nextSlot: 1 },
    ]) {
      expect(bad(z)).toThrow("bad zone src");
    }
  });

  // Value: protects=column layout invariants (no overlap, cursor
  // past the last column, coordinates bounded); fails_when=overlap
  // accepted (pads stack) or the cursor check drops (zones pile at
  // x=0 on next boot); why_new=Slice 5; seam=none.
  test("overlapping columns, short cursor, and wild coordinates reset", () => {
    const zones = { a: { x: 0, cols: 2, nextSlot: 1 }, b: { x: 100, cols: 1, nextSlot: 1 } };
    expect(() => validatePersistedLayout(validState({ zones, nextZoneX: 244 }))).toThrow("overlapping zones");
    // Adjacent (240) is fine; 239 overlaps.
    const ok = { a: { x: 0, cols: 2, nextSlot: 1 }, b: { x: 240, cols: 1, nextSlot: 1 } };
    expect(() => validatePersistedLayout(validState({ zones: ok, nextZoneX: 384, buildings: {} }))).not.toThrow();
    const short = { a: { x: 0, cols: 2, nextSlot: 1 } };
    expect(() => validatePersistedLayout(validState({ zones: short, nextZoneX: 239 }))).toThrow("bad nextZoneX");
    expect(() => validatePersistedLayout(validState({ nextZoneX: 1585 }))).toThrow("bad zone coordinates");
    expect(() =>
      validatePersistedLayout(validState({ zones: { src: { x: 2000, cols: 2, nextSlot: 1 } }, nextZoneX: 2240 })),
    ).toThrow("bad zone coordinates");
  });

  // Value: protects=building record invariants (id format/counter,
  // slot range/uniqueness, zone membership); fails_when=a check
  // drops (duplicate ids minted, slots double-booked);
  // why_new=Slice 5; seam=none.
  test("bad building records name their path", () => {
    const bad = (b: Record<string, unknown>, path = "src/a.ts"): (() => unknown) => () =>
      validatePersistedLayout(validState({ buildings: { [path]: b } }));
    const good = { id: "b1", zoneId: "src", slot: 0, x: 0, y: 40 };
    for (const b of [
      { ...good, id: "x1" },
      { ...good, id: "b" },
      { ...good, id: 5 },
      { ...good, slot: 2 },
      { ...good, slot: -1 },
      { ...good, slot: 0.5 },
      { ...good, zoneId: "nope" },
      { ...good, x: "0" },
    ]) {
      expect(bad(b)).toThrow("bad building src/a.ts");
    }
    // Counter at/below an existing id would mint duplicates.
    expect(() => validatePersistedLayout(validState({ nextId: 1 }))).toThrow("bad building src/a.ts");
    // Duplicate slot in one zone.
    expect(() =>
      validatePersistedLayout(
        validState({ buildings: { "src/a.ts": good, "src/b.ts": { ...good, id: "b2" } }, nextId: 3 }),
      ),
    ).toThrow("bad building src/b.ts");
    // Duplicate id across paths.
    expect(() =>
      validatePersistedLayout(validState({ buildings: { "src/a.ts": good, "src/b.ts": good }, nextId: 3 })),
    ).toThrow("bad building src/b.ts");
  });

  // Value: protects=__proto__ re-homing (no prototype pollution
  // from crafted states); fails_when=plain objects used (a crafted
  // key pollutes every lookup); why_new=Slice 5; seam=none.
  test("__proto__ keys re-home as plain data", () => {
    const parsed = JSON.parse(
      '{"v":1,"zones":{"__proto__":{"x":0,"cols":1,"nextSlot":1}},"buildings":{},"nextZoneX":144,"nextId":1}',
    );
    const r = validatePersistedLayout(parsed);
    expect(Object.hasOwn(r.zones, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(r.zones)).toBeNull();
    const pb = JSON.parse(
      '{"v":1,"zones":{"src":{"x":0,"cols":1,"nextSlot":1}},"buildings":{"__proto__":{"id":"b1","zoneId":"src","slot":0,"x":0,"y":40}},"nextZoneX":144,"nextId":2}',
    );
    const rb = validatePersistedLayout(pb);
    expect(Object.hasOwn(rb.buildings, "__proto__")).toBe(true);
    // On plain {} targets these assignments would set the prototype
    // instead of own properties — hasOwn catches the regression.
    expect(Object.getPrototypeOf(rb.buildings)).toBeNull();
  });
});

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "artifex-layout-"));
}

describe("loadPersistedLayout", () => {

  // Value: protects=fresh boot with no state; fails_when=missing
  // state throws instead of booting clean; why_new=Slice 5.
  test("missing state boots fresh without reset", () => {
    const repo = tmpRepo();
    try {
      expect(loadPersistedLayout(repo)).toEqual({ reset: false });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Value: protects=valid-state round trip; fails_when=loader
  // rejects what the validator accepts; why_new=Slice 5; seam=none.
  test("valid state loads", () => {
    const repo = tmpRepo();
    try {
      mkdirSync(join(repo, ".artifex"), { recursive: true });
      writeFileSync(join(repo, ".artifex", "floor-state.json"), JSON.stringify(validState()));
      const r = loadPersistedLayout(repo);
      expect(r.reset).toBe(false);
      expect(r.layout?.nextId).toBe(2);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Value: protects=corrupt/oversize quarantine to .bak;
  // fails_when=quarantine drops (re-crash loop) or renames outside
  // the repo through planted symlinks; why_new=Slice 5; seam=none.
  test("corrupt and oversize states reset via .bak", () => {
    const repo = tmpRepo();
    try {
      mkdirSync(join(repo, ".artifex"), { recursive: true });
      const file = join(repo, ".artifex", "floor-state.json");
      writeFileSync(file, "{not json");
      expect(loadPersistedLayout(repo).reset).toBe(true);
      expect(existsSync(`${file}.bak`)).toBe(true);
      expect(existsSync(file)).toBe(false);
      writeFileSync(file, "x".repeat(8 * 1024 * 1024 + 1));
      expect(loadPersistedLayout(repo).reset).toBe(true);
      expect(existsSync(`${file}.bak`)).toBe(true);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Value: protects=symlinked state FILE refused without renaming
  // outside the repo (dir variant covered by integration);
  // fails_when=the .bak rename follows the link (outside write);
  // why_new=Slice 5; seam=none.
  test("symlinked state file resets without touching outside", () => {
    const repo = tmpRepo();
    const outside = mkdtempSync(join(tmpdir(), "artifex-state-outside-"));
    try {
      mkdirSync(join(repo, ".artifex"), { recursive: true });
      const target = join(outside, "floor-state.json");
      writeFileSync(target, "{not json");
      symlinkSync(target, join(repo, ".artifex", "floor-state.json"));
      expect(loadPersistedLayout(repo).reset).toBe(true);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(`${target}.bak`)).toBe(false);
      expect(existsSync(join(repo, ".artifex", "floor-state.json.bak"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Value: protects=non-regular state refused; fails_when=a
  // directory/special at the state path is read or renamed;
  // why_new=Slice 5; seam=none.
  test("non-regular state file resets without rename", () => {
    const repo = tmpRepo();
    try {
      mkdirSync(join(repo, ".artifex", "floor-state.json"), { recursive: true });
      expect(loadPersistedLayout(repo).reset).toBe(true);
      expect(existsSync(join(repo, ".artifex", "floor-state.json.bak"))).toBe(false);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // NOTE (honest gap): the truncated-during-load race (file shrinks
  // between fstat and read) has no fault-injection point in the
  // synchronous loader — it stays unpinned rather than faked.
});

describe("line counters", () => {
  // Value: protects=line-band classification at file end (empty /
  // trailing-newline / unterminated); fails_when=off-by-one at EOF
  // (files land in the wrong size band); why_new=Slice 5; seam=none.
  test("empty, trailing-newline, and unterminated trio", async () => {
    const repo = tmpRepo();
    try {
      const f = (name: string, content: string) => {
        writeFileSync(join(repo, name), content);
        return join(repo, name);
      };
      expect(await countNewlines(f("empty", ""))).toBe(0);
      expect(await countNewlines(f("nl", "a\n"))).toBe(1);
      expect(await countNewlines(f("unterminated", "a"))).toBe(1);
      expect(await countNewlines(f("two-nl", "a\nb\n"))).toBe(2);
      expect(await countNewlines(f("two-unterminated", "a\nb"))).toBe(2);
      // Multi-chunk: 200k lines cross several 64 KiB stream chunks.
      expect(await countNewlines(f("big", "x\n".repeat(200_000)))).toBe(200_000);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  // Value: protects=in-memory line counting (same trio);
  // fails_when=buffer/stream counters disagree; why_new=Slice 5.
  test("countBufferLines matches the trio", () => {
    const enc = new TextEncoder();
    expect(countBufferLines(enc.encode(""))).toBe(0);
    expect(countBufferLines(enc.encode("a\n"))).toBe(1);
    expect(countBufferLines(enc.encode("a"))).toBe(1);
    expect(countBufferLines(enc.encode("a\nb\n"))).toBe(2);
    expect(countBufferLines(enc.encode("a\nb"))).toBe(2);
  });
});
