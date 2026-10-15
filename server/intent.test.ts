import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFloorEvent, type FloorEvent } from "../events/index.ts";
import { createIntentGate, PLAN_IDLE_TIMEOUT_MS } from "./intent.ts";
import { appendEventLog } from "./store.ts";

const T0 = 1_700_000_000_000;

function planned(ts: number, overrides: Record<string, unknown> = {}): FloorEvent {
  return validateFloorEvent({
    v: 1,
    id: `planned-${ts}`,
    ts,
    sessionId: "session-a",
    agentId: "muse",
    type: "planned",
    provenance: "intended",
    planId: "plan-1",
    channel: "todo",
    paths: ["src/a.ts"],
    ...overrides,
  });
}

function intendedWritten(ts: number, overrides: Record<string, unknown> = {}): FloorEvent {
  return validateFloorEvent({
    v: 1,
    id: `written-${ts}`,
    ts,
    sessionId: "session-a",
    agentId: "muse",
    type: "file-written",
    provenance: "intended",
    planId: "plan-1",
    path: "src/a.ts",
    ...overrides,
  });
}

function intendedStarted(ts: number, overrides: Record<string, unknown> = {}): FloorEvent {
  return validateFloorEvent({
    v: 1,
    id: `started-${ts}`,
    ts,
    sessionId: "session-a",
    agentId: "muse",
    type: "started",
    provenance: "intended",
    planId: "plan-1",
    path: "src/a.ts",
    ...overrides,
  });
}

function abandoned(ts: number, overrides: Record<string, unknown> = {}): FloorEvent {
  return validateFloorEvent({
    v: 1,
    id: `abandoned-${ts}`,
    ts,
    sessionId: "session-a",
    type: "abandoned-plan",
    provenance: "intended",
    planId: "plan-1",
    paths: ["src/a.ts"],
    idleMs: PLAN_IDLE_TIMEOUT_MS + 1,
    ...overrides,
  });
}

function observedWritten(ts: number, overrides: Record<string, unknown> = {}): FloorEvent {
  return validateFloorEvent({
    v: 1,
    id: `observed-${ts}`,
    ts,
    sessionId: "session-a",
    agentId: "muse",
    type: "file-written",
    provenance: "observed",
    path: "src/a.ts",
    by: "agent",
    ...overrides,
  });
}

function testResult(ts: number, overrides: Record<string, unknown> = {}): FloorEvent {
  return validateFloorEvent({
    v: 1,
    id: `test-${ts}`,
    ts,
    sessionId: "session-a",
    agentId: "muse",
    type: "test-result",
    provenance: "observed",
    path: "src/a.test.ts",
    passed: 3,
    failed: 0,
    command: "bun test",
    ...overrides,
  });
}

let now = T0;
function gate() {
  now = T0;
  return createIntentGate({ now: () => now });
}

describe("intent binding gate", () => {
  test("intended started and file-written bind to a prior planned event", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    expect(g.ingest(intendedStarted(T0 + 1))).toEqual({ verdict: "bound" });
    expect(g.ingest(intendedWritten(T0 + 2))).toEqual({ verdict: "bound" });
    expect(g.isBound("session-a", "plan-1")).toBe(true);
  });

  test("forged planId stays unbound (unknown-plan)", () => {
    const g = gate();
    expect(g.ingest(intendedWritten(T0, { planId: "plan-never-planned" }))).toEqual({
      verdict: "unbound",
      reason: "unknown-plan",
    });
    expect(g.isBound("session-a", "plan-never-planned")).toBe(false);
  });

  test("planId from another session stays unbound (wrong-session)", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    expect(g.ingest(intendedWritten(T0 + 1, { sessionId: "session-b" }))).toEqual({
      verdict: "unbound",
      reason: "wrong-session",
    });
  });

  test("abandoned plans stay unbound (stale plan ID)", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    expect(g.ingest(abandoned(T0 + 1))).toEqual({ verdict: "abandoned" });
    expect(g.ingest(intendedWritten(T0 + 2))).toEqual({
      verdict: "unbound",
      reason: "abandoned-plan",
    });
    expect(g.isBound("session-a", "plan-1")).toBe(false);
  });

  test("idle-expired plans stay unbound (D7/D20)", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    now = T0 + PLAN_IDLE_TIMEOUT_MS + 1;
    expect(g.ingest(intendedWritten(now))).toEqual({
      verdict: "unbound",
      reason: "expired-plan",
    });
  });

  test("session activity keeps a plan bindable past its planned ts", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    // Observed agent activity halfway through the window refreshes it.
    now = T0 + PLAN_IDLE_TIMEOUT_MS / 2;
    expect(g.ingest(observedWritten(now))).toEqual({ verdict: "observed" });
    now = T0 + PLAN_IDLE_TIMEOUT_MS - 1;
    expect(g.ingest(intendedWritten(now))).toEqual({ verdict: "bound" });
  });

  test("unbound attempts do not extend a plan's life", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    // A forged write in the same session is rejected and refreshes nothing.
    now = T0 + PLAN_IDLE_TIMEOUT_MS / 2;
    expect(g.ingest(intendedWritten(now, { planId: "plan-forged" }))).toEqual({
      verdict: "unbound",
      reason: "unknown-plan",
    });
    now = T0 + PLAN_IDLE_TIMEOUT_MS + 1;
    expect(g.ingest(intendedWritten(now))).toEqual({
      verdict: "unbound",
      reason: "expired-plan",
    });
  });

  test("isBound is side-effect free", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    now = T0 + PLAN_IDLE_TIMEOUT_MS - 1;
    expect(g.isBound("session-a", "plan-1")).toBe(true);
    now = T0 + PLAN_IDLE_TIMEOUT_MS + 1;
    expect(g.isBound("session-a", "plan-1")).toBe(false);
  });

  test("over-cap (unpersisted) plans never bind", () => {
    const g = gate();
    expect(g.ingest(planned(T0), { persisted: false })).toEqual({ verdict: "recorded" });
    expect(g.ingest(intendedWritten(T0 + 1))).toEqual({
      verdict: "unbound",
      reason: "unpersisted-plan",
    });
  });

  test("events without a sessionId never bind (fail closed)", () => {
    const g = gate();
    // A session-less plan still records, but nothing binds to it:
    // an unknown session is not "the same session".
    expect(
      g.ingest(planned(T0, { id: "planned-nosession", sessionId: undefined })),
    ).toEqual({ verdict: "recorded" });
    expect(
      g.ingest(intendedWritten(T0 + 1, { id: "written-nosession", sessionId: undefined })),
    ).toEqual({ verdict: "unbound", reason: "unknown-plan" });
    expect(g.isBound(undefined, "plan-1")).toBe(false);
    // Mixed: a session-less write cannot bind a sessioned plan either.
    expect(g.ingest(planned(T0, { id: "planned-sessions", planId: "plan-2" }))).toEqual({
      verdict: "recorded",
    });
    expect(
      g.ingest(intendedWritten(T0 + 1, { id: "written-mixed", planId: "plan-2", sessionId: undefined })),
    ).toEqual({ verdict: "unbound", reason: "unknown-plan" });
  });

  test("a later delivery cannot upgrade an unpersisted plan", () => {
    const g = gate();
    expect(g.ingest(planned(T0), { persisted: false })).toEqual({ verdict: "recorded" });
    // Double delivery with default opts must not flip it to persisted.
    expect(g.ingest(planned(T0, { id: "planned-again" }))).toEqual({ verdict: "recorded" });
    expect(g.ingest(intendedWritten(T0 + 1))).toEqual({
      verdict: "unbound",
      reason: "unpersisted-plan",
    });
  });

  test("a far-future event ts cannot extend a plan's life", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    // Forged activity stamped 10 windows out counts as now, not then.
    expect(g.ingest(observedWritten(T0 + 10 * PLAN_IDLE_TIMEOUT_MS, { id: "observed-future" }))).toEqual({
      verdict: "observed",
    });
    // Same for the plan's own ts: a future-dated plan anchors at now.
    expect(
      g.ingest(planned(T0 + 10 * PLAN_IDLE_TIMEOUT_MS, { id: "planned-future", planId: "plan-future" })),
    ).toEqual({ verdict: "recorded" });
    now = T0 + PLAN_IDLE_TIMEOUT_MS + 1;
    expect(g.ingest(intendedWritten(now))).toEqual({
      verdict: "unbound",
      reason: "expired-plan",
    });
    expect(g.ingest(intendedWritten(now, { id: "written-future", planId: "plan-future" }))).toEqual({
      verdict: "unbound",
      reason: "expired-plan",
    });
  });

  test("re-ingested plans revive and never move activity backwards", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    expect(g.ingest(abandoned(T0 + 1))).toEqual({ verdict: "abandoned" });
    // A re-plan after abandonment revives the binding.
    expect(g.ingest(planned(T0 + 2, { id: "planned-revive" }))).toEqual({ verdict: "recorded" });
    expect(g.ingest(intendedWritten(T0 + 3))).toEqual({ verdict: "bound" });
  });

  test("out-of-order replays never move activity backwards", () => {
    const g = gate();
    now = T0 + 5;
    expect(g.ingest(planned(T0 + 5))).toEqual({ verdict: "recorded" });
    // Late duplicate of the older delivery: activity stays at T0+5.
    expect(g.ingest(planned(T0, { id: "planned-older" }))).toEqual({ verdict: "recorded" });
    // Past the T0 window but inside the T0+5 window: still binds.
    now = T0 + PLAN_IDLE_TIMEOUT_MS + 1;
    expect(g.ingest(intendedWritten(now, { id: "written-window" }))).toEqual({ verdict: "bound" });
  });

  test("idle window is configurable per gate", () => {
    now = T0;
    const g = createIntentGate({ now: () => now, idleTimeoutMs: 1000 });
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    now = T0 + 1001;
    expect(g.ingest(intendedWritten(now))).toEqual({
      verdict: "unbound",
      reason: "expired-plan",
    });
  });

  test("other observed events with a sessionId refresh activity", () => {
    const g = gate();
    expect(g.ingest(planned(T0))).toEqual({ verdict: "recorded" });
    now = T0 + PLAN_IDLE_TIMEOUT_MS / 2;
    expect(g.ingest(testResult(now))).toEqual({ verdict: "observed" });
    now = T0 + PLAN_IDLE_TIMEOUT_MS - 1;
    expect(g.ingest(intendedWritten(now))).toEqual({ verdict: "bound" });
  });

  test("rebuild binds post-restart writes but never trusts load order", () => {
    const disk = [planned(T0), intendedWritten(T0 + 1)];
    const restarted = gate();
    expect(restarted.rebuild(disk)).toEqual([{ verdict: "recorded" }, { verdict: "bound" }]);
    // A later live write against the rebuilt plan still binds.
    expect(restarted.ingest(intendedWritten(T0 + 2, { id: "written-live" }))).toEqual({
      verdict: "bound",
    });

    // A log holding only an intended event (planted or truncated
    // history) binds nothing.
    expect(gate().rebuild([intendedWritten(T0)])).toEqual([
      { verdict: "unbound", reason: "unknown-plan" },
    ]);
    // Order matters: the plan must precede the write, even on disk.
    expect(gate().rebuild([intendedWritten(T0), planned(T0 + 1, { id: "planned-late" })])).toEqual([
      { verdict: "unbound", reason: "unknown-plan" },
      { verdict: "recorded" },
    ]);
  });

  test("prune drops abandoned and expired records only", () => {
    const g = gate();
    expect(g.ingest(planned(T0, { planId: "plan-live" }))).toEqual({ verdict: "recorded" });
    expect(g.ingest(planned(T0, { id: "planned-doomed", planId: "plan-doomed" }))).toEqual({
      verdict: "recorded",
    });
    expect(g.ingest(abandoned(T0 + 1, { id: "abandoned-doomed", planId: "plan-doomed" }))).toEqual({
      verdict: "abandoned",
    });
    expect(g.planCount()).toBe(2);
    now = T0 + PLAN_IDLE_TIMEOUT_MS + 1;
    // Both records are now dead: one abandoned, one expired.
    expect(g.prune()).toBe(2);
    expect(g.planCount()).toBe(0);
    // Pruned plans read back as unknown, never bound.
    expect(g.ingest(intendedWritten(now, { id: "written-after-prune", planId: "plan-live" }))).toEqual({
      verdict: "unbound",
      reason: "unknown-plan",
    });
  });
});

describe("intent binding store constraint (T4 review R1)", () => {
  let repo: string | undefined;
  afterEach(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  test("a planned event past the line cap binds nothing, end to end", () => {
    repo = mkdtempSync(join(tmpdir(), "artifex-intent-"));
    const paths = Array.from(
      { length: 2400 },
      (_, i) => `src/${"p".repeat(120)}-${i}.ts`,
    );
    const big = planned(T0, { id: "planned-big", paths });
    expect(Buffer.byteLength(JSON.stringify(big), "utf8")).toBeGreaterThan(256 * 1024);
    // The store refuses the write; the gate must honor that refusal.
    expect(appendEventLog(repo, big)).toBe(false);
    const g = gate();
    expect(g.ingest(big, { persisted: false })).toEqual({ verdict: "recorded" });
    expect(g.ingest(intendedWritten(T0 + 1, { path: paths[0] }))).toEqual({
      verdict: "unbound",
      reason: "unpersisted-plan",
    });
  });
});
