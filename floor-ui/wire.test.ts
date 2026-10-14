import { describe, expect, test } from "bun:test";
import {
  applyPatch,
  applySnapshot,
  computeCongested,
  createClientState,
  isCountsOnlyChange,
  type Building,
  type PatchMessage,
  type SnapshotMessage,
} from "./wire.ts";

const building = (id: string, path: string): Building => ({
  id,
  path,
  zoneId: "src",
  x: 0,
  y: 40,
  band: 0,
  lines: 1,
  bytes: 2,
  mtimeMs: 0,
  binary: false,
  parse: "ok",
  unresolvedCount: 0,
});

const zone = { id: "src", name: "src", x: -12, y: 0, w: 120, h: 148, fileCount: 2 };

const snap: SnapshotMessage = {
  v: 1,
  type: "snapshot",
  stateVersion: 1,
  repo: "repo",
  zones: [zone],
  buildings: [building("b1", "src/a.ts"), building("b2", "src/b.ts")],
  belts: [{ fromId: "b1", toId: "b2" }],
  total: 2,
  watcher: "watching",
};

const patch = (over: Partial<PatchMessage>): PatchMessage => ({
  v: 1,
  type: "patch",
  stateVersion: 2,
  upsert: [],
  remove: [],
  rename: [],
  zones: [zone],
  total: 2,
  watcher: "watching",
  ...over,
});

describe("wire sequencing", () => {
  test("snapshot then sequential patch applies remove/rename/upsert in order", () => {
    const state = createClientState();
    applySnapshot(state, snap);
    const moved = { ...building("b1", "src/a2.ts"), lines: 5 };
    const result = applyPatch(state, patch({
      rename: [{ id: "b1", from: "src/a.ts", to: "src/a2.ts" }],
      upsert: [moved],
      remove: ["b2"],
      total: 1,
    }));
    expect(result).toBe("applied");
    expect(state.version).toBe(2);
    expect(state.buildings.has("src/a.ts")).toBe(false);
    expect(state.buildings.get("src/a2.ts")?.lines).toBe(5);
    expect(state.buildings.has("src/b.ts")).toBe(false);
    expect(state.total).toBe(1);
  });

  test("version gap is dropped, state untouched", () => {
    const state = createClientState();
    applySnapshot(state, snap);
    const result = applyPatch(state, patch({ stateVersion: 5, remove: ["b1"] }));
    expect(result).toBe("gap");
    expect(state.version).toBe(1);
    expect(state.buildings.size).toBe(2);
    // A resync snapshot at the server version heals the gap.
    applySnapshot(state, { ...snap, stateVersion: 5 });
    expect(state.version).toBe(5);
    expect(applyPatch(state, patch({ stateVersion: 6 }))).toBe("applied");
  });

  test("belts ride the snapshot and replace wholesale on patch", () => {
    const state = createClientState();
    applySnapshot(state, snap);
    expect(state.belts).toEqual([{ fromId: "b1", toId: "b2" }]);
    // A patch without belts leaves the set untouched.
    expect(applyPatch(state, patch({}))).toBe("applied");
    expect(state.belts).toEqual([{ fromId: "b1", toId: "b2" }]);
    // A patch with belts replaces it (rename keeps ids, so a pure
    // rename patch carries no belt update at all).
    expect(applyPatch(state, patch({ stateVersion: 3, belts: [] }))).toBe("applied");
    expect(state.belts).toEqual([]);
  });
});

describe("belt client helpers (review regression)", () => {
  test("congestion is the top decile with an absolute floor", () => {
    // Sparse graph: every in-degree 1 flags nothing.
    expect(computeCongested(new Map([["a", 1], ["b", 1], ["c", 1]]))).toEqual(new Set());
    expect(computeCongested(new Map())).toEqual(new Set());
    // A real hub still flags while leaves do not.
    const inDegree = new Map<string, number>([["hub", 12]]);
    for (let i = 0; i < 20; i++) inDegree.set(`leaf${i}`, 1);
    expect(computeCongested(inDegree)).toEqual(new Set(["hub"]));
    // Below the floor, even the top decile stays quiet.
    expect(computeCongested(new Map([["a", 2], ["b", 1]]))).toEqual(new Set());
  });

  test("counts-only detection ignores the unresolved count alone", () => {
    const prev = building("b1", "src/a.ts");
    expect(isCountsOnlyChange(undefined, prev)).toBe(false);
    expect(isCountsOnlyChange(prev, { ...prev })).toBe(true);
    expect(isCountsOnlyChange(prev, { ...prev, unresolvedCount: 3 })).toBe(true);
    expect(isCountsOnlyChange(prev, { ...prev, mtimeMs: 5 })).toBe(false);
    expect(isCountsOnlyChange(prev, { ...prev, x: 96 })).toBe(false);
    expect(isCountsOnlyChange(prev, { ...prev, parse: "error", parseError: "parse error" })).toBe(false);
    // Key order over the wire must not matter.
    const reordered = JSON.parse(JSON.stringify({ ...prev, unresolvedCount: 1 })) as Building;
    expect(isCountsOnlyChange(prev, reordered)).toBe(true);
  });
});
