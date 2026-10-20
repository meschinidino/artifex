/**
 * Instruction write-back: guarded-append module plus the server
 * handler seam. Module tests run against tmp repos (no server);
 * handler tests dispatch through a fake agent and speak the real
 * wire. The working tree's own AGENTS.md is never touched — tmp
 * fixtures only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_INSTRUCTIONS_BYTES, WRITEBACK_SECTION_HEADER, type PatchMessage, type RunRecord } from "../floor-ui/wire.ts";
import { buildLessonEntry, formatEntryDate } from "../floor-ui/runs.ts";
import { appendWriteback, buildAppendBlock, safeAppendFile, targetHasSection, targetHasSectionText } from "./writeback.ts";
import { createFloorServer, type FloorServer } from "./index.ts";
import { authedClient, closeAllClients } from "./test-client.ts";
import type { SpawnFn } from "../agents/muse-adapter.ts";

const T0 = 1_760_000_000_000;
const terminal = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "12345678-aaaa-bbbb-cccc-000000000001",
  sessionId: "sess-1",
  prompt: "do the thing",
  startedAt: T0,
  endedAt: T0 + 65_000,
  state: "done",
  ...over,
});

function repoWithAgents(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-writeback-"));
  writeFileSync(join(dir, "AGENTS.md"), content);
  return dir;
}

describe("writeback block builder", () => {
  // Value: protects=FR12 placement (header created once after a
  // blank line, reused afterwards, trailing-newline respected);
  // fails_when=entries land outside the section or newlines glue.
  test("header created when absent, reused when present", () => {
    const entry = "- 2026-10-19 run 12345678 (done, 1m 5s): batch the reads";
    expect(buildAppendBlock("# Team standing orders\n", [entry])).toBe(
      `\n${WRITEBACK_SECTION_HEADER}\n${entry}\n`,
    );
    expect(buildAppendBlock("# Team standing orders", [entry])).toBe(
      `\n\n${WRITEBACK_SECTION_HEADER}\n${entry}\n`,
    );
    expect(buildAppendBlock("", [entry])).toBe(`${WRITEBACK_SECTION_HEADER}\n${entry}\n`);
    const withSection = `# Orders\n\n${WRITEBACK_SECTION_HEADER}\n- old entry\n`;
    expect(buildAppendBlock(withSection, [entry])).toBe(`${entry}\n`);
    expect(buildAppendBlock(`${withSection.slice(0, -1)}`, [entry])).toBe(`\n${entry}\n`);
    // A lesson merely mentioning the header is not the section.
    expect(targetHasSectionText(`# T\n\n- 2026-10-19 run abc (done, 1s): see ${WRITEBACK_SECTION_HEADER}\n`)).toBe(false);
    expect(targetHasSectionText(`# T\n\n${WRITEBACK_SECTION_HEADER}\n`)).toBe(true);
  });
});

describe("writeback guarded append", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const track = (dir: string): string => {
    dirs.push(dir);
    return dir;
  };

  // Value: protects=FR13 entry provenance (date, short id, outcome,
  // elapsed) and FR12's leave-everything-else-alone;
  // fails_when=the entry misattributes the run or touches a byte
  // outside the appended block.
  test("appends cited entries and leaves existing content byte-identical", () => {
    const before = "# Team standing orders\n\nFollow the plan.\n";
    const dir = track(repoWithAgents(before));
    const result = appendWriteback(dir, terminal(), ["batch the reads", "  ", "name the worker"], T0 + 65_000);
    expect(result).toEqual({ ok: true, text: "Recorded 2 lesson(s) in AGENTS.md." });
    const date = formatEntryDate(T0 + 65_000);
    const after = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(after).toBe(
      `${before}\n${WRITEBACK_SECTION_HEADER}\n` +
      `- ${date} run 12345678 (done, 1m 5s): batch the reads\n` +
      `- ${date} run 12345678 (done, 1m 5s): name the worker\n`,
    );
    // A second run's lessons reuse the section.
    const again = appendWriteback(dir, terminal({ id: "87654321-zzzz", state: "error" }), ["mind the timeout"], T0 + 70_000);
    expect(again.ok).toBe(true);
    const twice = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(twice).toContain(`- ${formatEntryDate(T0 + 70_000)} run 87654321 (error, 1m 5s): mind the timeout`);
    expect(twice.split(WRITEBACK_SECTION_HEADER).length - 1).toBe(1);
  });

  // Value: protects=FR15 caps (count refused with the cap named,
  // lines capped visibly, zero refused); fails_when=extras land,
  // long lines land whole, or empties record.
  test("caps: six lines refused, long lines truncated, empties refused", () => {
    const dir = track(repoWithAgents("# Orders\n"));
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const over = appendWriteback(dir, terminal(), ["a", "b", "c", "d", "e", "f"], T0);
    expect(over.ok).toBe(false);
    expect(over.text).toContain("At most 5 lessons per run");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
    expect(appendWriteback(dir, terminal(), ["  ", ""], T0).ok).toBe(false);
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
    const long = "y".repeat(500);
    const capped = appendWriteback(dir, terminal(), [long], T0);
    expect(capped.ok).toBe(true);
    const landed = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(landed).toContain(`${"y".repeat(279)}…`);
    expect(landed).not.toContain(long);
  });

  // Value: protects=FR15 split-before-count (embedded LF/CR/
  // U+2028/2029 split first, so the 5-line cap counts landed
  // lines and raw header smuggling lands cited, never bare);
  // fails_when=one wire element lands as several entry lines.
  test("embedded separators split before the cap; headers land cited", () => {
    const dir = track(repoWithAgents("# Orders\n"));
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    // One element, six lines: refused, naming the cap.
    const over = appendWriteback(dir, terminal(), ["a\nb\nc\nd\ne\nf"], T0);
    expect(over.ok).toBe(false);
    expect(over.text).toContain("At most 5 lessons per run");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
    // CR, CRLF, and U+2028/2029 count as breaks too.
    const mixed = appendWriteback(dir, terminal(), ["a\rb\r\nc\u2028d\u2029e\nf"], T0);
    expect(mixed.ok).toBe(false);
    expect(mixed.text).toContain("At most 5 lessons per run");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
    // A header-shaped lesson lands as cited entries, never a bare header.
    const ok = appendWriteback(dir, terminal(), [`one\n${WRITEBACK_SECTION_HEADER}\n# sneaky`], T0);
    expect(ok.ok).toBe(true);
    const landed = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(landed.split(WRITEBACK_SECTION_HEADER).length - 1).toBe(2); // section + one cited mention
    const tail = landed.slice(before.length).split("\n").filter((l) => l.length > 0);
    expect(tail[0]).toBe(WRITEBACK_SECTION_HEADER);
    expect(tail.length).toBe(4); // header + three cited entries
    for (const line of tail.slice(1)) expect(line.startsWith("- ")).toBe(true);
  });

  // Value: protects=FR11/FR16 refusals (missing, symlink file,
  // symlink parent, non-regular, oversize — each named, file
  // untouched); fails_when=any path writes or stays silent.
  test("missing, symlink, non-regular, and oversize targets refuse plainly", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artifex-writeback-")));
    expect(appendWriteback(dir, terminal(), ["x"], T0)).toEqual({
      ok: false,
      text: "No AGENTS.md at the repo root — create one to record lessons.",
    });
    writeFileSync(join(dir, "real.md"), "# real\n");
    symlinkSync(join(dir, "real.md"), join(dir, "AGENTS.md"));
    expect(lstatSync(join(dir, "AGENTS.md")).isSymbolicLink()).toBe(true);
    const linked = appendWriteback(dir, terminal(), ["x"], T0);
    expect(linked.ok).toBe(false);
    expect(linked.text).toContain("symlink");
    expect(readFileSync(join(dir, "real.md"), "utf8")).toBe("# real\n");
    // Symlinked parent: the repo root itself is a link.
    const outer = track(mkdtempSync(join(tmpdir(), "artifex-writeback-")));
    const inner = join(outer, "inner");
    mkdirSync(inner);
    writeFileSync(join(inner, "AGENTS.md"), "# inner\n");
    const alias = join(outer, "alias");
    symlinkSync(inner, alias);
    const viaAlias = appendWriteback(alias, terminal(), ["x"], T0);
    expect(viaAlias.ok).toBe(false);
    expect(viaAlias.text).toContain("refusing to write");
    expect(readFileSync(join(inner, "AGENTS.md"), "utf8")).toBe("# inner\n");
    // Non-regular target: a directory named AGENTS.md.
    const dirTarget = track(mkdtempSync(join(tmpdir(), "artifex-writeback-")));
    mkdirSync(join(dirTarget, "AGENTS.md"));
    const nonRegular = appendWriteback(dirTarget, terminal(), ["x"], T0);
    expect(nonRegular.ok).toBe(false);
    expect(nonRegular.text).toContain("not a regular file");
    // Oversize: refused off the stat, never fully read.
    const big = track(mkdtempSync(join(tmpdir(), "artifex-writeback-")));
    writeFileSync(join(big, "AGENTS.md"), `# big\n${"z".repeat(MAX_INSTRUCTIONS_BYTES)}`);
    const oversize = appendWriteback(big, terminal(), ["x"], T0);
    expect(oversize.ok).toBe(false);
    expect(oversize.text).toContain("over 256 KiB");
  });

  // Value: protects=FR16 hardlink honesty (a second name for
  // AGENTS.md refuses — bytes must not smuggle out another
  // path); fails_when=a hardlinked target records anyway.
  test("a hardlinked AGENTS.md refuses without writing", () => {
    const dir = track(repoWithAgents("# Orders\n"));
    const file = join(dir, "AGENTS.md");
    linkSync(file, join(dir, "alias.md"));
    expect(statSync(file).nlink).toBe(2);
    const result = appendWriteback(dir, terminal(), ["x"], T0);
    expect(result.ok).toBe(false);
    expect(result.text).toContain("refusing to write");
    expect(readFileSync(file, "utf8")).toBe("# Orders\n");
  });

  // Value: protects=the descriptor-validated append (symlink,
  // non-regular, and identity-swapped targets throw a refusal;
  // the write lands only through the checked descriptor);
  // fails_when=a swapped path is followed instead of refused.
  test("safeAppendFile refuses links and swaps, appends the checked file", () => {
    const dir = track(mkdtempSync(join(tmpdir(), "artifex-writeback-")));
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, "# Orders\n");
    const { dev, ino } = statSync(file);
    safeAppendFile(file, "- entry\n", { dev, ino });
    expect(readFileSync(file, "utf8")).toBe("# Orders\n- entry\n");
    // A symlink at the path refuses (O_NOFOLLOW), never follows.
    const target = join(dir, "real.md");
    writeFileSync(target, "# real\n");
    const link = join(dir, "link.md");
    symlinkSync(target, link);
    expect(() => safeAppendFile(link, "- evil\n", undefined)).toThrow("refusing to write");
    expect(readFileSync(target, "utf8")).toBe("# real\n");
    // A non-regular file refuses.
    expect(() => safeAppendFile(dir, "- evil\n", undefined)).toThrow("refusing to write");
    // A replaced file (same path, new inode) refuses against the
    // identity the block was prepared for. The alias pins the old
    // inode so the replacement cannot reuse it: Linux reuses a
    // freed inode immediately, which would make old and new
    // identities equal and the refusal untestable.
    linkSync(file, join(dir, "pinned.md"));
    rmSync(file);
    writeFileSync(file, "# Orders v2\n");
    const now = statSync(file);
    expect(now.ino).not.toBe(ino);
    expect(() => safeAppendFile(file, "- stale\n", { dev, ino })).toThrow("refusing to write");
    expect(readFileSync(file, "utf8")).toBe("# Orders v2\n");
    // A missing file refuses (never created).
    expect(() => safeAppendFile(join(dir, "nope.md"), "- x\n", undefined)).toThrow("refusing to write");
  });

  // Value: protects=FR16 unreachable-root honesty (a missing
  // root and a file passed as a root refuse — never a throw out
  // of the handler); fails_when=either shape escapes as an
  // exception instead of a plain-words ack.
  test("unreachable and non-directory roots refuse plainly", () => {
    const outer = track(mkdtempSync(join(tmpdir(), "artifex-writeback-")));
    const missing = appendWriteback(join(outer, "nope"), terminal(), ["x"], T0);
    expect(missing.ok).toBe(false);
    expect(missing.text).toContain("not reachable");
    const fileRoot = join(outer, "file-root");
    writeFileSync(fileRoot, "not a dir");
    const notDir = appendWriteback(fileRoot, terminal(), ["x"], T0);
    expect(notDir.ok).toBe(false);
    expect(notDir.text).toContain("not a real directory");
  });

  // Value: protects=FR16 unreadable-target honesty (an
  // unopenable file refuses instead of throwing the handler);
  // fails_when=the open throw escapes (or, as root, the guard
  // this test documents is skipped and the write proceeds).
  test("unreadable target refuses without writing", () => {
    // Root reads through permission bits: the refusal this pins
    // is unobservable there, so the probe steps aside.
    if (process.getuid?.() === 0) return;
    const dir = track(repoWithAgents("# Orders\n"));
    const file = join(dir, "AGENTS.md");
    chmodSync(file, 0o000);
    try {
      const result = appendWriteback(dir, terminal(), ["x"], T0);
      expect(result.ok).toBe(false);
      expect(result.text).toContain("Could not read AGENTS.md");
    } finally {
      chmodSync(file, 0o644);
    }
    expect(readFileSync(file, "utf8")).toBe("# Orders\n");
  });

  // Value: protects=FR14 WYSIWYG masking (a pasted secret cannot
  // silently land in a root file — the masked form lands);
  // fails_when=secret-shaped lesson text lands raw.
  test("secret-shaped lessons land masked", () => {
    const dir = track(repoWithAgents("# Orders\n"));
    const result = appendWriteback(dir, terminal(), ['const API_KEY = "sk-live-abc"'], T0);
    expect(result.ok).toBe(true);
    const landed = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(landed).toContain("const API_KEY = [masked]");
    expect(landed).not.toContain("sk-live-abc");
  });

  // Value: protects=FR16 append-failure honesty (a failed write is
  // a plain-words ack, never a crash or a silent loss);
  // fails_when=the throw escapes or reports success.
  test("append failure refuses cleanly", () => {
    const dir = track(repoWithAgents("# Orders\n"));
    const before = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const result = appendWriteback(dir, terminal(), ["x"], T0, {
      appendFile: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("Could not write to AGENTS.md");
    expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toBe(before);
  });

  // Value: protects=the snapshot section flag (present/absent
  // reads, every refusal reads absent); fails_when=the preview
  // header decision loses its signal.
  test("targetHasSection reads the flag, refusals read absent", () => {
    const dir = track(repoWithAgents(`# Orders\n\n${WRITEBACK_SECTION_HEADER}\n- old\n`));
    expect(targetHasSection(dir)).toBe(true);
    const bare = track(repoWithAgents("# Orders\n"));
    expect(targetHasSection(bare)).toBe(false);
    const missing = track(mkdtempSync(join(tmpdir(), "artifex-writeback-")));
    expect(targetHasSection(missing)).toBe(false);
    const linked = track(mkdtempSync(join(tmpdir(), "artifex-writeback-")));
    writeFileSync(join(linked, "real.md"), `${WRITEBACK_SECTION_HEADER}\n`);
    symlinkSync(join(linked, "real.md"), join(linked, "AGENTS.md"));
    expect(targetHasSection(linked)).toBe(false);
  });
});

describe("writeback handler seam", () => {
  // Minimal fake agent: dispatch spawns, finish ends the run
  // terminal (the ghost suite's proven shapes).
  const terminalLine = JSON.stringify({ payload_type: "run.terminal.completed" });
  const fakeAgent = (): { spawnFn: SpawnFn; finish: (code?: number) => void } => {
    const queue: string[] = [];
    let done = false;
    let waiter: (() => void) | undefined;
    let resolveExit: ((code: number | null) => void) | undefined;
    const exited = new Promise<number | null>((r) => {
      resolveExit = r;
    });
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
      killGroup: () => {},
    });
    return {
      spawnFn,
      finish: (code = 0) => {
        queue.push(terminalLine);
        done = true;
        waiter?.();
        resolveExit?.(code);
      },
    };
  };

  let floor: FloorServer | undefined;
  let repo: string | undefined;
  afterEach(() => {
    closeAllClients();
    floor?.stop();
    floor = undefined;
    if (repo) rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  });

  const fixtureRepo = (agents: string | undefined): string => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-writeback-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "b.ts"), "export function b(): number {\n  return 2;\n}\n");
    if (agents !== undefined) writeFileSync(join(dir, "AGENTS.md"), agents);
    return dir;
  };

  // Value: protects=FR8/FR10 + AC3 (terminal run appends exactly
  // the previewed block, acks ok:true to the requester only);
  // fails_when=the write misses, the ack goes wide, or the diff
  // touches anything else.
  test("terminal run appends the block and acks ok:true to the requester only", async () => {
    const before = "# Team standing orders\n";
    repo = fixtureRepo(before);
    const fake = fakeAgent();
    floor = await createFloorServer({ repo, port: 0, agent: { spawnFn: fake.spawnFn } });
    const first = await authedClient(floor);
    expect(first.snapshot.hasLessonsSection).toBe(false);
    const second = await authedClient(floor);
    first.client.send({ v: 1, type: "dispatch", text: "do the thing" });
    fake.finish(0);
    const runId = await first.client.waitFor(
      (m): m is PatchMessage =>
        m.type === "patch" && m.runs !== undefined && m.runs.some((r) => r.state !== "running"),
      "terminal run patch",
      15_000,
    ).then((p) => (p as PatchMessage).runs!.find((r) => r.state !== "running")!.id);
    const secondMark = second.client.messages.length;
    first.client.send({ v: 1, type: "writeback", runId, lessons: ["batch the reads"] });
    const ack = await first.client.waitFor((m) => m.type === "writeback-result", "writeback ack");
    expect(ack).toMatchObject({ runId, ok: true, text: "Recorded 1 lesson(s) in AGENTS.md." });
    const run = floor.runs().find((r) => r.id === runId)!;
    const expected = buildLessonEntry(run, "batch the reads", formatEntryDate(Date.now()));
    const after = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(`\n${WRITEBACK_SECTION_HEADER}\n${expected}\n`);
    // Requester-only: the second socket never sees the ack.
    await new Promise((r) => setTimeout(r, 300));
    expect(second.client.messages.slice(secondMark).some((m) => m.type === "writeback-result")).toBe(false);
  });

  // Value: protects=FR10 server re-validation (unknown ids and
  // live runs refuse even when the client claims otherwise);
  // fails_when=the server trusts the client (writes for a ghost
  // run or a run with no outcome yet).
  test("unknown and running runs refuse; nothing is written", async () => {
    const before = "# Orders\n";
    repo = fixtureRepo(before);
    const fake = fakeAgent();
    floor = await createFloorServer({ repo, port: 0, agent: { spawnFn: fake.spawnFn } });
    const { client } = await authedClient(floor);
    client.send({ v: 1, type: "writeback", runId: "no-such-run", lessons: ["x"] });
    const unknown = await client.waitFor((m) => m.type === "writeback-result", "unknown-run ack");
    expect(unknown).toMatchObject({ runId: "no-such-run", ok: false, text: "Unknown run." });
    const mark = client.messages.length;
    client.send({ v: 1, type: "dispatch", text: "slow work" });
    const running = (await client.waitFor(
      (m): m is PatchMessage =>
        m.type === "patch" && m.runs !== undefined && m.runs.some((r) => r.state === "running"),
      "running run patch",
      15_000,
      mark,
    )) as PatchMessage;
    const liveId = running.runs!.find((r) => r.state === "running")!.id;
    client.send({ v: 1, type: "writeback", runId: liveId, lessons: ["too soon"] });
    const refused = await client.waitFor(
      (m) => m.type === "writeback-result" && (m as { runId?: string }).runId === liveId,
      "running-run ack",
    );
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { text: string }).text).toContain("still running");
    fake.finish(0);
    await client.waitFor(
      (m): m is PatchMessage =>
        m.type === "patch" && m.runs !== undefined && m.runs.some((r) => r.id === liveId && r.state !== "running"),
      "run end",
      15_000,
    );
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(before);
  });

  // Value: protects=FR15 server-side caps against a raw client
  // (six lines refuse naming the cap, long lines cap visibly);
  // fails_when=the server trusts client-side trimming.
  test("raw over-cap messages are refused or capped server-side", async () => {
    repo = fixtureRepo("# Orders\n");
    const fake = fakeAgent();
    floor = await createFloorServer({ repo, port: 0, agent: { spawnFn: fake.spawnFn } });
    const { client } = await authedClient(floor);
    client.send({ v: 1, type: "dispatch", text: "cap work" });
    fake.finish(0);
    const runId = await client.waitFor(
      (m): m is PatchMessage =>
        m.type === "patch" && m.runs !== undefined && m.runs.some((r) => r.state !== "running"),
      "terminal run patch",
      15_000,
    ).then((p) => (p as PatchMessage).runs!.find((r) => r.state !== "running")!.id);
    const before = readFileSync(join(repo, "AGENTS.md"), "utf8");
    client.send({ v: 1, type: "writeback", runId, lessons: ["  a  ", "", "b", "c", "d", "e", "f"] });
    const over = await client.waitFor((m) => m.type === "writeback-result", "over-cap ack");
    expect(over).toMatchObject({ ok: false });
    expect((over as { text: string }).text).toContain("At most 5 lessons per run");
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(before);
    const long = "q".repeat(500);
    client.send({ v: 1, type: "writeback", runId, lessons: [long] });
    const capped = await client.waitFor(
      (m) => m.type === "writeback-result" && (m as { ok?: boolean }).ok === true,
      "capped ack",
    );
    expect(capped).toMatchObject({ ok: true });
    const landed = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(landed).toContain(`${"q".repeat(279)}…`);
    expect(landed).not.toContain(long);
  });

  // Value: protects=FR11 over the wire (a repo without AGENTS.md
  // refuses naming the path — never creates it);
  // fails_when=the server creates the file or stays silent.
  test("missing AGENTS.md refuses over the wire without creating it", async () => {
    repo = fixtureRepo(undefined);
    const fake = fakeAgent();
    floor = await createFloorServer({ repo, port: 0, agent: { spawnFn: fake.spawnFn } });
    const { client, snapshot } = await authedClient(floor);
    expect(snapshot.hasLessonsSection).toBe(false);
    client.send({ v: 1, type: "dispatch", text: "missing-file work" });
    fake.finish(0);
    const runId = await client.waitFor(
      (m): m is PatchMessage =>
        m.type === "patch" && m.runs !== undefined && m.runs.some((r) => r.state !== "running"),
      "terminal run patch",
      15_000,
    ).then((p) => (p as PatchMessage).runs!.find((r) => r.state !== "running")!.id);
    client.send({ v: 1, type: "writeback", runId, lessons: ["nowhere to land"] });
    const ack = await client.waitFor((m) => m.type === "writeback-result", "missing-file ack");
    expect(ack).toMatchObject({ ok: false });
    expect((ack as { text: string }).text).toContain("No AGENTS.md at the repo root");
    expect(() => lstatSync(join(repo!, "AGENTS.md"))).toThrow();
  });

  // Value: protects=the snapshot section flag over the wire (a
  // repo whose file already holds the section reports true);
  // fails_when=the flag lies (previews show a header that will
  // not land, or hide one that will).
  test("snapshot reports the section flag when the file holds it", async () => {
    repo = fixtureRepo(`# Orders\n\n${WRITEBACK_SECTION_HEADER}\n- old\n`);
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const { snapshot } = await authedClient(floor);
    expect(snapshot.hasLessonsSection).toBe(true);
  });

  // Value: protects=malformed writeback shapes (not a runId
  // string, not a lessons array — the existing bad-message path);
  // fails_when=garbage reaches the ledger lookup or the disk.
  test("malformed writeback shapes fail as bad-message", async () => {
    repo = fixtureRepo("# Orders\n");
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const before = readFileSync(join(repo, "AGENTS.md"), "utf8");
    const { client } = await authedClient(floor);
    client.send({ v: 1, type: "writeback", runId: 42, lessons: ["x"] });
    const first = await client.waitFor((m) => m.type === "error", "first shape error");
    expect(first).toMatchObject({ code: "bad-message" });
    const mark = client.messages.length;
    client.send({ v: 1, type: "writeback", runId: "x", lessons: "not-an-array" });
    const secondErr = await client.waitFor((m) => m.type === "error", "second shape error", 5_000, mark);
    expect(secondErr).toMatchObject({ code: "bad-message" });
    expect(readFileSync(join(repo, "AGENTS.md"), "utf8")).toBe(before);
  });
});
