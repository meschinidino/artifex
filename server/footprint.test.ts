/**
 * Footprint overlays: server status lifecycle, tombstones, and the
 * footprint wire fields. Injected-runner tests pin the debounce,
 * diffing, and failure semantics deterministically (a fake `.git`
 * dir is enough — git itself is never spawned); real-git tests run
 * the true `git status` path over throwaway repos.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "./index.ts";
import { readGitStatus, type GitStatusMap } from "../watcher/gitstatus.ts";
import type { PatchMessage, SnapshotMessage } from "../floor-ui/wire.ts";
import { authedClient, byPath, closeAllClients, type Client } from "./test-client.ts";

let floor: FloorServer | undefined;
let repo: string | undefined;
let extraRepos: string[] = [];

afterEach(() => {
  closeAllClients();
  floor?.stop();
  floor = undefined;
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
  for (const dir of extraRepos) rmSync(dir, { recursive: true, force: true });
  extraRepos = [];
});

const hasGit = Bun.which("git") !== null;

type Runner = (repoRoot: string, timeoutMs: number) => Promise<GitStatusMap | undefined>;
const statusMap = (entries: [string, "added" | "modified" | "removed"][]): GitStatusMap => new Map(entries);

/** Scripted runner: answers maps[k] on call k (last repeats), counting calls. */
function scriptRunner(maps: (GitStatusMap | undefined)[]): { runner: Runner; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    runner: async () => maps[Math.min(calls++, maps.length - 1)],
  };
}

/** Plain two-file repo, no git. */
function plainRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-foot-plain-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
  return dir;
}

/** Fake gitdir: marks the label git-backed without needing the binary. */
function fakeGit(dir: string): string {
  const gitdir = join(dir, ".git");
  mkdirSync(gitdir, { recursive: true });
  return gitdir;
}

function git(cwd: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${proc.stderr.toString().trim().slice(0, 200)}`);
  }
}

function commitAll(cwd: string, msg: string): void {
  git(cwd, "add", "-A");
  git(cwd, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-m", msg);
}

/** Real git repo: three committed files under src/. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-foot-git-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(dir, "src", "c.ts"), "export const c = 1;\n");
  git(dir, "init", "-b", "main");
  commitAll(dir, "base");
  return dir;
}

/** Capture console.error lines across an async block (warn assertions). */
async function captureConsoleError(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.error;
  console.error = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.error = orig;
  }
  return lines;
}

/**
 * Snapshot guaranteed past the first status read: the boot read may
 * still be in flight when the first snapshot sends, so resync once
 * it lands. Deterministic either order.
 */
async function awaitFootedSnapshot(client: Client, snapshot: SnapshotMessage): Promise<SnapshotMessage> {
  if (snapshot.footAvailable.length > 0) return snapshot;
  const mark = client.messages.length;
  await client.waitFor(
    (m) => m.type === "patch" && ((m as PatchMessage).footAvailable?.length ?? 0) > 0,
    "foot available patch",
    10_000,
    mark,
  );
  const mark2 = client.messages.length;
  client.send({ v: 1, type: "resync" });
  return (await client.waitFor((m) => m.type === "snapshot", "resync snapshot", 5_000, mark2)) as SnapshotMessage;
}

describe("footprint status lifecycle (injected runner)", () => {
  // Value: protects=boot stamping the first snapshot when git
  // answers fast (an immediately-resolved read lands during boot,
  // before any client connects); fails_when=the boot read is
  // skipped or mis-stamped (first paint shows no footprints).
  test("boot stamps the first snapshot when the read lands in time", async () => {
    repo = plainRepo();
    fakeGit(repo);
    const { runner } = scriptRunner([statusMap([["src/a.ts", "modified"]])]);
    floor = await createFloorServer({ repo, port: 0, status: { runner } });
    const { snapshot } = await authedClient(floor);
    expect(snapshot.footAvailable).toEqual([""]);
    expect(byPath(snapshot.buildings).get("src/a.ts")?.foot).toBe("modified");
    expect(byPath(snapshot.buildings).get("src/b.ts")?.foot).toBeUndefined();
    expect(snapshot.removed).toEqual([]);
    expect(snapshot.removedUnplotted).toEqual([]);
  }, 30_000);

  // Value: protects=patch-follows when the boot read is slow (the
  // first snapshot sends clean-but-unknown, the late result arrives
  // as an ordinary patch); fails_when=boot blocks on git (slow
  // repos hang the floor) or the late result is dropped.
  test("a slow boot read follows as an ordinary patch", async () => {
    repo = plainRepo();
    fakeGit(repo);
    let resolveRun!: (v: GitStatusMap | undefined) => void;
    const gate = new Promise<GitStatusMap | undefined>((r) => {
      resolveRun = r;
    });
    let calls = 0;
    floor = await createFloorServer({
      repo,
      port: 0,
      status: {
        runner: async () => {
          calls++;
          return gate;
        },
      },
    });
    const { client, snapshot } = await authedClient(floor);
    expect(calls).toBe(1);
    expect(snapshot.footAvailable).toEqual([]);
    expect(byPath(snapshot.buildings).get("src/a.ts")?.foot).toBeUndefined();
    const mark = client.messages.length;
    resolveRun(statusMap([["src/a.ts", "added"]]));
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/a.ts" && b.foot === "added"),
      "late foot patch",
      10_000,
      mark,
    )) as PatchMessage;
    expect(patch.footAvailable).toEqual([""]);
    expect(calls).toBe(1);
  }, 30_000);

  // Value: protects=the async spawn contract (a hung status read
  // never blocks boot or flushes); fails_when=any path awaits the
  // runner (a wedged git freezes the floor).
  test("a hung status read blocks neither boot nor flushes", async () => {
    repo = plainRepo();
    fakeGit(repo);
    floor = await createFloorServer({
      repo,
      port: 0,
      status: { runner: async () => new Promise<GitStatusMap | undefined>(() => {}) },
    });
    const { client, snapshot } = await authedClient(floor);
    expect(snapshot.footAvailable).toEqual([]);
    const mark = client.messages.length;
    writeFileSync(join(repo, "src", "live.ts"), "export const l = 1;\n");
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/live.ts"),
      "flush patch during hung status",
      10_000,
      mark,
    )) as PatchMessage;
    expect(patch.footAvailable).toBeUndefined();
    expect(patch.upsert.some((b) => b.path === "src/live.ts")).toBe(true);
  }, 30_000);

  // Value: protects=path-by-path status diffing (only buildings
  // whose foot changed upsert); fails_when=the diff drops (every
  // re-read upserts the world: patch storms, wasted renders).
  test("a re-read upserts only buildings whose foot changed", async () => {
    repo = plainRepo();
    const gitdir = fakeGit(repo);
    const { runner } = scriptRunner([
      statusMap([
        ["src/a.ts", "modified"],
        ["src/b.ts", "modified"],
      ]),
      statusMap([["src/a.ts", "modified"]]),
    ]);
    floor = await createFloorServer({ repo, port: 0, status: { runner, debounceMs: 50 } });
    const { client, snapshot } = await authedClient(floor);
    expect(byPath(snapshot.buildings).get("src/a.ts")?.foot).toBe("modified");
    expect(byPath(snapshot.buildings).get("src/b.ts")?.foot).toBe("modified");
    // A gitdir `index` touch re-reads status with no tree change, so
    // the patch carries status diffs only.
    const mark = client.messages.length;
    writeFileSync(join(gitdir, "index"), "fake-index\n");
    const patch = (await client.waitFor(
      (m) =>
        m.type === "patch" &&
        (m as PatchMessage).upsert.some((b) => b.path === "src/b.ts" && b.foot === undefined),
      "foot-clear patch",
      10_000,
      mark,
    )) as PatchMessage;
    expect(patch.upsert.map((b) => b.path)).toEqual(["src/b.ts"]);
    // The footprint sets did not move, so no full replacement rides
    // along (the ghosts precedent: unchanged sets stay unsent).
    expect(patch.footAvailable).toBeUndefined();
    expect(patch.removedMarks).toBeUndefined();
    expect(patch.removedUnplotted).toBeUndefined();
  }, 30_000);

  // Value: protects=the per-label debounce with its trailing
  // dirty flag (a trigger burst runs once more, not once per
  // trigger); fails_when=the debounce drops (keystroke-rate git
  // spawns) or the trailing run drops (stale footprints).
  test("rapid triggers coalesce to one trailing run", async () => {
    repo = plainRepo();
    const gitdir = fakeGit(repo);
    const { runner, calls } = scriptRunner([statusMap([])]);
    floor = await createFloorServer({ repo, port: 0, status: { runner, debounceMs: 2000 } });
    await authedClient(floor);
    expect(calls()).toBe(1);
    for (let i = 0; i < 5; i++) writeFileSync(join(gitdir, "index"), `fake-index-${i}\n`);
    const deadline = Date.now() + 8_000;
    while (calls() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toBe(2);
    await new Promise((r) => setTimeout(r, 300));
    expect(calls()).toBe(2);
  }, 30_000);

  // Value: protects=disk truth over status contradictions (a live
  // building never carries a mark, a foot, or an unplotted count
  // for a `removed` verdict); fails_when=the veto drops (a ghost
  // GONE marker or count contradicts a visible machine).
  test("a live building vetoes removed verdicts everywhere", async () => {
    repo = plainRepo();
    fakeGit(repo);
    const { runner } = scriptRunner([statusMap([["src/a.ts", "removed"]])]);
    floor = await createFloorServer({ repo, port: 0, status: { runner } });
    const { snapshot } = await authedClient(floor);
    expect(snapshot.footAvailable).toEqual([""]);
    expect(byPath(snapshot.buildings).get("src/a.ts")?.foot).toBeUndefined();
    expect(snapshot.removed).toEqual([]);
    expect(snapshot.removedUnplotted).toEqual([]);
  }, 30_000);

  // Value: protects=status-failure degradation (unavailable hides
  // footprints with a warn, never a fake clean; the next trigger
  // retries and recovery restores); fails_when=failure caches as
  // clean, recovery drops, or the warn stays silent.
  test("status failure hides footprints; the next trigger retries", async () => {
    repo = plainRepo();
    const gitdir = fakeGit(repo);
    const { runner } = scriptRunner([undefined, statusMap([["src/a.ts", "added"]])]);
    floor = await createFloorServer({ repo, port: 0, status: { runner, debounceMs: 50 } });
    const { client, snapshot } = await authedClient(floor);
    expect(snapshot.footAvailable).toEqual([]);
    expect(byPath(snapshot.buildings).get("src/a.ts")?.foot).toBeUndefined();
    const mark = client.messages.length;
    writeFileSync(join(gitdir, "index"), "fake-index\n");
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/a.ts" && b.foot === "added"),
      "recovery patch",
      10_000,
      mark,
    )) as PatchMessage;
    expect(patch.footAvailable).toEqual([""]);
  }, 30_000);

  // Value: protects=warn-once outage semantics (boot failures
  // warn like transitions — MV5 — but a still-broken label does
  // not re-warn every trigger); fails_when=boot stays silent (an
  // operator never learns git is missing) or every retry warns
  // (log spam at 0.5 Hz while git is down).
  test("an outage warns once until recovery", async () => {
    repo = plainRepo();
    const gitdir = fakeGit(repo);
    const { runner, calls } = scriptRunner([undefined, undefined, statusMap([]), undefined]);
    const waitCalls = async (n: number): Promise<void> => {
      const deadline = Date.now() + 5_000;
      while (calls() < n && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
      expect(calls()).toBe(n);
    };
    const warns = await captureConsoleError(async () => {
      floor = await createFloorServer({ repo: repo!, port: 0, status: { runner, debounceMs: 50 } });
      await authedClient(floor!);
      await waitCalls(1);
      // Distinct sizes per touch: each re-read must see a moved
      // signature even when two writes land in the same millisecond.
      writeFileSync(join(gitdir, "index"), "i1\n");
      await waitCalls(2);
      writeFileSync(join(gitdir, "index"), "i222\n");
      await waitCalls(3);
      writeFileSync(join(gitdir, "index"), "i333333\n");
      await waitCalls(4);
    });
    const outageWarns = warns.filter((w) => w.includes("git status unavailable"));
    expect(outageWarns).toHaveLength(2);
  }, 30_000);

  // Value: protects=runner exceptions degrading like failures (a
  // throwing status source hides footprints, never crashes the
  // trigger); fails_when=the throw escapes (watcher callback or
  // boot dies on a status bug).
  test("a throwing runner degrades without crashing", async () => {
    repo = plainRepo();
    fakeGit(repo);
    const warns = await captureConsoleError(async () => {
      floor = await createFloorServer({
        repo: repo!,
        port: 0,
        status: {
          runner: async (): Promise<GitStatusMap | undefined> => {
            throw new Error("boom");
          },
        },
      });
      const { snapshot } = await authedClient(floor!);
      expect(snapshot.footAvailable).toEqual([]);
    });
    expect(warns.some((w) => w.includes("git status failed") && w.includes("boom"))).toBe(true);
  }, 30_000);

  // Value: protects=non-git labels never being queried (no spawn,
  // no foot, no availability); fails_when=a label without `.git`
  // is queried (spawn failures on walk-fallback floors).
  test("labels without .git are never queried", async () => {
    repo = plainRepo();
    const { runner, calls } = scriptRunner([statusMap([["src/a.ts", "added"]])]);
    floor = await createFloorServer({ repo, port: 0, status: { runner } });
    const { client, snapshot } = await authedClient(floor);
    expect(calls()).toBe(0);
    expect(snapshot.footAvailable).toEqual([]);
    expect(snapshot.removed).toEqual([]);
    expect(byPath(snapshot.buildings).get("src/a.ts")?.foot).toBeUndefined();
    const mark = client.messages.length;
    writeFileSync(join(repo, "src", "touch.ts"), "export const t = 1;\n");
    await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/touch.ts"),
      "content patch",
      10_000,
      mark,
    );
    expect(calls()).toBe(0);
  }, 30_000);

  // Value: protects=the unresolvable-gitdir fallback (a `.git`
  // file with a garbage pointer: no index/HEAD watch, but boot
  // and flush triggers still re-read); fails_when=the fallback
  // throws (floors with odd gitdirs fail boot) or skips reads.
  test("a garbage .git pointer falls back to boot and flush triggers", async () => {
    repo = plainRepo();
    writeFileSync(join(repo, ".git"), "not a pointer\n");
    const { runner, calls } = scriptRunner([statusMap([["src/a.ts", "modified"]])]);
    floor = await createFloorServer({ repo, port: 0, status: { runner, debounceMs: 50 } });
    const { client, snapshot } = await authedClient(floor);
    expect(calls()).toBe(1);
    expect(snapshot.footAvailable).toEqual([""]);
    expect(byPath(snapshot.buildings).get("src/a.ts")?.foot).toBe("modified");
    const mark = client.messages.length;
    writeFileSync(join(repo, "src", "touch.ts"), "export const t = 1;\n");
    await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/touch.ts"),
      "flush patch",
      10_000,
      mark,
    );
    const deadline = Date.now() + 5_000;
    while (calls() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toBe(2);
  }, 30_000);

  // Value: protects=tombstone zones surviving the last-file
  // deletion (snapshot + patch keep the pad the GONE marks draw
  // on); fails_when=the zone drops (marks float without a pad).
  test("deleting a zone's last file keeps the zone for its tombstones", async () => {
    repo = plainRepo();
    fakeGit(repo);
    const { runner } = scriptRunner([
      statusMap([]),
      statusMap([
        ["src/a.ts", "removed"],
        ["src/b.ts", "removed"],
      ]),
    ]);
    floor = await createFloorServer({ repo, port: 0, status: { runner, debounceMs: 50 } });
    const { client, snapshot } = await authedClient(floor);
    expect(snapshot.zones.some((z) => z.id === "src")).toBe(true);
    const mark = client.messages.length;
    unlinkSync(join(repo, "src", "a.ts"));
    unlinkSync(join(repo, "src", "b.ts"));
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && ((m as PatchMessage).removedMarks?.length ?? 0) === 2,
      "tombstone patch",
      10_000,
      mark,
    )) as PatchMessage;
    expect(patch.zones.some((z) => z.id === "src")).toBe(true);
    expect(patch.total).toBe(0);
    const mark2 = client.messages.length;
    client.send({ v: 1, type: "resync" });
    const snap = (await client.waitFor((m) => m.type === "snapshot", "resync snapshot", 5_000, mark2)) as SnapshotMessage;
    expect(snap.zones.some((z) => z.id === "src")).toBe(true);
    expect(snap.removed.map((r) => r.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
  }, 30_000);

  // Value: protects=subdir labels being queried (an ancestor
  // .git makes the label git-backed) with stripped rels stamping
  // members; fails_when=the gate still wants .git at the root
  // (subdir floors lose every overlay, silently).
  test("a subdir label of a work tree is queried and stamps members", async () => {
    const parent = mkdtempSync(join(tmpdir(), "artifex-foot-subgate-"));
    extraRepos.push(parent);
    fakeGit(parent);
    const sub = join(parent, "sub");
    mkdirSync(join(sub, "src"), { recursive: true });
    writeFileSync(join(sub, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(sub, "src", "b.ts"), "export const b = 1;\n");
    const { runner, calls } = scriptRunner([statusMap([["src/a.ts", "modified"]])]);
    floor = await createFloorServer({ repo: sub, port: 0, status: { runner, debounceMs: 50 } });
    const { client, snapshot } = await authedClient(floor);
    const footed = await awaitFootedSnapshot(client, snapshot);
    expect(calls()).toBeGreaterThan(0);
    expect(footed.footAvailable).toEqual([""]);
    const buildings = byPath(footed.buildings);
    expect(buildings.get("src/a.ts")?.foot).toBe("modified");
    expect(buildings.get("src/b.ts")?.foot).toBeUndefined();
  }, 30_000);
});

describe.skipIf(!hasGit)("footprint over real git", () => {
  // Value: protects=boot reading the true `git status` path
  // (added + modified verdicts land without any trigger);
  // fails_when=the spawn/parse/stamp chain drifts from real git.
  test("boot reads land with added and modified verdicts", async () => {
    repo = gitRepo();
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const footed = await awaitFootedSnapshot(client, snapshot);
    expect(footed.footAvailable).toEqual([""]);
    const buildings = byPath(footed.buildings);
    expect(buildings.get("src/a.ts")?.foot).toBe("modified");
    expect(buildings.get("src/new.ts")?.foot).toBe("added");
    expect(buildings.get("src/b.ts")?.foot).toBeUndefined();
    expect(footed.removed).toEqual([]);
    expect(footed.removedUnplotted).toEqual([]);
  }, 30_000);

  // Value: protects=tombstone promotion (a live-observed deletion
  // draws a mark at the deleted file's old slot, excluded from
  // the unplotted count); fails_when=capture/promotion drops (no
  // GONE marker) or misplaces (marker at the wrong slot).
  test("a live deletion promotes a mark at the old slot", async () => {
    repo = gitRepo();
    floor = await createFloorServer({ repo, port: 0, status: { debounceMs: 50 } });
    const { client, snapshot } = await authedClient(floor);
    const before = byPath(snapshot.buildings).get("src/b.ts")!;
    const mark = client.messages.length;
    unlinkSync(join(repo, "src", "b.ts"));
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && ((m as PatchMessage).removedMarks?.some((r) => r.path === "src/b.ts") ?? false),
      "tombstone patch",
      10_000,
      mark,
    )) as PatchMessage;
    const found = patch.removedMarks!.find((r) => r.path === "src/b.ts")!;
    expect(found).toMatchObject({ zoneId: before.zoneId, x: before.x, y: before.y, band: before.band });
    expect(patch.removedUnplotted ?? []).not.toContain("src/b.ts");
  }, 30_000);

  // Value: protects=commit-clears without reload (an external
  // commit lands via the index/HEAD watch: footprints clear,
  // availability stays); fails_when=the gitdir watch drops
  // (stale footprints until the 60 s backstop).
  test("committing everything clears foot and marks", async () => {
    repo = gitRepo();
    floor = await createFloorServer({ repo, port: 0, status: { debounceMs: 50 } });
    const { client } = await authedClient(floor);
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
    unlinkSync(join(repo, "src", "b.ts"));
    let mark = client.messages.length;
    await client.waitFor(
      (m) => m.type === "patch" && ((m as PatchMessage).removedMarks?.some((r) => r.path === "src/b.ts") ?? false),
      "mark patch",
      10_000,
      mark,
    );
    mark = client.messages.length;
    client.send({ v: 1, type: "resync" });
    const footed = (await client.waitFor((m) => m.type === "snapshot", "footed snapshot", 5_000, mark)) as SnapshotMessage;
    expect(byPath(footed.buildings).get("src/a.ts")?.foot).toBe("modified");
    expect(byPath(footed.buildings).get("src/new.ts")?.foot).toBe("added");
    expect(footed.removed.map((r) => r.path)).toEqual(["src/b.ts"]);
    commitAll(repo, "clear");
    mark = client.messages.length;
    const cleared = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).removedMarks !== undefined && (m as PatchMessage).removedMarks!.length === 0,
      "commit-clears patch",
      15_000,
      mark,
    )) as PatchMessage;
    expect(cleared.footAvailable).toEqual([""]);
    expect(cleared.removedUnplotted).toEqual([]);
    expect(cleared.upsert.find((b) => b.path === "src/a.ts")?.foot).toBeUndefined();
    expect(cleared.upsert.find((b) => b.path === "src/new.ts")?.foot).toBeUndefined();
  }, 30_000);

  // Value: protects=pre-boot deletions counting without a marker
  // (FR6: no live observation, no slot — the -R count still
  // covers them); fails_when=unobserved removals vanish entirely
  // (silent undercount) or gain phantom markers.
  test("a pre-boot deletion is counted but unplotted", async () => {
    repo = gitRepo();
    unlinkSync(join(repo, "src", "b.ts"));
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const footed = await awaitFootedSnapshot(client, snapshot);
    expect(footed.footAvailable).toEqual([""]);
    expect(footed.removed).toEqual([]);
    expect(footed.removedUnplotted).toEqual(["src/b.ts"]);
  }, 30_000);

  // Value: protects=slot-reuse drops (an unrelated file taking a
  // tombstone's slot drops the marker instead of drawing under
  // the new machine; the path demotes to unplotted);
  // fails_when=the prune drops (GONE draws under a live machine).
  test("slot reuse drops the mark and demotes the path to unplotted", async () => {
    repo = gitRepo();
    floor = await createFloorServer({ repo, port: 0, status: { debounceMs: 50 } });
    const { client, snapshot } = await authedClient(floor);
    const before = byPath(snapshot.buildings).get("src/b.ts")!;
    let mark = client.messages.length;
    unlinkSync(join(repo, "src", "b.ts"));
    await client.waitFor(
      (m) => m.type === "patch" && ((m as PatchMessage).removedMarks?.some((r) => r.path === "src/b.ts") ?? false),
      "mark patch",
      10_000,
      mark,
    );
    // Same zone, lowest-free-wins: the new file takes b.ts's slot.
    mark = client.messages.length;
    writeFileSync(join(repo, "src", "z-new.ts"), "export const z = 1;\n");
    const patch = (await client.waitFor(
      (m) =>
        m.type === "patch" &&
        (m as PatchMessage).upsert.some((b) => b.path === "src/z-new.ts") &&
        (m as PatchMessage).removedMarks !== undefined,
      "reuse patch",
      10_000,
      mark,
    )) as PatchMessage;
    const fresh = patch.upsert.find((b) => b.path === "src/z-new.ts")!;
    expect({ zoneId: fresh.zoneId, x: fresh.x, y: fresh.y }).toEqual({ zoneId: before.zoneId, x: before.x, y: before.y });
    expect(patch.removedMarks).toEqual([]);
    expect(patch.removedUnplotted).toEqual(["src/b.ts"]);
  }, 30_000);

  // Value: protects=relayout drops (an explicit re-lay clears
  // staged and drawn tombstones — old slots are meaningless);
  // fails_when=marks survive (GONE floats at a stale slot).
  test("an explicit relayout drops every mark", async () => {
    repo = gitRepo();
    floor = await createFloorServer({ repo, port: 0, status: { debounceMs: 50 } });
    const { client } = await authedClient(floor);
    let mark = client.messages.length;
    unlinkSync(join(repo, "src", "b.ts"));
    await client.waitFor(
      (m) => m.type === "patch" && ((m as PatchMessage).removedMarks?.some((r) => r.path === "src/b.ts") ?? false),
      "mark patch",
      10_000,
      mark,
    );
    mark = client.messages.length;
    client.send({ v: 1, type: "relayout" });
    const relaid = (await client.waitFor((m) => m.type === "snapshot", "relayout snapshot", 10_000, mark)) as SnapshotMessage;
    expect(relaid.removed).toEqual([]);
    expect(relaid.removedUnplotted).toEqual(["src/b.ts"]);
  }, 30_000);

  // Value: protects=linked-worktree floors (`.git` as a file: the
  // gitdir pointer resolves, status stamps, watches attach);
  // fails_when=pointer resolution drops (worktree floors show no
  // footprints) or boot throws on the file shape.
  test("a linked worktree resolves its gitdir and stamps foot", async () => {
    const main = gitRepo();
    extraRepos.push(main);
    const parent = join(tmpdir(), `artifex-foot-wt-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(parent, { recursive: true });
    extraRepos.push(parent);
    const wt = join(parent, "wt");
    git(main, "worktree", "add", wt, "-b", "wt-branch");
    writeFileSync(join(wt, "src", "a.ts"), "export const a = 99;\n");
    repo = wt;
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const footed = await awaitFootedSnapshot(client, snapshot);
    expect(footed.footAvailable).toEqual([""]);
    expect(byPath(footed.buildings).get("src/a.ts")?.foot).toBe("modified");
  }, 30_000);

  // Settle helper: boot-time watcher traffic differs by platform
  // (Linux inotify reports events that macOS FSEvents coalesces),
  // so tests wait for quiet instead of asserting exact boot counts.
  async function quiesceCalls(read: () => number, quietMs = 600, deadlineMs = 5_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    let last = read();
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const now = read();
      if (now !== last) {
        last = now;
        quietSince = Date.now();
      } else if (Date.now() - quietSince >= quietMs) {
        return;
      }
    }
  }

  // Value: protects=the HEAD half of the gitdir watch (a branch
  // switch re-reads status with no tree change — Bun reports it
  // as HEAD.lock churn); fails_when=lock names are filtered out
  // (branch switches go stale until the 60 s backstop).
  test("a branch switch re-reads status with no tree change", async () => {
    repo = gitRepo();
    let calls = 0;
    floor = await createFloorServer({
      repo,
      port: 0,
      status: {
        debounceMs: 200,
        runner: async (root, timeoutMs) => {
          calls++;
          return readGitStatus(root, { timeoutMs });
        },
      },
    });
    const { client } = await authedClient(floor);
    await quiesceCalls(() => calls);
    const baseline = calls;
    const mark = client.messages.length;
    git(repo, "checkout", "-b", "side");
    const deadline = Date.now() + 5_000;
    while (calls <= baseline && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBeGreaterThan(baseline);
    // Purity guard: a branch switch with an identical tree touches
    // no worktree file, so no content patch may accompany the run —
    // the re-read came from the gitdir path alone.
    expect(
      client.messages.slice(mark).filter((m) => m.type === "patch").flatMap((m) => (m as PatchMessage).upsert),
    ).toEqual([]);
  }, 30_000);

  // Value: protects=gitdir echo suppression (a status run's own
  // index rewrite must not re-trigger: the floor settles instead
  // of self-looping every debounce window); fails_when=the
  // signature gate drops (a perpetual git status spawn loop).
  test("status runs settle instead of self-triggering", async () => {
    repo = gitRepo();
    let calls = 0;
    floor = await createFloorServer({
      repo,
      port: 0,
      status: {
        debounceMs: 200,
        runner: async (root, timeoutMs) => {
          calls++;
          return readGitStatus(root, { timeoutMs });
        },
      },
    });
    await authedClient(floor);
    await quiesceCalls(() => calls);
    const baseline = calls;
    // A content edit (modify-only: no verify rescan follows it).
    writeFileSync(join(repo, "src", "a.ts"), "export const a = 2;\n");
    const deadline = Date.now() + 5_000;
    while (calls <= baseline && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBeGreaterThan(baseline);
    // Let the edit's own event train land first (Linux can
    // deliver it as two separate runs where FSEvents coalesces
    // one), then open the quiet window.
    await quiesceCalls(() => calls);
    // Seven debounce windows of quiet: any echo retrigger would
    // have fired more runs by now. Settle means the count stops
    // growing, whatever its absolute value.
    const before = calls;
    await new Promise((r) => setTimeout(r, 1500));
    expect(calls).toBe(before);
  }, 30_000);

  // Value: protects=per-label aggregation on federated floors (a
  // git district stamps while its non-git sibling contributes
  // nothing); fails_when=labels leak (availability or verdicts
  // cross districts).
  test("federated floors aggregate per label", async () => {
    const parent = mkdtempSync(join(tmpdir(), "artifex-foot-fed-"));
    extraRepos.push(parent);
    const alpha = join(parent, "alpha");
    mkdirSync(join(alpha, "src"), { recursive: true });
    writeFileSync(join(alpha, "src", "a.ts"), "export const a = 1;\n");
    git(alpha, "init", "-b", "main");
    commitAll(alpha, "base");
    writeFileSync(join(alpha, "src", "a.ts"), "export const a = 2;\n");
    const beta = join(parent, "beta");
    mkdirSync(join(beta, "src"), { recursive: true });
    writeFileSync(join(beta, "src", "b.ts"), "export const b = 1;\n");
    floor = await createFloorServer({ repo: alpha, repos: [alpha, beta], port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const footed = await awaitFootedSnapshot(client, snapshot);
    expect(footed.footAvailable).toEqual(["alpha"]);
    const buildings = byPath(footed.buildings);
    expect(buildings.get("alpha/src/a.ts")?.foot).toBe("modified");
    expect(buildings.get("beta/src/b.ts")?.foot).toBeUndefined();
  }, 30_000);

  // Value: protects=the full subdir path over real git (served
  // subdir root: status queried, prefix stripped, in-scope edit
  // footed, out-of-scope edit invisible); fails_when=any link
  // drops (the gate's Q2 has no map signal).
  test("a served subdir root footprints its own edits only", async () => {
    const parent = mkdtempSync(join(tmpdir(), "artifex-foot-subdir-"));
    extraRepos.push(parent);
    mkdirSync(join(parent, "sub", "src"), { recursive: true });
    writeFileSync(join(parent, "sub", "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(parent, "sub", "src", "b.ts"), "export const b = 1;\n");
    writeFileSync(join(parent, "top.ts"), "export const t = 1;\n");
    git(parent, "init", "-b", "main");
    commitAll(parent, "base");
    writeFileSync(join(parent, "sub", "src", "a.ts"), "export const a = 2;\n");
    writeFileSync(join(parent, "top.ts"), "export const t = 2;\n");
    floor = await createFloorServer({ repo: join(parent, "sub"), port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const footed = await awaitFootedSnapshot(client, snapshot);
    expect(footed.footAvailable).toEqual([""]);
    const buildings = byPath(footed.buildings);
    expect(buildings.get("src/a.ts")?.foot).toBe("modified");
    expect(buildings.get("src/b.ts")?.foot).toBeUndefined();
    expect(footed.removed).toEqual([]);
  }, 30_000);
});
