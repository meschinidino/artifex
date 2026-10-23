import { describe, expect, test } from "bun:test";
import type { ToasterProof } from "../server/toaster-proof.ts";
import {
  applyPatch,
  applySnapshot,
  computeCongested,
  createClientState,
  isCountsOnlyChange,
  pairIncidentToPath,
  resolveEdgePair,
  WIRE_VERSION,
  type BeltEdge,
  type Building,
  type PatchMessage,
  type RemovedMark,
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
  ghosts: [],
  agent: { agentId: "muse", state: "idle" },
  runs: [],
  notes: [],
  removed: [],
  removedUnplotted: [],
  footAvailable: [],
  hasLessonsSection: false,
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

  // Value: protects=ghost/agent wire semantics (snapshot loads
  // them, patch replaces only when present); fails_when=a ghost
  // patch wipes state or an agent-only patch is dropped.
  test("ghosts and agent apply on snapshot and replace on patch only when present", () => {
    const state = createClientState();
    applySnapshot(state, {
      ...snap,
      ghosts: [{ path: "src/new.ts", zoneId: "src", x: 0, y: 0, state: "planned", step: "Create src/new.ts" }],
      agent: { agentId: "muse", state: "working", step: "Create src/new.ts" },
    });
    expect(state.ghosts.get("src/new.ts")?.state).toBe("planned");
    expect(state.agent.state).toBe("working");
    // A patch without ghosts/agent keeps the previous values.
    expect(applyPatch(state, patch({}))).toBe("applied");
    expect(state.ghosts.size).toBe(1);
    expect(state.agent.state).toBe("working");
    // Present-but-empty replaces (solidify clears the set).
    expect(
      applyPatch(state, patch({ stateVersion: 3, ghosts: [], agent: { agentId: "muse", state: "done" } })),
    ).toBe("applied");
    expect(state.ghosts.size).toBe(0);
    expect(state.agent.state).toBe("done");
  });

  // Value: protects=why-note wire semantics (snapshot loads them,
  // patch replaces only when present); fails_when=a notes patch is
  // dropped or a noteless patch wipes the inspector's Why section.
  test("notes apply on snapshot and replace on patch only when present", () => {
    const state = createClientState();
    expect(state.notes).toEqual([]);
    applySnapshot(state, { ...snap, notes: [{ path: "src/a.ts", note: "why", ts: 100, agentId: "muse" }] });
    expect(state.notes).toEqual([{ path: "src/a.ts", note: "why", ts: 100, agentId: "muse" }]);
    // A patch without notes keeps the previous list.
    expect(applyPatch(state, patch({}))).toBe("applied");
    expect(state.notes.length).toBe(1);
    // A patch with notes replaces wholesale.
    expect(applyPatch(state, patch({ stateVersion: 3, notes: [] }))).toBe("applied");
    expect(state.notes).toEqual([]);
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

describe("footprint wire (change-footprint overlays)", () => {
  const mark = (path: string): RemovedMark => ({ path, zoneId: "src", x: 0, y: 40, band: 0 });

  // Value: protects=the additive wire contract (footprint fields
  // ride v1, both sides ship together); fails_when=a change bumps
  // the version (needless resync storms) or drops the pin.
  test("WIRE_VERSION stays 1", () => {
    expect(WIRE_VERSION).toBe(1);
  });

  // Value: protects=removed/unplotted/availability apply on
  // snapshot and replace on patch only when present;
  // fails_when=a foot-only patch wipes the marks, or a mark
  // patch is dropped (GONE markers stick or vanish wrongly).
  test("removed sets apply on snapshot and replace on patch only when present", () => {
    const state = createClientState();
    expect(state.removed.size).toBe(0);
    expect(state.removedUnplotted).toEqual([]);
    expect(state.footAvailable).toEqual([]);
    applySnapshot(state, {
      ...snap,
      removed: [mark("src/gone.ts")],
      removedUnplotted: ["src/early.ts"],
      footAvailable: [""],
    });
    expect(state.removed.get("src/gone.ts")).toEqual(mark("src/gone.ts"));
    expect(state.removedUnplotted).toEqual(["src/early.ts"]);
    expect(state.footAvailable).toEqual([""]);
    // A patch without footprint fields keeps the previous values.
    expect(applyPatch(state, patch({}))).toBe("applied");
    expect(state.removed.size).toBe(1);
    expect(state.removedUnplotted).toEqual(["src/early.ts"]);
    expect(state.footAvailable).toEqual([""]);
    // Present-but-empty replaces (commit clears the sets).
    expect(
      applyPatch(state, patch({ stateVersion: 3, removedMarks: [], removedUnplotted: [], footAvailable: [""] })),
    ).toBe("applied");
    expect(state.removed.size).toBe(0);
    expect(state.removedUnplotted).toEqual([]);
    expect(state.footAvailable).toEqual([""]);
  });

  // Value: protects=gap resync carrying the footprint sets (a
  // client that missed patches heals marks + availability from
  // the snapshot); fails_when=resync drops them (stale GONE
  // markers or a stuck unknown strip after reconnect).
  test("a resync snapshot after a gap carries marks and availability", () => {
    const state = createClientState();
    applySnapshot(state, snap);
    expect(applyPatch(state, patch({ stateVersion: 99 }))).toBe("gap");
    applySnapshot(state, {
      ...snap,
      stateVersion: 99,
      removed: [mark("src/gone.ts")],
      removedUnplotted: ["src/early.ts"],
      footAvailable: [""],
    });
    expect(state.version).toBe(99);
    expect(state.removed.has("src/gone.ts")).toBe(true);
    expect(state.removedUnplotted).toEqual(["src/early.ts"]);
    expect(state.footAvailable).toEqual([""]);
    expect(applyPatch(state, patch({ stateVersion: 100 }))).toBe("applied");
  });

  // Value: protects=FR13 (a foot-only upsert is not an edit: no
  // pulse, no last-change line, no preview re-request — the file
  // did not change, only its HEAD-relative status did);
  // fails_when=foot punches through (every status re-read pulses
  // the floor) or masks real edits (foot + content change reads
  // as counts-only).
  test("foot-only upserts are counts-only; foot plus content is not", () => {
    const prev = building("b1", "src/a.ts");
    expect(isCountsOnlyChange(prev, { ...prev, foot: "added" })).toBe(true);
    expect(isCountsOnlyChange({ ...prev, foot: "added" }, { ...prev, foot: "modified" })).toBe(true);
    expect(isCountsOnlyChange({ ...prev, foot: "modified" }, { ...prev })).toBe(true);
    expect(isCountsOnlyChange(prev, { ...prev, foot: "added", mtimeMs: 9 })).toBe(false);
    expect(isCountsOnlyChange(prev, { ...prev, foot: "modified", lines: 2 })).toBe(false);
  });
});

describe("belt-click pair resolution (BCR4)", () => {
  const buildings = [building("b1", "src/a.ts"), building("b2", "src/b.ts"), building("b3", "src/c.ts")];
  const byPath = new Map(buildings.map((b) => [b.path, b]));

  // Value: protects=the edge card's endpoint + evidence lookup;
  // fails_when=id resolution or pair filtering breaks;
  // why_new=belt-click BCR4.
  test("resolves paths and the pair's edges in snapshot order", () => {
    const belts: BeltEdge[] = [
      { fromId: "b3", toId: "b2" },
      { fromId: "b1", toId: "b2", via: ["line 1", "line 3"] },
      { fromId: "b1", toId: "b2", kind: "http", via: ["GET /x — line 4"] },
    ];
    expect(resolveEdgePair(belts, byPath, "b1", "b2")).toEqual({
      fromPath: "src/a.ts",
      toPath: "src/b.ts",
      edges: [belts[1], belts[2]],
      gone: false,
    });
  });

  test("accepts a building array as well as the path map", () => {
    expect(resolveEdgePair([{ fromId: "b1", toId: "b2" }], buildings, "b1", "b2")?.fromPath).toBe("src/a.ts");
  });

  test("zero edges resolves to a gone card, never undefined", () => {
    expect(resolveEdgePair([{ fromId: "b3", toId: "b2" }], byPath, "b1", "b2")).toEqual({
      fromPath: "src/a.ts",
      toPath: "src/b.ts",
      edges: [],
      gone: true,
    });
  });

  test("unresolvable endpoint ids clear the selection", () => {
    const belts: BeltEdge[] = [{ fromId: "b1", toId: "b2" }];
    expect(resolveEdgePair(belts, byPath, "b1", "bX")).toBeUndefined();
    expect(resolveEdgePair(belts, byPath, "bX", "b2")).toBeUndefined();
  });

  // Value: protects=the incident predicate behind BCR5 (a belt of
  // the selected machine keeps it); fails_when=either endpoint
  // stops matching or unknown paths match; why_new=belt-click.
  test("pair incident touches either endpoint path only", () => {
    expect(pairIncidentToPath(byPath, "b1", "b2", "src/a.ts")).toBe(true);
    expect(pairIncidentToPath(byPath, "b1", "b2", "src/b.ts")).toBe(true);
    expect(pairIncidentToPath(byPath, "b1", "b2", "src/c.ts")).toBe(false);
    expect(pairIncidentToPath(byPath, "b1", "b2", "src/missing.ts")).toBe(false);
    expect(pairIncidentToPath(buildings, "b3", "b2", "src/c.ts")).toBe(true);
  });
});

describe("toaster wire (T3 panel proofs)", () => {
  // Value: protects=the panel's data path (frozen proofs ride the
  // snapshot, replace wholesale on patch, default empty so old
  // snapshots show the empty bay); fails_when=the fields drop or
  // stop replacing (panel shows stale or missing proofs).
  const proof: ToasterProof = {
    schema: "toaster-gate-1",
    env: "homologacion",
    stub: false,
    ranAt: "2026-10-23T15:03:23.326Z",
    cuitMasked: "20•••••••9",
    voucher: { ptoVta: 1, cbteTipo: 11, cbteDesde: 2, cbteHasta: 2, impTotal: 1000, monId: "PES" },
    cae: "86431019567246",
    caeFchVto: "20261102",
    resultado: "A",
    reproceso: "N",
    obs: [],
    errors: [],
    latencyMs: { status: 247, voucher: 134 },
  };

  test("toaster defaults empty; snapshot carries proofs + recorded flag", () => {
    const state = createClientState();
    expect(state.toaster).toEqual([]);
    expect(state.toasterRecorded).toBe(false);
    applySnapshot(state, snap);
    expect(state.toaster).toEqual([]);
    applySnapshot(state, { ...snap, toaster: [proof], toasterRecorded: true });
    expect(state.toaster).toEqual([proof]);
    expect(state.toasterRecorded).toBe(true);
  });

  test("patch replaces toaster wholesale; absent leaves it untouched", () => {
    const state = createClientState();
    applySnapshot(state, { ...snap, toaster: [proof], toasterRecorded: true });
    expect(applyPatch(state, patch({}))).toBe("applied");
    expect(state.toaster).toEqual([proof]);
    expect(applyPatch(state, patch({ stateVersion: 3, toaster: [], toasterRecorded: false }))).toBe("applied");
    expect(state.toaster).toEqual([]);
    expect(state.toasterRecorded).toBe(false);
  });
});

describe("write-back wire (instruction write-back)", () => {
  // Value: protects=the preview's header decision (the snapshot
  // tells the client whether the section exists, so the header
  // shows iff the file lacks it); fails_when=the flag drops from
  // the snapshot (previews lie about the header).
  test("hasLessonsSection defaults false and rides the snapshot", () => {
    const state = createClientState();
    expect(state.hasLessonsSection).toBe(false);
    applySnapshot(state, { ...snap, hasLessonsSection: true });
    expect(state.hasLessonsSection).toBe(true);
    applySnapshot(state, { ...snap, hasLessonsSection: false });
    expect(state.hasLessonsSection).toBe(false);
  });
});
