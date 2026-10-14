import { describe, expect, test } from "bun:test";
import {
  assignBuilding,
  bandForFile,
  createFloorLayout,
  layoutFloor,
  removeBuilding,
  renameBuilding,
  zoneOf,
  zoneRects,
} from "./layout.ts";

const files = [
  "src/a.ts",
  "src/b.ts",
  "src/deep/c.ts",
  "lib/d.py",
  "README.md",
];

describe("layout", () => {
  test("bands: stepped lines, bytes for binary", () => {
    expect(bandForFile(10, 500, false)).toBe(0);
    expect(bandForFile(100, 500, false)).toBe(1);
    expect(bandForFile(1999, 500, false)).toBe(2);
    expect(bandForFile(2000, 500, false)).toBe(3);
    expect(bandForFile(0, 9_999, true)).toBe(0);
    expect(bandForFile(0, 100_000, true)).toBe(2);
    expect(bandForFile(0, 5_000_000, true)).toBe(3);
  });

  test("zoneOf uses top-level folder", () => {
    expect(zoneOf("src/deep/c.ts")).toBe("src");
    expect(zoneOf("README.md")).toBe("(root)");
  });

  test("bulk layout is deterministic regardless of input order", () => {
    const a = layoutFloor(files);
    const b = layoutFloor([...files].reverse());
    expect(b.buildings).toEqual(a.buildings);
    expect(b.zones).toEqual(a.zones);
    // Zones ordered by name: (root) < lib < src in code-point order.
    const rects = zoneRects(a);
    expect(rects.map((r) => r.name)).toEqual(["(root)", "lib", "src"]);
    expect(rects.find((r) => r.name === "src")?.fileCount).toBe(3);
  });

  test("append never moves existing buildings; delete leaves a gap", () => {
    const layout = layoutFloor(files);
    const before = JSON.parse(JSON.stringify(layout.buildings));
    const placed = assignBuilding(layout, "src/new.ts");
    expect(placed.slot).toBe(3);
    for (const [p, b] of Object.entries(before)) {
      expect(layout.buildings[p]).toEqual(b as never);
    }
    removeBuilding(layout, "src/b.ts");
    const afterGap = assignBuilding(layout, "src/another.ts");
    // Gap at slot 1 stays empty; cursor keeps appending.
    expect(afterGap.slot).toBe(4);
    expect(Object.values(layout.buildings).some((b) => b.slot === 1 && b.zoneId === "src")).toBe(false);
  });

  test("band growth is not a layout event: coordinates keyed by slot", () => {
    const layout = layoutFloor(files);
    const a = layout.buildings["src/a.ts"]!;
    // Re-assigning (e.g. after a modify that crosses a band) is a no-op.
    const again = assignBuilding(layout, "src/a.ts");
    expect(again).toEqual(a);
  });

  test("prototype-key folder and file names are plain data (review regression)", () => {
    const layout = layoutFloor(["constructor/a.ts", "__proto__/b.ts", "toString/c.ts", "__proto__"]);
    for (const path of ["constructor/a.ts", "__proto__/b.ts", "toString/c.ts", "__proto__"]) {
      const b = layout.buildings[path];
      expect(b).toBeDefined();
      expect(Number.isFinite(b!.x) && Number.isFinite(b!.y)).toBe(true);
    }
    expect(Object.hasOwn(layout.buildings, "__proto__")).toBe(true);
    const rects = zoneRects(layout);
    expect(rects.map((r) => r.name)).toContain("constructor");
    expect(rects.map((r) => r.name)).toContain("__proto__");
    expect(rects.every((r) => Number.isFinite(r.w) && Number.isFinite(r.h))).toBe(true);
  });

  test("rename keeps id and slot in-zone; cross-zone takes append slot", () => {
    const layout = createFloorLayout();
    const a = assignBuilding(layout, "src/a.ts", { zoneInitialCount: 4 });
    assignBuilding(layout, "src/b.ts");
    const same = renameBuilding(layout, "src/a.ts", "src/a2.ts")!;
    expect(same.id).toBe(a.id);
    expect(same.slot).toBe(a.slot);
    const cross = renameBuilding(layout, "src/a2.ts", "lib/a2.ts")!;
    expect(cross.id).toBe(a.id);
    expect(cross.zoneId).toBe("lib");
    expect(cross.slot).toBe(0);
    expect(layout.buildings["src/a.ts"]).toBeUndefined();
  });

  test("cross-zone rename into a new zone sizes columns from the batch count", () => {
    const layout = createFloorLayout();
    assignBuilding(layout, "src/a.ts", { zoneInitialCount: 1 });
    renameBuilding(layout, "src/a.ts", "fresh/a.ts", { zoneInitialCount: 25 });
    expect(layout.zones.fresh?.cols).toBe(5);
  });

  test("rename onto an occupied path evicts the occupant (review regression)", () => {
    const layout = createFloorLayout();
    const a = assignBuilding(layout, "src/a.ts", { zoneInitialCount: 4 });
    const b = assignBuilding(layout, "src/b.ts");
    const moved = renameBuilding(layout, "src/a.ts", "src/b.ts")!;
    // The target holds the mover, not a merged occupant.
    expect(moved.id).toBe(a.id);
    expect(layout.buildings["src/b.ts"]?.id).toBe(a.id);
    expect(layout.buildings["src/a.ts"]).toBeUndefined();
    // The evicted occupant is reassigned fresh on its next touch,
    // never silently keeping the mover's slot.
    const again = assignBuilding(layout, "src/c.ts");
    expect(again.id).not.toBe(b.id);
    expect(again.id).not.toBe(a.id);
  });
});
