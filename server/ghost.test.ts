/**
 * Ghost layer integration (D7/D8/D20): dispatch → planned ghosts →
 * solidify on write → abandon leftovers at run end. The agent is a
 * fake spawn replaying the measured muse JSONL shapes — this test
 * proves the floor-side wiring only; the real muse end-to-end is
 * verified live (see README "Ghost layer"), never claimed here.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "./index.ts";
import { authedClient, closeAllClients } from "./test-client.ts";
import type { SpawnFn, TodoItem } from "../agents/muse-adapter.ts";
import type { PatchMessage } from "../floor-ui/wire.ts";

const todoLine = (items: TodoItem[], sessionId: string): string =>
  JSON.stringify({
    payload_type: "todo.snapshot.updated",
    stream: { kind: "session", id: sessionId },
    payload: { facts: { revision_id: 1, items } },
  });

const terminalLine = JSON.stringify({ payload_type: "run.terminal.completed" });

type Fake = {
  spawnFn: SpawnFn;
  emit(line: string): void;
  finish(code?: number): void;
};

function fakeAgent(): Fake {
  let push: ((line: string) => void) | undefined;
  let end: (() => void) | undefined;
  let resolveExit: ((code: number | null) => void) | undefined;
  const exited = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  const spawnFn: SpawnFn = () => {
    const queue: string[] = [];
    let done = false;
    let waiter: (() => void) | undefined;
    push = (line) => {
      queue.push(line);
      waiter?.();
    };
    end = () => {
      done = true;
      waiter?.();
    };
    return {
      stdout: (async function* () {
        for (;;) {
          while (queue.length > 0) yield queue.shift()!;
          if (done) return;
          await new Promise<void>((r) => {
            waiter = r;
          });
        }
      })(),
      stderr: (async function* () {})(),
      exited,
      killGroup: (signal) => {
        if (signal === "SIGKILL") resolveExit?.(137);
      },
    };
  };
  return {
    spawnFn,
    emit: (line) => push?.(line),
    finish: (code = 0) => {
      push?.(terminalLine);
      end?.();
      resolveExit?.(code);
    },
  };
}

describe("ghost layer: dispatch lifecycle", () => {
  // Value: protects=the whole ghost contract end to end (planned →
  // ghost patch → intended solidify → abandoned at exit);
  // fails_when=any link breaks (adapter lines ignored, write not
  // bound, leftovers not abandoned); why_new=first live dispatch.
  test("planned ghosts appear, a write solidifies as intended, leftovers abandon at exit", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-ghost-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000aa";
    const fake = fakeAgent();
    let floor: FloorServer | undefined;
    try {
      floor = await createFloorServer({
        repo,
        port: 0,
        agent: { spawnFn: fake.spawnFn, sessionId, timeoutMs: 120_000 },
      });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "create the files" });
      // Agent status flips to working on its own patch.
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).agent?.state === "working",
        "agent working patch",
        10_000,
      );
      fake.emit(todoLine([
        { index: 0, status: "in_progress", text: "Create new.txt" },
        { index: 1, status: "pending", text: "Create never.txt" },
      ], sessionId));
      const ghostPatch = (await client.waitFor(
        (m) => m.type === "patch" && ((m as PatchMessage).ghosts?.length ?? 0) >= 2,
        "ghosts patch",
        10_000,
      )) as PatchMessage;
      expect(ghostPatch.ghosts!.map((g) => g.path).sort()).toEqual(["never.txt", "new.txt"]);
      expect(floor.ghosts().every((g) => g.state === "planned")).toBe(true);
      expect(floor.eventLog.some((e) => e.type === "planned")).toBe(true);
      expect(floor.eventLog.some((e) => e.type === "prompt-sent")).toBe(true);

      // The write lands while the run is active: bound solidify.
      // fromIndex keeps the negative predicate from matching the
      // empty-ghosts patch the dispatch itself flushed.
      const writeMark = client.messages.length;
      writeFileSync(join(repo, "new.txt"), "hello\n");
      await client.waitFor(
        (m) =>
          m.type === "patch" &&
          (m as PatchMessage).ghosts !== undefined &&
          (m as PatchMessage).ghosts!.every((g) => g.path !== "new.txt"),
        "solidified ghost patch",
        15_000,
        writeMark,
      );
      const intended = floor.eventLog.find(
        (e) => e.type === "file-written" && e.provenance === "intended",
      );
      expect(intended).toBeDefined();
      if (intended?.type === "file-written" && intended.provenance === "intended") {
        expect(intended.path).toBe("new.txt");
        expect(intended.by).toBe("agent");
      }

      // Run ends with an unwritten plan: abandoned, not silently cut.
      const exitMark = client.messages.length;
      fake.finish(0);
      await client.waitFor(
        (m) =>
          m.type === "patch" &&
          ((m as PatchMessage).ghosts?.some((g) => g.path === "never.txt" && g.state === "abandoned") ?? false),
        "abandoned ghost patch",
        15_000,
        exitMark,
      );
      expect(floor.eventLog.some((e) => e.type === "abandoned-plan")).toBe(true);
      expect(floor.agentStatus().state).toBe("done");
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=dispatch refusal is explicit when no agent is
  // configured (never a silent no-op); fails_when=--agent none floors
  // pretend SEND works.
  test("dispatch with agent disabled is refused out loud", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-ghost-off-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    let floor: FloorServer | undefined;
    try {
      floor = await createFloorServer({ repo, port: 0, agent: false });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "anything" });
      const notice = await client.waitFor((m) => m.type === "notice", "refusal notice", 10_000);
      expect(notice.type === "notice" && notice.text.includes("no agent connected")).toBe(true);
      expect(floor.agentStatus().state).toBe("idle");
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});
