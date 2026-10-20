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
  usageEventFromPayload,
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
    expect(parseMuseLine("not json")?.kind).toBe("other");
    expect(parseMuseLine("")).toBeUndefined();
  });

  // Value: protects=the answer channel (run.output.delta text
  // reaches the run ledger; Q&A runs are visible); fails_when=a
  // delta is dropped or a malformed one becomes phantom text.
  test("emits text for deltas, other for malformed ones", () => {
    const delta = (payload: unknown) => JSON.stringify({ payload_type: "run.output.delta", payload });
    const text = parseMuseLine(delta({ kind: "run_output_delta", text: "Hello" }));
    expect(text).toEqual({ kind: "text", text: "Hello" });
    expect(parseMuseLine(delta({ kind: "run_output_delta" }))?.kind).toBe("other");
    expect(parseMuseLine(delta({ kind: "run_output_delta", text: "" }))?.kind).toBe("other");
    expect(parseMuseLine(delta({ kind: "run_output_delta", text: 42 }))?.kind).toBe("other");
    expect(parseMuseLine(JSON.stringify({ payload_type: "run.output.delta" }))?.kind).toBe("other");
  });

  // Value: protects=usage honesty: no measured shape carries token
  // usage today, so no known payload may parse as usage;
  // fails_when=a payload type is claimed as usage without a
  // pinned fixture behind it.
  test("no known payload parses as usage (empty pinned set)", () => {
    const lines = [
      JSON.stringify({ payload_type: "run.terminal.completed" }),
      JSON.stringify({ payload_type: "run.output.delta", payload: { kind: "run_output_delta", text: "hi" } }),
      JSON.stringify({ payload_type: "task.lifecycle.started" }),
      JSON.stringify({ payload_type: "tool.result", payload: { kind: "tool_result", original_output_tokens: 71 } }),
      todoLine([{ index: 0, status: "pending", text: "Create a.txt" }]),
    ];
    for (const line of lines) expect(parseMuseLine(line)?.kind).not.toBe("usage");
  });

  // Value: protects=run-cost truth: tool.result's
  // original_output_tokens is truncation accounting, never model
  // usage; fails_when=it is parsed, accumulated, or displayed as
  // cost (FR11).
  test("tool.result token counts stay activity, never usage", () => {
    const event = parseMuseLine(JSON.stringify({
      payload_type: "tool.result",
      payload: { kind: "tool_result", original_output_tokens: 1234 },
    }));
    expect(event).toEqual({ kind: "activity", payloadType: "tool.result" });
  });
});

describe("usageEventFromPayload", () => {
  // Value: protects=the usage seam's validation (full and partial
  // reports kept, malformed directions dropped, never coerced);
  // fails_when=a bad count becomes run cost or a partial report is
  // lost; why_new=the builder ships before any pinned shape.
  test("keeps valid directions, drops malformed ones, never zero-fills", () => {
    expect(usageEventFromPayload("run.usage.reported", {
      input_tokens: 12345,
      output_tokens: 4077,
      total_tokens: 16422,
    })).toEqual({ kind: "usage", inputTokens: 12345, outputTokens: 4077, totalTokens: 16422 });
    // Partial reports stay partial.
    expect(usageEventFromPayload("run.usage.reported", { input_tokens: 100 })).toEqual({
      kind: "usage",
      inputTokens: 100,
    });
    // One bad direction drops, the good one survives.
    expect(usageEventFromPayload("run.usage.reported", { input_tokens: -5, output_tokens: 40 })).toEqual({
      kind: "usage",
      outputTokens: 40,
    });
    expect(usageEventFromPayload("run.usage.reported", { input_tokens: 1.5, output_tokens: 40 })).toEqual({
      kind: "usage",
      outputTokens: 40,
    });
    expect(usageEventFromPayload("run.usage.reported", { input_tokens: "100", output_tokens: 40 })).toEqual({
      kind: "usage",
      outputTokens: 40,
    });
    expect(
      usageEventFromPayload("run.usage.reported", { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 40 }),
    ).toEqual({
      kind: "usage",
      inputTokens: Number.MAX_SAFE_INTEGER,
      outputTokens: 40,
    });
    expect(usageEventFromPayload("run.usage.reported", { input_tokens: Number.MAX_SAFE_INTEGER + 1 })).toEqual({
      kind: "other",
      payloadType: "run.usage.reported",
    });
    // No valid direction: visible as other, never zero-filled usage.
    expect(usageEventFromPayload("run.usage.reported", { input_tokens: -1 })).toEqual({
      kind: "other",
      payloadType: "run.usage.reported",
    });
    expect(usageEventFromPayload("run.usage.reported", {})).toEqual({
      kind: "other",
      payloadType: "run.usage.reported",
    });
    expect(usageEventFromPayload("run.usage.reported", undefined)).toEqual({
      kind: "other",
      payloadType: "run.usage.reported",
    });
    expect(usageEventFromPayload("run.usage.reported", "nope")).toEqual({
      kind: "other",
      payloadType: "run.usage.reported",
    });
    // Zero is a valid reported count, kept as reported.
    expect(usageEventFromPayload("run.usage.reported", { input_tokens: 0, output_tokens: 7 })).toEqual({
      kind: "usage",
      inputTokens: 0,
      outputTokens: 7,
    });
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
    // No in-progress item: the pending fallback is the displayed step.
    expect(currentStep([{ index: 0, status: "pending", text: "only pending" }])).toBe("only pending");
    expect(currentStep([])).toBeUndefined();
    expect(currentStep([{ index: 0, status: "completed", text: "done" }])).toBeUndefined();
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
