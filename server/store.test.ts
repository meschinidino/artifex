import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateFloorEvent, type FloorEvent } from "../events/index.ts";
import { createFloorServer, type FloorServer } from "./index.ts";
import {
  appendEventLog,
  compactEventLog,
  EVENT_LOG_MAX,
  loadEventLog,
  MAX_EVENT_LOG_BYTES,
} from "./store.ts";

let repo: string | undefined;
let floor: FloorServer | undefined;

afterEach(() => {
  floor?.stop();
  floor = undefined;
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

function emptyRepo(): string {
  return mkdtempSync(join(tmpdir(), "artifex-store-"));
}

function changeEvent(i: number): FloorEvent {
  return validateFloorEvent({
    v: 1,
    id: `event-${i}`,
    ts: 1_700_000_000_000 + i,
    agentId: "watcher",
    type: "observed-change",
    provenance: "observed",
    path: `src/f${i}.ts`,
    change: "created",
  });
}

function logLines(dir: string): string[] {
  return readFileSync(join(dir, ".artifex", "event-log.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.length > 0);
}

describe("event log store", () => {
  test("append then load round-trips events in order", () => {
    repo = emptyRepo();
    expect(appendEventLog(repo, changeEvent(1))).toBe(true);
    expect(appendEventLog(repo, changeEvent(2))).toBe(true);
    const { events, lines } = loadEventLog(repo);
    expect(lines).toBe(2);
    expect(events.map((e) => e.id)).toEqual(["event-1", "event-2"]);
    expect(events[0]).toMatchObject({ type: "observed-change", path: "src/f1.ts" });
  });

  test("load caps at the last EVENT_LOG_MAX events", () => {
    repo = emptyRepo();
    for (let i = 0; i < EVENT_LOG_MAX + 50; i++) appendEventLog(repo, changeEvent(i));
    const { events, lines } = loadEventLog(repo);
    expect(lines).toBe(EVENT_LOG_MAX + 50);
    expect(events.length).toBe(EVENT_LOG_MAX);
    expect(events[0]?.id).toBe("event-50");
    expect(events.at(-1)?.id).toBe(`event-${EVENT_LOG_MAX + 49}`);
  });

  test("corrupt lines are skipped without losing valid neighbors", () => {
    repo = emptyRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    const file = join(repo, ".artifex", "event-log.jsonl");
    appendFileSync(file, `${JSON.stringify(changeEvent(1))}\n`);
    appendFileSync(file, "{not json\n");
    // Well-formed JSON the validator rejects (observed carrying planId).
    appendFileSync(file, `${JSON.stringify({ v: 1, id: "forged", ts: 1, type: "observed-change", provenance: "observed", path: "src/x.ts", change: "created", planId: "p1" })}\n`);
    appendFileSync(file, `${JSON.stringify(changeEvent(2))}\n`);
    const { events, lines } = loadEventLog(repo);
    expect(lines).toBe(4);
    expect(events.map((e) => e.id)).toEqual(["event-1", "event-2"]);
  });

  test("compaction rewrites the file to the last EVENT_LOG_MAX events", () => {
    repo = emptyRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    const file = join(repo, ".artifex", "event-log.jsonl");
    const lines: string[] = [];
    for (let i = 0; i < 2 * EVENT_LOG_MAX + 100; i++) lines.push(JSON.stringify(changeEvent(i)));
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(compactEventLog(repo)).toBe(EVENT_LOG_MAX);
    const after = logLines(repo);
    expect(after.length).toBe(EVENT_LOG_MAX);
    expect(JSON.parse(after[0]!).id).toBe(`event-${EVENT_LOG_MAX + 100}`);
    expect(JSON.parse(after.at(-1)!).id).toBe(`event-${2 * EVENT_LOG_MAX + 99}`);
    expect(loadEventLog(repo).events.length).toBe(EVENT_LOG_MAX);
  });

  test("oversize log is refused with an empty load", () => {
    repo = emptyRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    writeFileSync(join(repo, ".artifex", "event-log.jsonl"), "x".repeat(MAX_EVENT_LOG_BYTES + 1));
    expect(loadEventLog(repo)).toEqual({ events: [], lines: 0, refused: true });
  });

  test("compaction bails on a refused log instead of wiping it (review R1)", () => {
    repo = emptyRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    const file = join(repo, ".artifex", "event-log.jsonl");
    const body = "x".repeat(MAX_EVENT_LOG_BYTES + 1);
    writeFileSync(file, body);
    expect(compactEventLog(repo)).toBe(EVENT_LOG_MAX);
    expect(readFileSync(file, "utf8")).toBe(body);
  });

  test("single events past the line cap stay in memory only (review R1)", () => {
    repo = emptyRepo();
    const giant = validateFloorEvent({
      v: 1,
      id: "giant",
      ts: 1,
      agentId: "watcher",
      type: "observed-change",
      provenance: "observed",
      path: `src/${"a".repeat(300 * 1024)}.ts`,
      change: "created",
    });
    expect(appendEventLog(repo, giant)).toBe(false);
    expect(existsSync(join(repo, ".artifex", "event-log.jsonl"))).toBe(false);
    expect(appendEventLog(repo, changeEvent(1))).toBe(true);
    expect(logLines(repo).length).toBe(1);
  });

  test("compaction is byte-bounded, not just line-bounded (review R1)", () => {
    repo = emptyRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    const file = join(repo, ".artifex", "event-log.jsonl");
    // Six ~1 MiB valid events: the file loads (6 MiB < 8 MiB) but a
    // line-count-only compaction would rewrite all six (~6 MiB).
    // Byte-aware compaction keeps the newest ~4 MiB worth.
    const lines: string[] = [];
    for (let i = 0; i < 6; i++) {
      const e = validateFloorEvent({
        v: 1,
        id: `big-${i}`,
        ts: 1_700_000_000_000 + i,
        agentId: "watcher",
        type: "observed-change",
        provenance: "observed",
        path: `src/${"p".repeat(1024 * 1024)}.ts`,
        change: "created",
      });
      lines.push(JSON.stringify(e));
    }
    writeFileSync(file, `${lines.join("\n")}\n`);
    expect(compactEventLog(repo)).toBe(3);
    const after = logLines(repo);
    expect(after.length).toBe(3);
    expect(after.map((l) => JSON.parse(l).id)).toEqual(["big-3", "big-4", "big-5"]);
  });

  test("append failures warn once until an append succeeds (review R1)", () => {
    repo = emptyRepo();
    const badDir = join(repo, ".artifex");
    mkdirSync(badDir, { recursive: true });
    const good = emptyRepo();
    const orig = console.error;
    let warns = 0;
    console.error = () => {
      warns++;
    };
    try {
      // Reset the sticky flag regardless of earlier tests in this file.
      expect(appendEventLog(good, changeEvent(900))).toBe(true);
      chmodSync(badDir, 0o555);
      try {
        expect(appendEventLog(repo, changeEvent(901))).toBe(false);
        expect(appendEventLog(repo, changeEvent(902))).toBe(false);
      } finally {
        chmodSync(badDir, 0o755);
      }
      expect(warns).toBe(1);
      expect(appendEventLog(good, changeEvent(903))).toBe(true);
      chmodSync(badDir, 0o555);
      try {
        expect(appendEventLog(repo, changeEvent(904))).toBe(false);
      } finally {
        chmodSync(badDir, 0o755);
      }
      expect(warns).toBe(2);
    } finally {
      console.error = orig;
      rmSync(good, { recursive: true, force: true });
    }
  });

  test("symlinked .artifex refuses appends and loads empty", () => {
    repo = emptyRepo();
    const outside = mkdtempSync(join(tmpdir(), "artifex-log-outside-"));
    try {
      symlinkSync(outside, join(repo, ".artifex"));
      expect(appendEventLog(repo, changeEvent(1))).toBe(false);
      expect(existsSync(join(outside, "event-log.jsonl"))).toBe(false);
      expect(loadEventLog(repo)).toEqual({ events: [], lines: 0, refused: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("symlinked log file refuses appends", () => {
    repo = emptyRepo();
    const outside = mkdtempSync(join(tmpdir(), "artifex-logfile-outside-"));
    try {
      const target = join(outside, "target.log");
      writeFileSync(target, "outside\n");
      mkdirSync(join(repo, ".artifex"), { recursive: true });
      symlinkSync(target, join(repo, ".artifex", "event-log.jsonl"));
      expect(appendEventLog(repo, changeEvent(1))).toBe(false);
      expect(readFileSync(target, "utf8")).toBe("outside\n");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Value: protects=load-side refusal of a planted log symlink
  // (append refusal is tested; a load that followed the link would
  // ingest outside content); fails_when=the isFile gate drops (reads
  // follow the link); why_new=re-audit (store.ts:65-66).
  test("a symlinked log file refuses to load", () => {
    repo = emptyRepo();
    const outside = mkdtempSync(join(tmpdir(), "artifex-logload-outside-"));
    try {
      const target = join(outside, "target.log");
      writeFileSync(target, `${JSON.stringify(changeEvent(1))}\n`);
      mkdirSync(join(repo, ".artifex"), { recursive: true });
      symlinkSync(target, join(repo, ".artifex", "event-log.jsonl"));
      expect(loadEventLog(repo)).toEqual({ events: [], lines: 0, refused: true });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // Value: protects=load-side refusal of an unreadable log (EACCES
  // between the stat and the open: refused, never a throw);
  // fails_when=the open catch drops (boot crashes on a chmod-000
  // log); why_new=re-audit (store.ts:95-96).
  test("an unreadable log file refuses to load instead of throwing", () => {
    repo = emptyRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    const file = join(repo, ".artifex", "event-log.jsonl");
    writeFileSync(file, `${JSON.stringify(changeEvent(1))}\n`);
    chmodSync(file, 0o000);
    try {
      expect(loadEventLog(repo)).toEqual({ events: [], lines: 0, refused: true });
    } finally {
      chmodSync(file, 0o644);
    }
  });

  // Value: protects=compaction failure cleanup (unwritable dir: tmp
  // write fails, no litter left, current file intact);
  // fails_when=the tmp cleanup drops (failed compactions pile up
  // .tmp files); why_new=re-audit (store.ts:219-220).
  test("a failed compaction leaves no tmp file and keeps the log", () => {
    repo = emptyRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    const file = join(repo, ".artifex", "event-log.jsonl");
    const body = `${JSON.stringify(changeEvent(1))}\n${JSON.stringify(changeEvent(2))}\n`;
    writeFileSync(file, body);
    chmodSync(join(repo, ".artifex"), 0o555);
    try {
      expect(compactEventLog(repo)).toBe(2);
    } finally {
      chmodSync(join(repo, ".artifex"), 0o755);
    }
    expect(readFileSync(file, "utf8")).toBe(body);
    expect(logLines(repo).length).toBe(2);
  });

  test("unwritable state dir warns instead of throwing", () => {
    repo = emptyRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    chmodSync(join(repo, ".artifex"), 0o555);
    try {
      expect(appendEventLog(repo, changeEvent(1))).toBe(false);
    } finally {
      chmodSync(join(repo, ".artifex"), 0o755);
    }
  });

  test("server restart preserves the event-log tail", async () => {
    repo = emptyRepo();
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 1;\n");
    floor = await createFloorServer({ repo, port: 0 });
    writeFileSync(join(repo, "src", "b.ts"), "export const b = 2;\n");
    const deadline = Date.now() + 10_000;
    while (
      !floor.eventLog.some((e) => e.type === "observed-change" && e.path === "src/b.ts") &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 50));
    }
    const tail = floor.eventLog.map((e) => e.id);
    expect(tail.length).toBeGreaterThan(0);
    expect(existsSync(join(repo, ".artifex", "event-log.jsonl"))).toBe(true);
    floor.stop();
    floor = await createFloorServer({ repo, port: 0 });
    expect(floor.eventLog.map((e) => e.id)).toEqual(tail);
  }, 30_000);
});
