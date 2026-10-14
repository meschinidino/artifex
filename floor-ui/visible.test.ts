import { describe, expect, test } from "bun:test";
import type { ZoneRect } from "./layout.ts";
import { computeVisible, MAX_BLOCKS } from "./visible.ts";
import type { Building } from "./wire.ts";

function zone(id: string, fileCount = 0): ZoneRect {
  return { id, name: id, x: 0, y: 0, w: 100, h: 100, fileCount };
}

function b(path: string, zoneId: string, y: number): Building {
  return {
    id: `id-${path}`,
    path,
    zoneId,
    x: 0,
    y,
    band: 0,
    lines: 1,
    bytes: 10,
    mtimeMs: 0,
    binary: false,
    parse: "unparsed",
    unresolvedCount: 0,
  };
}

function megaZone(n: number): { zones: ZoneRect[]; buildings: Building[] } {
  return {
    zones: [zone("src", n)],
    buildings: Array.from({ length: n }, (_, i) => b(`src/f${i}.ts`, "src", i * 96)),
  };
}

describe("computeVisible", () => {
  test("small floors render fully with no hidden counts", () => {
    const { zones, buildings } = megaZone(10);
    const v = computeVisible({ zones, buildings, expanded: new Set(["src"]) });
    expect(v.buildings.length).toBe(10);
    expect(v.count).toBe(10);
    expect(v.hiddenByZone.size).toBe(0);
  });

  test("the cut keeps the first 1,000 in slot order and reports the rest", () => {
    const { zones, buildings } = megaZone(MAX_BLOCKS + 5);
    const v = computeVisible({ zones, buildings, expanded: new Set(["src"]) });
    expect(v.buildings.length).toBe(MAX_BLOCKS);
    expect(v.buildings.at(-1)?.path).toBe(`src/f${MAX_BLOCKS - 1}.ts`);
    expect(v.count).toBe(MAX_BLOCKS);
    expect(v.hiddenByZone.get("src")).toBe(5);
  });

  test("a collapsed zone costs one block and reports nothing hidden", () => {
    const { zones, buildings } = megaZone(10);
    const v = computeVisible({ zones, buildings, expanded: new Set() });
    expect(v.buildings.length).toBe(0);
    expect(v.count).toBe(1);
    expect(v.hiddenByZone.size).toBe(0);
  });

  test("selection past the cut renders as the one exempted block", () => {
    const { zones, buildings } = megaZone(MAX_BLOCKS + 5);
    const v = computeVisible({
      zones,
      buildings,
      expanded: new Set(["src"]),
      selectedPath: `src/f${MAX_BLOCKS + 4}.ts`,
    });
    expect(v.buildings.length).toBe(MAX_BLOCKS + 1);
    expect(v.buildings.at(-1)?.path).toBe(`src/f${MAX_BLOCKS + 4}.ts`);
    expect(v.count).toBe(MAX_BLOCKS + 1);
    expect(v.hiddenByZone.get("src")).toBe(4);
  });

  test("selection inside the cut changes nothing", () => {
    const { zones, buildings } = megaZone(MAX_BLOCKS + 5);
    const v = computeVisible({
      zones,
      buildings,
      expanded: new Set(["src"]),
      selectedPath: "src/f3.ts",
    });
    expect(v.buildings.length).toBe(MAX_BLOCKS);
    expect(v.count).toBe(MAX_BLOCKS);
    expect(v.hiddenByZone.get("src")).toBe(5);
  });

  test("selection in a collapsed zone stays hidden (no lone machine on a pad)", () => {
    const { zones, buildings } = megaZone(10);
    const v = computeVisible({ zones, buildings, expanded: new Set(), selectedPath: "src/f3.ts" });
    expect(v.buildings.length).toBe(0);
    expect(v.count).toBe(1);
  });

  test("selection in an expanded zone past an exhausted budget still renders", () => {
    const zones = [zone("a", 1), zone("b", 2)];
    const buildings = [
      ...Array.from({ length: MAX_BLOCKS }, (_, i) => b(`a/f${i}.ts`, "a", i * 96)),
      b("b/target.ts", "b", 0),
      b("b/other.ts", "b", 96),
    ];
    const v = computeVisible({
      zones,
      buildings,
      expanded: new Set(["a", "b"]),
      selectedPath: "b/target.ts",
    });
    expect(v.zones.map((z) => z.id)).toEqual(["a", "b"]);
    expect(v.buildings.some((x) => x.path === "b/target.ts")).toBe(true);
    expect(v.count).toBe(MAX_BLOCKS + 1);
    // The late-added pad still reports its cut honestly (review R1).
    expect(v.hiddenByZone.get("b")).toBe(1);
  });
});
