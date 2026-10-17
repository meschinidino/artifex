/**
 * Slice 4: patch-feed decisions. Tables over synthetic patches —
 * every precedence pair in the orders that matter, eviction by
 * start-time, pulse identity across renames.
 */
import { describe, expect, test } from "bun:test";
import { evictOldest, FEED_CAP, planPatch, type FadeEntry } from "./feed.ts";
import type { Building } from "./wire.ts";

function building(over: Partial<Building> = {}): Building {
  return {
    id: "a",
    path: "a.ts",
    zoneId: "z",
    x: 0,
    y: 0,
    band: 0,
    lines: 10,
    bytes: 100,
    mtimeMs: 1000,
    binary: false,
    parse: "ok",
    unresolvedCount: 0,
    ...over,
  };
}

const A = building({ id: "a", path: "a.ts" });
const B = building({ id: "b", path: "b.ts" });

function maps() {
  return { pulses: new Map<string, number>(), fading: new Map<string, FadeEntry>() };
}

describe("planPatch precedence", () => {
  // Value: protects=last-change line naming the latest phase
  // (remove < rename < upsert); fails_when=phase order flips (a
  // delete reported after its replacement upserted); why_new=Slice 4.
  test("upsert beats rename beats remove; last writer wins in-phase", () => {
    const pre = new Map([["a.ts", A]]);
    const { pulses, fading } = maps();
    const full = planPatch(
      { remove: ["a"], rename: [{ id: "b", from: "x.ts", to: "y.ts" }], upsert: [B], belts: undefined },
      pre,
      pulses,
      fading,
      undefined,
      true,
      5000,
    );
    expect(full.changeText).toBe("b.ts");
    expect(full.followTarget).toBe("b.ts");

    const pair = (m: Parameters<typeof planPatch>[0]) =>
      planPatch(m, pre, new Map(), new Map(), undefined, true, 5000).changeText;
    // Each precedence pair, both orders of appearance in the message
    // (the code phases are fixed; message order must not matter).
    expect(pair({ remove: ["a"], rename: [{ id: "b", from: "x.ts", to: "y.ts" }], upsert: [] })).toBe("x.ts → y.ts");
    expect(pair({ remove: [], rename: [{ id: "b", from: "x.ts", to: "y.ts" }], upsert: [B] })).toBe("b.ts");
    expect(pair({ remove: ["a"], rename: [], upsert: [B] })).toBe("b.ts");
    // Last writer wins inside a phase.
    expect(pair({ remove: ["a", "zzz", "a"], rename: [], upsert: [] })).toBe("a.ts deleted");
    expect(
      pair({
        remove: [],
        rename: [
          { id: "1", from: "m.ts", to: "n.ts" },
          { id: "2", from: "p.ts", to: "q.ts" },
        ],
        upsert: [],
      }),
    ).toBe("p.ts → q.ts");
  });

  // Value: protects=follow clearing on deletes (nothing to center
  // on); fails_when=removes set a follow target (camera centers a
  // ghost); why_new=Slice 4; seam=none.
  test("remove-only patches clear the follow target", () => {
    const pre = new Map([["a.ts", A]]);
    const p = planPatch({ remove: ["a"], rename: [], upsert: [] }, pre, new Map(), new Map(), undefined, true, 1);
    expect(p.changeText).toBe("a.ts deleted");
    expect(p.followTarget).toBeUndefined();
    expect([...pre.keys()]).toEqual(["a.ts"]);
  });

  // Value: protects=unknown remove ids ignored; fails_when=a phantom
  // id names a change line for a file that isn't there; why_new=Slice 4.
  test("unknown remove ids and empty patches name nothing", () => {
    const pre = new Map([["a.ts", A]]);
    const p = planPatch({ remove: ["ghost"], rename: [], upsert: [] }, pre, new Map(), new Map(), undefined, true, 1);
    expect(p.changeText).toBeUndefined();
    expect(p.followTarget).toBeUndefined();
    const e = planPatch({ remove: [], rename: [], upsert: [] }, pre, new Map(), new Map(), undefined, true, 1);
    expect(e).toMatchObject({ changeText: undefined, followTarget: undefined, showedSelected: false });
  });
});

describe("planPatch selection + pulses", () => {
  // Value: protects=selection tracking across renames (incl. chains);
  // fails_when=retargeting drops (inspector shows the old path) or
  // chains stop after one hop; why_new=Slice 4; seam=none.
  test("renames retarget the selection through chains", () => {
    const pre = new Map<string, Building>();
    const m = { pulses: new Map<string, number>(), fading: new Map<string, FadeEntry>() };
    const one = planPatch(
      { remove: [], rename: [{ id: "1", from: "a.ts", to: "b.ts" }], upsert: [] },
      pre,
      m.pulses,
      m.fading,
      "a.ts",
      true,
      1,
    );
    expect(one.selectedPath).toBe("b.ts");
    expect(one.followTarget).toBe("b.ts");
    const chained = planPatch(
      {
        remove: [],
        rename: [
          { id: "1", from: "a.ts", to: "b.ts" },
          { id: "1", from: "b.ts", to: "c.ts" },
        ],
        upsert: [],
      },
      pre,
      new Map(),
      new Map(),
      "a.ts",
      true,
      1,
    );
    expect(chained.selectedPath).toBe("c.ts");
    const kept = planPatch(
      { remove: [], rename: [{ id: "9", from: "x.ts", to: "y.ts" }], upsert: [] },
      pre,
      new Map(),
      new Map(),
      "a.ts",
      true,
      1,
    );
    expect(kept.selectedPath).toBe("a.ts");
  });

  // Value: protects=pulse identity across renames (no fresh flash,
  // no lost flash); fails_when=carry drops (fresh full flash) or
  // restamps (flash restarts); why_new=Slice 4; seam=none.
  test("rename carries the pulse timestamp untouched", () => {
    const pre = new Map<string, Building>();
    const pulses = new Map([["a.ts", 1234]]);
    planPatch(
      { remove: [], rename: [{ id: "1", from: "a.ts", to: "b.ts" }], upsert: [] },
      pre,
      pulses,
      new Map(),
      undefined,
      true,
      9999,
    );
    expect(pulses.get("a.ts")).toBeUndefined();
    expect(pulses.get("b.ts")).toBe(1234);
  });

  // Value: protects=counts-only skip (belt refreshes don't flash);
  // fails_when=the skip drops (every belt flush strobes pulses) or
  // overmatches (real edits go silent); why_new=Slice 4; seam=none.
  test("counts-only upserts refresh without pulsing; new files always pulse", () => {
    const prev = building({ unresolvedCount: 0 });
    const same = building({ unresolvedCount: 5 });
    const pre = new Map([["a.ts", prev]]);
    const { pulses, fading } = maps();
    const c = planPatch({ remove: [], rename: [], upsert: [same] }, pre, pulses, fading, "a.ts", true, 777);
    expect(c.changeText).toBeUndefined();
    expect(c.followTarget).toBeUndefined();
    expect(pulses.has("a.ts")).toBe(false);
    expect(c.refreshed).toBe(same);
    expect(c.showedSelected).toBe(true);
    expect(c.previewSoon).toBeUndefined();
    // Unknown path: not counts-only (no prev) → real pulse.
    const n = planPatch({ remove: [], rename: [], upsert: [B] }, pre, pulses, fading, undefined, true, 778);
    expect(n.changeText).toBe("b.ts");
    expect(pulses.get("b.ts")).toBe(778);
  });

  // Value: protects=selected-file refresh + preview re-request on
  // real edits; fails_when=previewSoon drops (stale preview) or
  // fires on counts-only (preview refetch storms); why_new=Slice 4.
  test("changed selection refreshes and re-requests preview", () => {
    const prev = building({ lines: 10 });
    const next = building({ lines: 11 });
    const pre = new Map([["a.ts", prev]]);
    const p = planPatch({ remove: [], rename: [], upsert: [next] }, pre, new Map(), new Map(), "a.ts", true, 5);
    expect(p.refreshed).toBe(next);
    expect(p.previewSoon).toBe(next);
    expect(p.showedSelected).toBe(true);
  });

  // Value: protects=belts-only inspector refresh without preview
  // refetch; fails_when=the condition drops (stale in/out counts)
  // or fires after an upsert (double refresh); why_new=Slice 4.
  test("belts-only refresh fires exactly when selected and not shown", () => {
    const pre = new Map([["a.ts", A]]);
    const yes = planPatch({ remove: [], rename: [], upsert: [], belts: [] }, pre, new Map(), new Map(), "a.ts", true, 1);
    expect(yes.beltsRefresh).toBe(true);
    const shown = planPatch(
      { remove: [], rename: [], upsert: [B], belts: [] },
      pre,
      new Map(),
      new Map(),
      "b.ts",
      true,
      1,
    );
    expect(shown.beltsRefresh).toBe(false);
    const noBelts = planPatch({ remove: [], rename: [], upsert: [] }, pre, new Map(), new Map(), "a.ts", true, 1);
    expect(noBelts.beltsRefresh).toBe(false);
    const noSel = planPatch(
      { remove: [], rename: [], upsert: [], belts: [] },
      pre,
      new Map(),
      new Map(),
      undefined,
      true,
      1,
    );
    expect(noSel.beltsRefresh).toBe(false);
  });
});

describe("eviction", () => {
  // Value: protects=cap-20 oldest-first eviction shared by
  // pulses/fading; fails_when=newest evicted (fresh flashes vanish)
  // or the cap drifts (hidden-tab memory growth); why_new=Slice 4+A5.
  test("21 rapid changes keep the 20 newest pulses", () => {
    expect(FEED_CAP).toBe(20);
    const pulses = new Map<string, number>();
    for (let i = 0; i < 21; i++) {
      pulses.set(`f${i}.ts`, 1000 + i);
      evictOldest(pulses, (s) => s, FEED_CAP);
    }
    expect(pulses.size).toBe(20);
    expect(pulses.has("f0.ts")).toBe(false);
    expect(pulses.get("f20.ts")).toBe(1020);
  });

  // Value: protects=eviction by start-time (not insertion) with
  // stable ties; fails_when=insertion-order eviction drops a fresh
  // backdated entry; why_new=Slice 4; seam=none.
  test("eviction orders by start, ties keep insertion order", () => {
    const fading = new Map<string, FadeEntry>();
    fading.set("new.ts", { building: A, start: 300 });
    fading.set("old.ts", { building: A, start: 100 });
    fading.set("mid.ts", { building: A, start: 200 });
    evictOldest(fading, (f) => f.start, 2);
    expect([...fading.keys()].sort()).toEqual(["mid.ts", "new.ts"]);
    const tied = new Map<string, number>([
      ["first.ts", 50],
      ["second.ts", 50],
    ]);
    evictOldest(tied, (s) => s, 1);
    expect([...tied.keys()]).toEqual(["second.ts"]);
  });

  // Value: protects=in-patch pulse eviction (burst upserts share
  // one patch and must not grow the map past the cap);
  // fails_when=the planPatch call site drops eviction (direct
  // evictOldest tests still pass; hidden-tab memory grows on every
  // burst); why_new=re-audit (feed.ts:102 never fired via planPatch).
  test("a burst patch evicts the oldest pulses in place", () => {
    const pre = new Map<string, Building>();
    const pulses = new Map<string, number>();
    for (let i = 0; i < FEED_CAP; i++) pulses.set(`old${i}.ts`, 1000 + i);
    const fresh = [building({ id: "n1", path: "new1.ts" }), building({ id: "n2", path: "new2.ts" })];
    planPatch({ remove: [], rename: [], upsert: fresh }, pre, pulses, new Map(), undefined, true, 5000);
    expect(pulses.size).toBe(FEED_CAP);
    expect(pulses.has("old0.ts")).toBe(false);
    expect(pulses.has("old1.ts")).toBe(false);
    expect(pulses.get("new1.ts")).toBe(5000);
    expect(pulses.get("new2.ts")).toBe(5000);
  });

  // Value: protects=in-patch fade eviction (mass deletes share one
  // patch); fails_when=the planPatch call site drops eviction (a
  // burst delete of 20+ files grows fading unboundedly);
  // why_new=re-audit (feed.ts:69 never fired via planPatch).
  test("a mass-delete patch evicts the oldest fades in place", () => {
    const d1 = building({ id: "d1", path: "d1.ts" });
    const pre = new Map<string, Building>([
      ["d1.ts", d1],
      ["d2.ts", building({ id: "d2", path: "d2.ts" })],
    ]);
    const fading = new Map<string, FadeEntry>();
    for (let i = 0; i < FEED_CAP; i++) fading.set(`gone${i}.ts`, { building: A, start: 100 + i });
    planPatch({ remove: ["d1", "d2"], rename: [], upsert: [] }, pre, new Map(), fading, undefined, true, 9000);
    expect(fading.size).toBe(FEED_CAP);
    expect(fading.has("gone0.ts")).toBe(false);
    expect(fading.has("gone1.ts")).toBe(false);
    expect(fading.get("d1.ts")).toEqual({ building: d1, start: 9000 });
  });

  // Value: protects=fade entries on delete + reduced-motion skip;
  // fails_when=fades stop (deletes pop) or animate=false still
  // records (wasted entries); why_new=Slice 4; seam=none.
  test("deletes fade the pre-patch building unless still", () => {
    const pre = new Map([["a.ts", A]]);
    const live = maps();
    planPatch({ remove: ["a"], rename: [], upsert: [] }, pre, live.pulses, live.fading, undefined, true, 42);
    expect(live.fading.get("a.ts")).toEqual({ building: A, start: 42 });
    const still = maps();
    planPatch({ remove: ["a"], rename: [], upsert: [] }, pre, still.pulses, still.fading, undefined, false, 42);
    expect(still.fading.size).toBe(0);
  });
});
