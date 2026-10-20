/**
 * Slice 6: server seams — context relevance, persist gate, and the
 * boot-window reconcile planner. Tables over synthetic inputs pin
 * the exact branch each production call relies on.
 */
import { describe, expect, test } from "bun:test";
import { affectsContext, planReconcile, shouldPersistLayout, stampRunUsage, syncReconcileBaseline } from "./index.ts";
import type { FileMeta as WatchFileMeta } from "../watcher/index.ts";
import type { RunRecord } from "../floor-ui/wire.ts";

const MAX = 8 * 1024 * 1024; // mirrors MAX_STATE_BYTES (read-side refusal)

function meta(dev: number, ino: number, size: number, mtimeMs: number): WatchFileMeta {
  return { dev, ino, size, mtimeMs };
}

describe("affectsContext", () => {
  // Value: protects=resolver-context rebuild triggers; fails_when=a
  // leg drops (stale aliases after a config edit) or widens
  // (rebuild storms on every __init__ touch); why_new=Slice 6.
  test("config content always counts; __init__.py only on existence flips", () => {
    for (const kind of ["created", "modified", "deleted"] as const) {
      expect(affectsContext({ kind, path: "package.json" })).toBe(true);
      expect(affectsContext({ kind, path: "pkg/tsconfig.json" })).toBe(true);
    }
    expect(affectsContext({ kind: "modified", path: "__init__.py" })).toBe(false);
    expect(affectsContext({ kind: "created", path: "__init__.py" })).toBe(true);
    expect(affectsContext({ kind: "deleted", path: "pkg/__init__.py" })).toBe(true);
    expect(affectsContext({ kind: "modified", path: "pkg/__init__.py" })).toBe(false);
    expect(affectsContext({ kind: "modified", path: "src/main.ts" })).toBe(false);
  });

  // Value: protects=rename context detection on both ends;
  // fails_when=one end unchecked (config renamed in silently);
  // why_new=Slice 6; seam=none.
  test("renames check both ends", () => {
    expect(affectsContext({ kind: "renamed", path: "b.json", fromPath: "package.json" })).toBe(true);
    expect(affectsContext({ kind: "renamed", path: "package.json", fromPath: "b.json" })).toBe(true);
    expect(affectsContext({ kind: "renamed", path: "pkg/__init__.py", fromPath: "x.py" })).toBe(true);
    expect(affectsContext({ kind: "renamed", path: "b.ts", fromPath: "a.ts" })).toBe(false);
  });

  // Value: protects=exact-basename matching; fails_when=substring
  // matching (every "*package.json*" backup triggers rebuilds);
  // why_new=Slice 6; seam=none.
  test("near-miss basenames do not count", () => {
    for (const p of ["package.json.bak", "my-package.json", "__init__.py2", "my__init__.py", "init__.py"]) {
      expect(affectsContext({ kind: "modified", path: p })).toBe(false);
    }
  });
});

describe("shouldPersistLayout", () => {
  // Value: protects=layout persistence within the read-side budget;
  // fails_when=byte/char confusion (a multibyte state fits chars,
  // busts bytes, then resets on every boot churning .bak);
  // why_new=Slice 6 (byte semantics pinned); seam=none.
  test("byte budget with multibyte edge", () => {
    expect(shouldPersistLayout("{}")).toBe(true);
    expect(shouldPersistLayout("x".repeat(MAX))).toBe(true);
    expect(shouldPersistLayout("x".repeat(MAX + 1))).toBe(false);
    // € is 3 bytes: 3M chars (under) but 9M bytes (over) → skip.
    expect(shouldPersistLayout("€".repeat(3 * 1024 * 1024))).toBe(false);
    expect(shouldPersistLayout("€".repeat(2 * 1024 * 1024))).toBe(true);
  });
});

describe("planReconcile", () => {
  // Value: protects=boot-window catch-up (changed between boot
  // reads and the baseline); fails_when=group 3 drops (edits in
  // the window never apply); why_new=Slice 6; seam=none.
  test("stale buildings vs a fresh baseline plan modifieds", () => {
    const fresh = meta(1, 1, 100, 2000);
    const plan = planReconcile(
      new Map([["b.ts", fresh]]),
      new Map([["b.ts", fresh]]),
      new Map([["b.ts", { mtimeMs: 1000, bytes: 100 }]]),
    );
    expect(plan.groups[0]).toEqual([]);
    expect(plan.groups[3]).toEqual([{ kind: "modified", path: "b.ts" }]);
  });

  // Value: protects=unreadable-at-boot retry + built-but-vanished
  // deletes; fails_when=either group drops (ghost/phantom
  // buildings); why_new=Slice 6; seam=none.
  test("unbuilt-on-disk retries as created; built-off-disk deletes", () => {
    const m = meta(1, 2, 50, 3000);
    const retry = planReconcile(new Map([["c.ts", m]]), new Map([["c.ts", m]]), new Map());
    expect(retry.groups[0]).toEqual([]);
    expect(retry.groups[2]).toEqual([{ kind: "created", path: "c.ts" }]);
    const gone = planReconcile(new Map(), new Map(), new Map([["d.ts", { mtimeMs: 1, bytes: 1 }]]));
    expect(gone.groups[1]).toEqual([{ kind: "deleted", path: "d.ts" }]);
  });

  // Value: protects=handled-set dedupe across groups (no double
  // apply); fails_when=dedupe drops (a diff change also fires as a
  // building-compare change); why_new=Slice 6; seam=none.
  test("diff output suppresses the building-compare groups", () => {
    const old = meta(1, 3, 100, 1000);
    const fresh = meta(1, 3, 100, 2000);
    const plan = planReconcile(
      new Map([["b.ts", old]]),
      new Map([["b.ts", fresh]]),
      new Map([["b.ts", { mtimeMs: 1000, bytes: 100 }]]),
    );
    expect(plan.groups[0]).toEqual([{ kind: "modified", path: "b.ts" }]);
    expect(plan.groups[1]).toEqual([]);
    expect(plan.groups[2]).toEqual([]);
    expect(plan.groups[3]).toEqual([]);
    expect(plan.handled).toEqual(new Set(["b.ts"]));
  });

  // Value: protects=rename handled-marking on both paths;
  // fails_when=fromPath unmarked (the old path also fires a group-1
  // delete); why_new=Slice 6; seam=none.
  test("renames mark both paths handled", () => {
    const m = meta(1, 9, 50, 5);
    const plan = planReconcile(new Map([["old.ts", m]]), new Map([["new.ts", m]]), new Map());
    expect(plan.groups[0]).toEqual([{ kind: "renamed", path: "new.ts", fromPath: "old.ts" }]);
    expect(plan.handled).toEqual(new Set(["new.ts", "old.ts"]));
    expect(plan.groups[1]).toEqual([]);
    expect(plan.groups[2]).toEqual([]);
  });

  // Value: protects=group order (diff, deletes, creates, modifies);
  // fails_when=order flips (later groups stop observing earlier
  // buildings); why_new=Slice 6; seam=none.
  test("groups run diff, deletes, creates, modifies in order", () => {
    const plan = planReconcile(
      new Map(),
      new Map([["n.ts", meta(1, 5, 10, 10)]]),
      new Map([["g.ts", { mtimeMs: 1, bytes: 1 }]]),
    );
    expect(plan.groups).toEqual([
      [{ kind: "created", path: "n.ts" }],
      [{ kind: "deleted", path: "g.ts" }],
      [],
      [],
    ]);
  });

  // Value: protects=steady-state no-op; fails_when=phantom changes
  // (needless rebuilds on every boot); why_new=Slice 6; seam=none.
  test("steady state plans nothing", () => {
    const m = meta(1, 7, 10, 10);
    const plan = planReconcile(
      new Map([["a.ts", m]]),
      new Map([["a.ts", m]]),
      new Map([["a.ts", { mtimeMs: 10, bytes: 10 }]]),
    );
    expect(plan.groups).toEqual([[], [], [], []]);
    expect(plan.handled.size).toBe(0);
  });
});

describe("syncReconcileBaseline", () => {
  // Value: protects=baseline rules (unbuilt stays out so later
  // readable states re-detect; handled-vanished clears; unhandled
  // stale waits for the watcher); fails_when=unbuilt enters the
  // baseline (retry path dies) or stale clears early (update lost);
  // why_new=Slice 6; seam=none.
  test("built syncs, unbuilt stays out, handled-vanished clears, stale waits", () => {
    const known = new Map([
      ["a.ts", meta(1, 1, 10, 1)],
      ["u.ts", meta(1, 2, 10, 1)],
      ["h.ts", meta(1, 3, 10, 1)],
      ["s.ts", meta(1, 4, 10, 1)],
    ]);
    const current = new Map([
      ["a.ts", meta(1, 1, 10, 2)],
      ["u.ts", meta(1, 2, 10, 2)],
    ]);
    syncReconcileBaseline(known, current, new Map([["a.ts", {}]]), new Set(["h.ts"]));
    // Built + current: synced to the fresh meta.
    expect(known.get("a.ts")).toEqual(meta(1, 1, 10, 2));
    // Current but unbuilt: out of the baseline (retry as created).
    expect(known.has("u.ts")).toBe(false);
    // Handled but vanished: cleared.
    expect(known.has("h.ts")).toBe(false);
    // Unhandled stale: left for the watcher's fresher updates.
    expect(known.get("s.ts")).toEqual(meta(1, 4, 10, 1));
  });
});

describe("stampRunUsage", () => {
  const live = (): RunRecord[] => [{
    id: "p1",
    sessionId: "s1",
    prompt: "do it",
    startedAt: 1000,
    state: "running",
  }];

  // Value: protects=usage accumulation onto the live run (reports
  // land on the ledger, partial reports merge direction by
  // direction); fails_when=a report is lost or wipes a sibling
  // direction; why_new=run cost readout.
  test("reports accumulate onto the running run, merging partial directions", () => {
    const runs = live();
    expect(stampRunUsage(runs, "p1", { inputTokens: 100 })).toBe(true);
    expect(runs[0]!.usage).toEqual({ inputTokens: 100 });
    expect(stampRunUsage(runs, "p1", { outputTokens: 40 })).toBe(true);
    expect(runs[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
    expect(stampRunUsage(runs, "p1", { totalTokens: 140 })).toBe(true);
    expect(runs[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 40, totalTokens: 140 });
  });

  // Value: protects=monotonic counters (usage lines are
  // cumulative, so a lower re-delivery must not shrink a total);
  // fails_when=duplicates or reordered lines move a total down.
  test("accumulation is monotonic per field", () => {
    const runs = live();
    expect(stampRunUsage(runs, "p1", { inputTokens: 100, outputTokens: 40 })).toBe(true);
    // Lower re-delivery: ignored, totals hold.
    expect(stampRunUsage(runs, "p1", { inputTokens: 50, outputTokens: 40 })).toBe(true);
    expect(runs[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
    // Mixed: the greater direction moves, the lower holds.
    expect(stampRunUsage(runs, "p1", { inputTokens: 90, outputTokens: 60 })).toBe(true);
    expect(runs[0]!.usage).toEqual({ inputTokens: 100, outputTokens: 60 });
  });

  // Value: protects=post-terminal and stale-plan silence (late
  // usage lines must not resurrect or invent ledger state);
  // fails_when=a usage line lands on a finished run or a run that
  // never existed.
  test("stale plan ids and post-terminal lines stamp nothing", () => {
    const runs = live();
    expect(stampRunUsage(runs, "nope", { inputTokens: 100 })).toBe(false);
    expect(runs[0]!.usage).toBeUndefined();
    runs[0]!.state = "done";
    runs[0]!.endedAt = 2000;
    expect(stampRunUsage(runs, "p1", { inputTokens: 100 })).toBe(false);
    expect(runs[0]!.usage).toBeUndefined();
  });
});
