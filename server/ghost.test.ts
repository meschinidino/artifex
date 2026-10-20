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

const textLine = (text: string): string =>
  JSON.stringify({ payload_type: "run.output.delta", payload: { kind: "run_output_delta", text } });

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
      expect(floor.runs()).toEqual([]);
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("run ledger: dispatch history for the session viewer", () => {
  // Value: protects=the ledger contract (prompt + running at
  // dispatch, terminal state + endedAt at exit, carried on patches
  // and snapshots); fails_when=a run is missing, mis-stated, or
  // never reaches the client.
  test("dispatch records a running run; exit marks it done on patches and snapshots", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-runs-done-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000e1";
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
      const working = (await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "running",
        "running run patch",
        10_000,
      )) as PatchMessage;
      expect(working.runs).toHaveLength(1);
      expect(working.runs![0]).toMatchObject({ prompt: "create the files", state: "running", sessionId });
      expect(working.runs![0]!.endedAt).toBeUndefined();
      expect(working.runs![0]!.startedAt).toBeLessThanOrEqual(Date.now());
      expect(floor.runs()).toHaveLength(1);
      fake.finish(0);
      const doneMark = client.messages.length;
      const done = (await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "done",
        "done run patch",
        10_000,
        doneMark,
      )) as PatchMessage;
      expect(done.runs![0]!.endedAt).toBeGreaterThanOrEqual(done.runs![0]!.startedAt);
      expect(done.runs![0]!.detail).toBeUndefined();
      const second = await authedClient(floor);
      expect(second.snapshot.runs).toHaveLength(1);
      expect(second.snapshot.runs[0]).toMatchObject({ prompt: "create the files", state: "done" });
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=stop honesty in the ledger (a stopped run is
  // "stopped", never done-or-error); fails_when=stop is recorded
  // as done like a clean exit.
  test("stop-agent marks the run stopped with an end time", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-runs-stop-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000e2";
    const fake = fakeAgent();
    let floor: FloorServer | undefined;
    try {
      floor = await createFloorServer({
        repo,
        port: 0,
        agent: { spawnFn: fake.spawnFn, sessionId, timeoutMs: 120_000 },
      });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "stop me" });
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "running",
        "running run patch",
        10_000,
      );
      const mark = client.messages.length;
      client.send({ v: 1, type: "stop-agent" });
      const stopped = (await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "stopped",
        "stopped run patch",
        15_000,
        mark,
      )) as PatchMessage;
      expect(stopped.runs![0]!.endedAt).toBeGreaterThanOrEqual(stopped.runs![0]!.startedAt);
      expect(stopped.runs![0]!.detail).toBeUndefined();
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=spawn-failure visibility (a run that never
  // started is error-with-cause, not stuck running);
  // fails_when=a spawn throw leaves a running run forever.
  test("spawn failure marks the run error with the cause", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-runs-spawn-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000e3";
    let floor: FloorServer | undefined;
    try {
      const throwing: SpawnFn = () => {
        throw new Error("boom");
      };
      floor = await createFloorServer({ repo, port: 0, agent: { spawnFn: throwing, sessionId } });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "go" });
      const notice = await client.waitFor((m) => m.type === "notice", "failed-to-start notice", 10_000);
      expect(notice.type === "notice" && notice.text.includes("failed to start")).toBe(true);
      expect(floor.runs()).toHaveLength(1);
      expect(floor.runs()[0]).toMatchObject({ prompt: "go", state: "error", detail: "boom" });
      expect(floor.runs()[0]!.endedAt).toBeDefined();
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=prompt secrecy in the ledger (masked exactly
  // like the prompt-sent event, never raw); fails_when=a secret
  // in the prompt reaches any client surface unmasked.
  test("run prompts carry the masked logged copy, matching prompt-sent", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-runs-mask-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000e4";
    const fake = fakeAgent();
    let floor: FloorServer | undefined;
    try {
      floor = await createFloorServer({
        repo,
        port: 0,
        agent: { spawnFn: fake.spawnFn, sessionId, timeoutMs: 120_000 },
      });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "deploy using\npassword = \"supersecret1\"\nfor staging" });
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "running",
        "running run patch",
        10_000,
      );
      const prompt = floor.runs()[0]!.prompt;
      expect(prompt).toContain("[masked]");
      expect(prompt).not.toContain("supersecret1");
      const sent = floor.eventLog.find((e) => e.type === "prompt-sent");
      expect(sent?.type === "prompt-sent" ? sent.text : undefined).toBe(prompt);
      fake.finish(0);
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=the answer channel end to end (delta
  // fragments concatenate onto the run live and survive its end,
  // so Q&A runs leave a visible trace); fails_when=answer text
  // is dropped or lost at exit.
  test("answer text accumulates from deltas and survives run end", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-runs-answer-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000e6";
    const fake = fakeAgent();
    let floor: FloorServer | undefined;
    try {
      floor = await createFloorServer({
        repo,
        port: 0,
        agent: { spawnFn: fake.spawnFn, sessionId, timeoutMs: 120_000 },
      });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "tell me about this file" });
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "running",
        "running run patch",
        10_000,
      );
      const mark = client.messages.length;
      fake.emit(textLine("The file contains "));
      fake.emit(textLine("only a heading."));
      const answered = (await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.answer === "The file contains only a heading.",
        "answered run patch",
        10_000,
        mark,
      )) as PatchMessage;
      expect(answered.runs![0]!.state).toBe("running");
      fake.finish(0);
      const exitMark = client.messages.length;
      const done = (await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "done",
        "done run patch",
        10_000,
        exitMark,
      )) as PatchMessage;
      expect(done.runs![0]!.answer).toBe("The file contains only a heading.");
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=the answer bound (heads kept, truncation
  // visible, memory capped); fails_when=a long answer grows the
  // ledger without limit or truncates silently.
  test("long answers cap visibly at 4000 chars", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-runs-answercap-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000e7";
    const fake = fakeAgent();
    let floor: FloorServer | undefined;
    try {
      floor = await createFloorServer({
        repo,
        port: 0,
        agent: { spawnFn: fake.spawnFn, sessionId, timeoutMs: 120_000 },
      });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "summarize everything" });
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "running",
        "running run patch",
        10_000,
      );
      const mark = client.messages.length;
      fake.emit(textLine("y".repeat(5000)));
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.answer !== undefined,
        "answered run patch",
        10_000,
        mark,
      );
      const answer = floor.runs()[0]!.answer!;
      expect(answer.length).toBe(4000);
      expect(answer.endsWith("…")).toBe(true);
      fake.finish(0);
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=run-cost truth end to end (tool.result's
  // original_output_tokens is truncation accounting, never model
  // usage); fails_when=a tool-result line stamps usage onto the
  // run; why_new=run cost readout (FR11).
  test("tool.result token counts never become run usage", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-runs-notoolusage-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000e8";
    const fake = fakeAgent();
    let floor: FloorServer | undefined;
    try {
      floor = await createFloorServer({
        repo,
        port: 0,
        agent: { spawnFn: fake.spawnFn, sessionId, timeoutMs: 120_000 },
      });
      const { client } = await authedClient(floor);
      client.send({ v: 1, type: "dispatch", text: "use a tool" });
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.state === "running",
        "running run patch",
        10_000,
      );
      const mark = client.messages.length;
      fake.emit(JSON.stringify({
        payload_type: "tool.result",
        payload: { kind: "tool_result", original_output_tokens: 4321 },
      }));
      // A delta behind it proves the tool line was consumed.
      fake.emit(textLine("done"));
      await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).runs?.[0]?.answer === "done",
        "answered run patch",
        10_000,
        mark,
      );
      expect(floor.runs()[0]!.usage).toBeUndefined();
      fake.finish(0);
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 60_000);

  // Value: protects=the ledger bound (memory cannot grow with
  // dispatches; oldest drops first); fails_when=the cap is
  // removed and runs accumulate without limit.
  test("ledger keeps the newest 30 runs, oldest drops first", async () => {
    const repo = mkdtempSync(join(tmpdir(), "artifex-runs-cap-"));
    writeFileSync(join(repo, "README.md"), "# scratch\n");
    const sessionId = "00000000-0000-4000-8000-0000000000e5";
    const fake = fakeAgent();
    let floor: FloorServer | undefined;
    try {
      floor = await createFloorServer({
        repo,
        port: 0,
        agent: { spawnFn: fake.spawnFn, sessionId, timeoutMs: 120_000 },
      });
      const { client } = await authedClient(floor);
      for (let i = 0; i <= 30; i++) {
        const mark = client.messages.length;
        client.send({ v: 1, type: "dispatch", text: `task ${i}` });
        await client.waitFor(
          (m) => m.type === "patch" && (m as PatchMessage).runs?.at(-1)?.prompt === `task ${i}`,
          `run ${i} recorded`,
          10_000,
          mark,
        );
        fake.finish(0);
        // Later cycles reuse the spent fake (no terminal line seen),
        // so they end error, not done — terminal either way, which
        // is all the cap needs. Both waits share the cycle-start
        // mark: a reused fake can exit before finish() is called,
        // and the prompt match keeps stale patches out anyway.
        await client.waitFor(
          (m) =>
            m.type === "patch" &&
            (m as PatchMessage).runs?.at(-1)?.prompt === `task ${i}` &&
            (m as PatchMessage).runs?.at(-1)?.state !== "running",
          `run ${i} terminal`,
          10_000,
          mark,
        );
      }
      expect(floor.runs()).toHaveLength(30);
      expect(floor.runs()[0]!.prompt).toBe("task 1");
      expect(floor.runs().at(-1)!.prompt).toBe("task 30");
    } finally {
      closeAllClients();
      floor?.stop();
      rmSync(repo, { recursive: true, force: true });
    }
  }, 120_000);
});
