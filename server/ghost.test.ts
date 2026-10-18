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
  // Queue lives at fake level: lines emitted before the server's
  // enqueued dispatch actually spawns must not be lost (real
  // process output can't arrive before the process, but the test's
  // send→emit sequence races the server's dispatch task).
  const queue: string[] = [];
  let done = false;
  let waiter: (() => void) | undefined;
  let resolveExit: ((code: number | null) => void) | undefined;
  const exited = new Promise<number | null>((r) => {
    resolveExit = r;
  });
  const push = (line: string) => {
    queue.push(line);
    waiter?.();
  };
  const spawnFn: SpawnFn = () => ({
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
      // A real process closes its pipes when it dies: end stdout
      // too, or the adapter waits forever on drained lines.
      if (signal === "SIGKILL") {
        done = true;
        waiter?.();
        resolveExit?.(137);
      }
    },
  });
  return {
    spawnFn,
    emit: push,
    finish: (code = 0) => {
      push(terminalLine);
      done = true;
      waiter?.();
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
      // One lifecycle line keeps the plan's gate activity fresh
      // (observed heartbeat) while the agent works.
      fake.emit(JSON.stringify({ payload_type: "task.lifecycle.started" }));
      const ghostPatch = (await client.waitFor(
        (m) => m.type === "patch" && ((m as PatchMessage).ghosts?.length ?? 0) >= 2,
        "ghosts patch",
        10_000,
      )) as PatchMessage;
      expect(ghostPatch.ghosts!.map((g) => g.path).sort()).toEqual(["never.txt", "new.txt"]);
      expect(floor.ghosts().every((g) => g.state === "planned")).toBe(true);
      expect(floor.eventLog.some((e) => e.type === "started" && e.provenance === "observed")).toBe(true);
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

  // Value: protects=the three remaining lifecycle edges: human
  // stop ends done (not error), a crashed agent reports error with
  // detail, and an idle plan abandons via the sweep without exit;
  // fails_when=stop is misreported or stalled ghosts linger forever.
  test("stop, crash, and idle abandons resolve distinctly", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-ghost-lifecycle-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000cc";
    let floor: FloorServer | undefined;
    try {
      // Stop: dispatch, plan appears, stop-agent → done/stopped.
      const fake1 = fakeAgent();
      floor = await createFloorServer({ repo, port: 0, agent: { spawnFn: fake1.spawnFn, sessionId, timeoutMs: 120_000 } });
      {
        const { client } = await authedClient(floor);
        client.send({ v: 1, type: "dispatch", text: "stop me" });
        fake1.emit(todoLine([{ index: 0, status: "in_progress", text: "Create later.txt" }], sessionId));
        await client.waitFor((m) => m.type === "patch" && ((m as PatchMessage).ghosts?.length ?? 0) >= 1, "ghost", 10_000);
        const mark = client.messages.length;
        // Second dispatch while working is refused out loud.
        client.send({ v: 1, type: "dispatch", text: "again" });
        const refusal = await client.waitFor((m) => m.type === "notice", "already-working refusal", 10_000, mark);
        expect(refusal.type === "notice" && refusal.text.includes("already working")).toBe(true);
        client.send({ v: 1, type: "stop-agent" });
      }
      await Bun.sleep(2_600); // stop grace: SIGTERM, then the fake SIGKILL lands
      expect(floor.agentStatus().state).toBe("done");
      expect(floor.agentStatus().detail).toBe("stopped");
      floor.stop();

      // Idle abandon: tiny idle window + fast sweep, run stays alive.
      const fake2 = fakeAgent();
      floor = await createFloorServer({
        repo,
        port: 0,
        agent: { spawnFn: fake2.spawnFn, sessionId, idleTimeoutMs: 400, sweepMs: 200, timeoutMs: 120_000 },
      });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "stall" });
      fake2.emit(todoLine([{ index: 0, status: "in_progress", text: "Create stalled.txt" }], sessionId));
      await client.waitFor(
        (m) => m.type === "patch" && ((m as PatchMessage).ghosts?.some((g) => g.state === "abandoned") ?? false),
        "idle abandon",
        15_000,
      );
      // Crash: exit 1 without terminal → error, detail carries exit.
      const mark = client.messages.length;
      fake2.finish(1);
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).agent?.state === "error",
        "error status",
        10_000,
        mark,
      );
      expect(floor.agentStatus().detail).toContain("exit 1");
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 90_000);

  // Value: protects=restart honesty (D20): intent seen before a
  // relaunch rebuilds from the durable log, but a human write with
  // no run active resolves the ghost as superseded — NEVER an
  // intended solidify; fails_when=a post-restart write is claimed
  // as agent intent.
  test("ghosts rebuild after restart; a human write supersedes, never solidifies", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-ghost-restart-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000dd";
    let floor: FloorServer | undefined;
    try {
      const fake = fakeAgent();
      floor = await createFloorServer({ repo, port: 0, agent: { spawnFn: fake.spawnFn, sessionId, timeoutMs: 120_000 } });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "make resume.txt" });
      fake.emit(todoLine([{ index: 0, status: "in_progress", text: "Create resume.txt" }], sessionId));
      await client.waitFor((m) => m.type === "patch" && ((m as PatchMessage).ghosts?.length ?? 0) >= 1, "ghost before restart", 10_000);
      closeAllClients();
      floor.stop();

      // Relaunch watch-only: ghosts come back from the log alone.
      floor = await createFloorServer({ repo, port: 0, agent: false });
      const second = await authedClient(floor);
      expect(second.snapshot.ghosts.map((g) => g.path)).toEqual(["resume.txt"]);
      expect(second.snapshot.ghosts[0]!.state).toBe("planned");
      const mark = second.client.messages.length;
      writeFileSync(join(repo, "resume.txt"), "by hand\n");
      await second.client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).ghosts !== undefined && (m as PatchMessage).ghosts!.length === 0,
        "superseded ghost clears",
        15_000,
        mark,
      );
      expect(
        floor.eventLog.some((e) => e.type === "file-written" && e.provenance === "intended"),
      ).toBe(false);
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 90_000);

  // Value: protects=input validation order at dispatch (empty
  // prompt refused before spawn; missing binary blocks loudly);
  // fails_when=a blank prompt spawns an agent or a missing muse
  // fails silently.
  test("empty prompt and missing binary both refuse before spawn", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-ghost-refusals-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    let floor: FloorServer | undefined;
    try {
      const fake = fakeAgent();
      floor = await createFloorServer({ repo, port: 0, agent: { spawnFn: fake.spawnFn } });
      {
        const { client } = await authedClient(floor);
        client.send({ v: 1, type: "dispatch", text: "   " });
        const notice = await client.waitFor((m) => m.type === "notice", "empty-prompt notice", 10_000);
        expect(notice.type === "notice" && notice.text.includes("Type a prompt first")).toBe(true);
        expect(floor.agentStatus().state).toBe("idle");
      }
      closeAllClients();
      floor.stop();
      floor = await createFloorServer({ repo, port: 0, agent: { command: "artifex-no-such-binary-xyz" } });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "anything" });
      const notice = await client.waitFor((m) => m.type === "notice", "missing-binary notice", 10_000);
      expect(notice.type === "notice" && notice.text.includes("not found on PATH")).toBe(true);
      expect(floor.agentStatus().state).toBe("error");
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
