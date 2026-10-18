import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  currentStep,
  extractPathsFromText,
  parseMuseLine,
  plannedEventFromTodo,
  startMuseRun,
  type MuseStreamEvent,
  type SpawnFn,
  type TodoItem,
} from "./muse-adapter.ts";

describe("extractPathsFromText", () => {
  // Value: protects=ghost honesty: only real path evidence becomes a
  // path; fails_when=bare keywords or versions spawn ghosts;
  // why_new=the adapter is the only intent channel into the floor.
  test("extracts spike-format plans and rejects non-paths", () => {
    expect(extractPathsFromText("Create src/greet.ts — module exporting greet(name)")).toEqual(["src/greet.ts"]);
    expect(extractPathsFromText("Create src/index.ts — re-export entry point")).toEqual(["src/index.ts"]);
    expect(extractPathsFromText("Create test/greet.test.ts — Bun tests, then run")).toEqual(["test/greet.test.ts"]);
    expect(extractPathsFromText("Create hello.txt")).toEqual(["hello.txt"]);
    expect(extractPathsFromText("Update package.json and Makefile")).toEqual(["package.json", "Makefile"]);
    expect(extractPathsFromText("Run bun test and fix any failures")).toEqual([]);
    expect(extractPathsFromText("Fix version 1.2.3 handling for example.com")).toEqual([]);
    expect(extractPathsFromText("Edit `src/a.ts`, then src/a.ts again.")).toEqual(["src/a.ts"]);
    expect(extractPathsFromText("Write the file (docs/guide.md) next")).toEqual(["docs/guide.md"]);
  });
});

const todoLine = (items: TodoItem[], sessionId = "s1"): string =>
  JSON.stringify({
    payload_type: "todo.snapshot.updated",
    stream: { kind: "session", id: sessionId },
    payload: { facts: { revision_id: 2, items } },
  });

describe("parseMuseLine", () => {
  test("classifies todo, activity, terminal, and garbage", () => {
    const todo = parseMuseLine(todoLine([{ index: 0, status: "in_progress", text: "Create src/a.ts" }]));
    expect(todo?.kind).toBe("todo");
    if (todo?.kind === "todo") {
      expect(todo.sessionId).toBe("s1");
      expect(todo.revision).toBe(2);
      expect(todo.items[0]!.text).toBe("Create src/a.ts");
    }
    expect(parseMuseLine(JSON.stringify({ payload_type: "task.lifecycle.started" }))?.kind).toBe("activity");
    expect(parseMuseLine(JSON.stringify({ payload_type: "run.terminal.completed" }))?.kind).toBe("terminal");
    expect(parseMuseLine(JSON.stringify({ payload_type: "run.output.delta" }))?.kind).toBe("other");
    expect(parseMuseLine("not json")?.kind).toBe("other");
    expect(parseMuseLine("")).toBeUndefined();
  });
});

describe("plannedEventFromTodo", () => {
  test("skips completed items for paths but keeps them as step evidence", () => {
    const event = plannedEventFromTodo({
      sessionId: "s1",
      planId: "p1",
      id: "e1",
      ts: 100,
      items: [
        { index: 0, status: "completed", text: "Create src/done.ts" },
        { index: 1, status: "in_progress", text: "Create src/next.ts" },
      ],
    });
    expect(event?.type).toBe("planned");
    if (event?.type === "planned") {
      expect(event.paths).toEqual(["src/next.ts"]);
      expect(event.steps).toEqual(["Create src/done.ts", "Create src/next.ts"]);
      expect(event.channel).toBe("todo");
      expect(event.agentId).toBe("muse");
    }
  });

  test("no extractable path means no event (never guessed)", () => {
    expect(
      plannedEventFromTodo({
        sessionId: "s1",
        planId: "p1",
        id: "e1",
        ts: 100,
        items: [{ index: 0, status: "pending", text: "Run the tests" }],
      }),
    ).toBeUndefined();
  });

  test("currentStep prefers in-progress over pending", () => {
    expect(
      currentStep([
        { index: 0, status: "pending", text: "later" },
        { index: 1, status: "in_progress", text: "now" },
      ]),
    ).toBe("now");
  });
});

describe("startMuseRun", () => {
  // Value: protects=stream lifecycle wiring (lines in order, onExit
  // once with truthful info, stop kills the group); fails_when=the
  // adapter drops lines or orphans the process; why_new=dispatch.
  test("streams lines, reports exit, and stop kills with SIGTERM then SIGKILL", async () => {
    const kills: string[] = [];
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    let cmds: string[] = [];
    const spawnFn: SpawnFn = (cmd) => {
      cmds = cmd;
      return {
        stdout: (async function* () {
          yield todoLine([{ index: 0, status: "in_progress", text: "Create a.txt" }]);
          await exited;
        })(),
        stderr: (async function* () {})(),
        exited,
        killGroup: (signal) => {
          kills.push(signal);
          if (signal === "SIGKILL") resolveExit(137);
        },
      };
    };
    const lines: MuseStreamEvent[] = [];
    const exits: { code: number | null; timedOut: boolean; sawTerminal: boolean }[] = [];
    const run = startMuseRun({
      workspace: "/tmp/ws",
      sessionId: "00000000-0000-4000-8000-000000000001",
      prompt: "do it",
      spawnFn,
      timeoutMs: 60_000,
      callbacks: {
        onLine: (e) => lines.push(e),
        onStderr: () => {},
        onExit: (info) => exits.push(info),
      },
    });
    // Let the todo line flow, then stop and let the grace SIGKILL land.
    await Bun.sleep(20);
    run.stop();
    await Bun.sleep(2_200);
    expect(lines.map((l) => l.kind)).toEqual(["todo"]);
    expect(kills).toEqual(["SIGTERM", "SIGKILL"]);
    expect(exits).toEqual([{ code: 137, timedOut: true, sawTerminal: false }]);
    expect(cmds.join(" ")).toContain("--session-id 00000000-0000-4000-8000-000000000001");
    expect(cmds.join(" ")).toContain("--prompt-file");
  }, 15_000);

  // Value: protects=the runaway-run guard: a hung agent is
  // SIGKILLed at the timeout and reported as timedOut (never left
  // holding the floor's single worker slot).
  test("a hung run is killed at the timeout and reported timedOut", async () => {
    const kills: string[] = [];
    let resolveExit: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
    const spawnFn: SpawnFn = () => ({
      stdout: (async function* () {
        await exited;
      })(),
      stderr: (async function* () {})(),
      exited,
      killGroup: (signal) => {
        kills.push(signal);
        resolveExit(137);
      },
    });
    const exit = await new Promise<{ code: number | null; timedOut: boolean; sawTerminal: boolean }>((resolveDone) => {
      startMuseRun({
        workspace: "/tmp/ws",
        sessionId: "00000000-0000-4000-8000-000000000003",
        prompt: "hang",
        spawnFn,
        timeoutMs: 150,
        callbacks: { onLine: () => {}, onStderr: () => {}, onExit: resolveDone },
      });
    });
    expect(kills).toEqual(["SIGKILL"]);
    expect(exit).toEqual({ code: 137, timedOut: true, sawTerminal: false });
  }, 15_000);

  // Value: protects=the real spawn path (Bun.spawn, line splitting,
  // prompt-file round trip, process-group plumbing) against a real
  // child process; fails_when=defaultSpawn/linesOf regress while
  // fake-spawn tests stay green; why_new=coverage re-audit: these
  // lines were only ever exercised outside the tool's view.
  test("default spawn runs a real child and streams its lines", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-adapter-"));
    try {
      const script = join(dir, "fake-muse.sh");
      const todo = todoLine([{ index: 0, status: "in_progress", text: "Create a.txt" }], "00000000-0000-4000-8000-000000000002");
      writeFileSync(
        script,
        `#!/bin/sh\ncat "$*" >/dev/null 2>&1 || true\nprintf '%s\\n' '${todo.replace(/'/g, "'\\''")}'\nprintf '%s\\n' '{"payload_type":"run.terminal.completed"}'\n`,
      );
      chmodSync(script, 0o755);
      const lines: MuseStreamEvent[] = [];
      const exit = await new Promise<{ code: number | null; timedOut: boolean; sawTerminal: boolean }>((resolveDone) => {
        startMuseRun({
          workspace: dir,
          sessionId: "00000000-0000-4000-8000-000000000002",
          prompt: "do it",
          command: script,
          timeoutMs: 30_000,
          callbacks: {
            onLine: (e) => lines.push(e),
            onStderr: () => {},
            onExit: resolveDone,
          },
        });
      });
      expect(lines.map((l) => l.kind)).toEqual(["todo", "terminal"]);
      expect(exit).toEqual({ code: 0, timedOut: false, sawTerminal: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
