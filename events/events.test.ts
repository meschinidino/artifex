import { describe, expect, it } from "bun:test";
import {
  EVENTS_VERSION,
  FloorEventError,
  isIntended,
  validateFloorEvent,
  type FloorEvent,
} from "./index.ts";

const base = { v: EVENTS_VERSION, id: "01JTEST00000000000000000000", ts: 1_700_000_000_000 };

const planned: FloorEvent = {
  ...base,
  type: "planned",
  provenance: "intended",
  planId: "plan-1",
  channel: "todo",
  paths: ["src/greet.ts", "src/index.ts"],
  steps: ["Create src/greet.ts", "Create src/index.ts"],
};

describe("validateFloorEvent", () => {
  it("accepts a planned event from a measured intent channel", () => {
    const out = validateFloorEvent(planned);
    expect(out).toEqual(planned);
    expect(out).not.toBe(planned);
    expect(Object.isFrozen(out)).toBe(true);
    expect(isIntended(planned)).toBe(true);
  });

  it("rejects a planned event dressed as observed", () => {
    expect(() => validateFloorEvent({ ...planned, provenance: "observed" })).toThrow(
      FloorEventError,
    );
  });

  it("rejects an observed-change dressed as intended", () => {
    const ev = {
      ...base,
      type: "observed-change",
      provenance: "intended",
      path: "src/greet.ts",
      change: "created",
    };
    expect(() => validateFloorEvent(ev)).toThrow(/cannot have provenance/);
  });

  it("rejects an observed-change carrying a planId", () => {
    const ev = {
      ...base,
      type: "observed-change",
      provenance: "observed",
      path: "src/greet.ts",
      change: "created",
      planId: "plan-1",
    };
    expect(() => validateFloorEvent(ev)).toThrow(/must not carry a planId/);
  });

  it("accepts an intended file-written only when it solidifies a plan", () => {
    const ok = {
      ...base,
      type: "file-written",
      provenance: "intended",
      path: "src/greet.ts",
      planId: "plan-1",
      by: "agent",
    };
    expect(validateFloorEvent(ok)).toEqual(ok);
    const bad = { ...ok, planId: undefined };
    expect(() => validateFloorEvent(bad)).toThrow(/must solidify a plan/);
  });

  it("accepts a write-time-only file-written as observed (spike default)", () => {
    const ev = {
      ...base,
      type: "file-written",
      provenance: "observed",
      path: "src/greet.ts",
      by: "agent",
    };
    expect(validateFloorEvent(ev).provenance).toBe("observed");
  });

  it("rejects wrong version, unknown type, and missing fields", () => {
    expect(() => validateFloorEvent({ ...planned, v: 999 })).toThrow(/unsupported event version/);
    expect(() => validateFloorEvent({ ...base, type: "teleported", provenance: "observed" })).toThrow(
      /unknown event type/,
    );
    expect(() => validateFloorEvent({ ...planned, paths: [] })).toThrow(/non-empty array of paths/);
    expect(() => validateFloorEvent({ ...planned, channel: "vibes" })).toThrow(
      /measured intent channel/,
    );
  });

  it("rejects prototype-key event types as unknown, not a TypeError", () => {
    for (const t of ["toString", "constructor", "__proto__"]) {
      expect(() => validateFloorEvent({ ...base, type: t, provenance: "observed" })).toThrow(
        /unknown event type/,
      );
    }
  });

  it("rejects non-finite numbers and mistyped optional fields", () => {
    expect(() =>
      validateFloorEvent({ ...base, type: "test-result", provenance: "observed", passed: NaN, failed: 0 }),
    ).toThrow(/finite number/);
    expect(() =>
      validateFloorEvent({
        ...base,
        type: "abandoned-plan",
        provenance: "intended",
        planId: "p",
        paths: ["a.ts"],
        idleMs: Infinity,
      }),
    ).toThrow(/finite number/);
    expect(() =>
      validateFloorEvent({ ...base, type: "started", provenance: "observed", path: 42 }),
    ).toThrow(/non-empty string/);
    expect(() =>
      validateFloorEvent({ ...base, type: "started", provenance: "intended" }),
    ).toThrow(/intended started must reference a plan/);
  });

  it("enforces repo-relative paths, measured channels, and text caps", () => {
    expect(() => validateFloorEvent({ ...planned, paths: ["/etc/passwd"] })).toThrow(/repo-relative/);
    expect(() => validateFloorEvent({ ...planned, paths: ["../escape.ts"] })).toThrow(/\.\./);
    expect(() => validateFloorEvent({ ...planned, channel: "app-server-plan" })).toThrow(
      /measured intent channel/,
    );
    expect(() =>
      validateFloorEvent({ ...base, type: "prompt-sent", provenance: "observed", text: "x".repeat(9000) }),
    ).toThrow(/exceeds/);
    expect(() => validateFloorEvent({ ...planned, steps: 42 })).toThrow(/array of strings/);
  });

  it("rejects observed planIds, human intended writes, and coerced enums", () => {
    expect(() =>
      validateFloorEvent({ ...base, type: "file-written", provenance: "observed", path: "a.ts", planId: "p" }),
    ).toThrow(/must not carry a planId/);
    expect(() =>
      validateFloorEvent({
        ...base,
        type: "file-written",
        provenance: "intended",
        path: "a.ts",
        planId: "p",
        by: "human",
      }),
    ).toThrow(/never intended/);
    expect(() =>
      validateFloorEvent({ ...base, type: "observed-change", provenance: "observed", path: "a.ts", change: ["created"] }),
    ).toThrow(/change is invalid/);
    expect(() =>
      validateFloorEvent({ ...base, type: "observed-change", provenance: "observed", path: "a.ts", change: "renamed", fromPath: 42 }),
    ).toThrow(/fromPath/);
  });

  it("accepts the remaining event types with their fixed provenance", () => {
    const cases: unknown[] = [
      { ...base, type: "started", provenance: "intended", planId: "p", path: "src/a.ts" },
      { ...base, type: "test-result", provenance: "observed", passed: 2, failed: 0, command: "bun test" },
      { ...base, type: "abandoned-plan", provenance: "intended", planId: "p", paths: ["src/a.ts"], idleMs: 600_000 },
      { ...base, type: "prompt-sent", provenance: "observed", text: "build it" },
      { ...base, type: "why-answered", provenance: "observed", path: "src/a.ts", text: "because" },
      { ...base, type: "annotate", provenance: "observed", path: "src/a.ts", note: "why note" },
    ];
    for (const c of cases) expect(validateFloorEvent(c)).toBeTruthy();
  });
});
