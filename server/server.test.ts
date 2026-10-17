import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "./index.ts";
import type { PatchMessage } from "../floor-ui/wire.ts";
import { authedClient, byPath, closeAllClients, connectClient } from "./test-client.ts";

let floor: FloorServer | undefined;
let repo: string | undefined;

afterEach(() => {
  closeAllClients();
  floor?.stop();
  floor = undefined;
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-server-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  mkdirSync(join(dir, "py"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), "export function a(): number {\n  return 1;\n}\n");
  writeFileSync(join(dir, "src", "bad.ts"), "export function broken( { return ; }\n");
  writeFileSync(join(dir, "src", "secret.ts"), "const API_TOKEN = 'supersecretvalue';\nexport const ok = 1;\n");
  writeFileSync(join(dir, "py", "bad.py"), "def broken(:\n    return\n");
  writeFileSync(join(dir, "data.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
  writeFileSync(join(dir, ".env"), "REAL_SECRET=do-not-leak\nDATABASE_URL=postgres://user:TOPSECRET@db.internal/app\n");
  // Alias to the env file: neither the symlink nor a case variant may
  // be rendered (review regression: both used to leak unmasked).
  symlinkSync(join(dir, ".env"), join(dir, "src", "leak.txt"));
  return dir;
}

describe("floor server integration", () => {
  test("boot: snapshot matches disk with parse states; auth and path safety enforced", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });

    // HTML carries the token; a foreign Host is refused.
    const htmlResponse = await fetch(floor.url);
    expect(htmlResponse.headers.get("x-frame-options")).toBe("DENY");
    expect(htmlResponse.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    const html = await htmlResponse.text();
    // The token must land in the client global, not just anywhere in
    // the page (a placeholder collision once broke browser auth).
    expect(html).toContain(`window.__ARTIFEX_TOKEN__ = "${floor.token}"`);
    const foreignStatus = await new Promise<number>((resolveStatus) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: floor!.port, path: "/", headers: { host: "evil.example:9999" } },
        (res) => resolveStatus(res.statusCode ?? 0),
      );
      req.on("error", () => resolveStatus(0));
      req.end();
    });
    expect(foreignStatus).toBe(403);

    // Wrong token: error then close.
    const bad = await connectClient(floor.port);
    bad.send({ v: 1, type: "auth", token: "nope" });
    const authErr = await bad.waitFor((m) => m.type === "error", "bad-auth error");
    expect(authErr).toMatchObject({ code: "bad-auth" });

    const { client, snapshot } = await authedClient(floor);
    expect(snapshot.stateVersion).toBe(1);
    const buildings = byPath(snapshot.buildings);
    // The in-repo symlink is a building like any tracked file; it
    // still must not be openable (asserted below).
    expect([...buildings.keys()].sort()).toEqual(
      [".env", "data.bin", "py/bad.py", "src/a.ts", "src/bad.ts", "src/leak.txt", "src/secret.ts"],
    );
    expect(snapshot.total).toBe(7);
    expect(buildings.get("src/a.ts")).toMatchObject({ parse: "ok", lines: 3 });
    expect(buildings.get("src/bad.ts")?.parse).toBe("error");
    expect(buildings.get("src/bad.ts")?.parseError).toContain("parse error");
    expect(buildings.get("py/bad.py")?.parse).toBe("error");
    expect(buildings.get("data.bin")).toMatchObject({ binary: true, lines: 0, band: 0 });
    expect(floor.eventLog).toBeDefined();

    // open-file safety: traversal, env, masking, binary.
    client.send({ v: 1, type: "open-file", path: "../outside.txt" });
    expect(await client.waitFor((m) => m.type === "error" && m.code === "bad-path", "bad-path")).toBeDefined();
    client.send({ v: 1, type: "open-file", path: ".env" });
    expect(await client.waitFor((m) => m.type === "error" && m.code === "masked-file", "masked-file")).toBeDefined();
    // Checkpointed: the bare history scan would match the .env
    // error above and pass without testing these variants.
    let mark = client.messages.length;
    client.send({ v: 1, type: "open-file", path: "src/leak.txt" });
    expect(await client.waitFor((m) => m.type === "error" && m.code === "masked-file", "masked-file via symlink", 5_000, mark)).toBeDefined();
    mark = client.messages.length;
    client.send({ v: 1, type: "open-file", path: ".ENV" });
    expect(await client.waitFor((m) => m.type === "error" && m.code === "masked-file", "masked-file via case", 5_000, mark)).toBeDefined();
    client.send({ v: 1, type: "open-file", path: "data.bin" });
    expect(await client.waitFor((m) => m.type === "error" && m.code === "binary-file", "binary-file")).toBeDefined();
    client.send({ v: 1, type: "open-file", path: "src/secret.ts" });
    const content = await client.waitFor((m) => m.type === "file-content", "file-content");
    expect(content).toMatchObject({ path: "src/secret.ts", masked: true });
    if (content.type === "file-content") {
      expect(content.content).not.toContain("supersecretvalue");
      expect(content.content).toContain("[masked]");
    }
    // Nothing the server sent anywhere leaks the env secrets.
    expect(JSON.stringify(client.messages)).not.toContain("do-not-leak");
    expect(JSON.stringify(client.messages)).not.toContain("TOPSECRET");
  }, 30_000);

  test("watcher: create/modify/delete arrive as versioned patches", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    let version = snapshot.stateVersion;

    const nextPatch = async (pred: (p: PatchMessage) => boolean, label: string) => {
      const msg = (await client.waitFor(
        (m) => m.type === "patch" && m.stateVersion > version && pred(m as PatchMessage),
        label,
      )) as PatchMessage;
      expect(msg.stateVersion).toBeGreaterThan(version);
      version = msg.stateVersion;
      return msg;
    };

    writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\n");
    const created = await nextPatch((p) => p.upsert.some((b) => b.path === "src/new.ts"), "create patch");
    const newId = created.upsert.find((b) => b.path === "src/new.ts")!.id;
    expect(created.total).toBe(8);

    writeFileSync(join(repo, "src", "new.ts"), "export const n = 1;\nexport const m = 2;\n");
    const modified = await nextPatch(
      (p) => p.upsert.some((b) => b.path === "src/new.ts" && b.lines === 2),
      "modify patch",
    );
    expect(modified.upsert[0]?.id).toBe(newId);

    unlinkSync(join(repo, "src", "new.ts"));
    const deleted = await nextPatch((p) => p.remove.includes(newId), "delete patch");
    expect(deleted.total).toBe(7);

    expect(floor.eventLog.some((e) => e.type === "observed-change" && e.change === "created")).toBe(true);
    expect(floor.eventLog.some((e) => e.type === "file-written" && e.provenance === "observed")).toBe(true);
  }, 30_000);

  test("rename keeps building id; restart restores identical coordinates", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const aBefore = byPath(snapshot.buildings).get("src/a.ts")!;
    const coordsBefore = new Map(snapshot.buildings.map((b) => [b.path, `${b.x},${b.y}`]));

    renameSync(join(repo, "src", "a.ts"), join(repo, "src", "a-renamed.ts"));
    const msg = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).rename.some((r) => r.to === "src/a-renamed.ts"),
      "rename patch",
    )) as PatchMessage;
    expect(msg.rename[0]).toEqual({ id: aBefore.id, from: "src/a.ts", to: "src/a-renamed.ts" });

    client.ws.close();
    floor.stop();
    floor = await createFloorServer({ repo, port: 0 });
    const again = await authedClient(floor);
    const coordsAfter = new Map(again.snapshot.buildings.map((b) => [b.path, `${b.x},${b.y}`]));
    expect(coordsAfter.get("src/a-renamed.ts")).toBe(coordsBefore.get("src/a.ts"));
    for (const [path, xy] of coordsBefore) {
      if (path !== "src/a.ts") expect(coordsAfter.get(path)).toBe(xy);
    }
    expect(byPath(again.snapshot.buildings).get("src/a-renamed.ts")?.id).toBe(aBefore.id);
  }, 30_000);

  test("corrupt persisted state resets via .bak instead of crashing (review regression)", async () => {
    repo = fixtureRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    writeFileSync(
      join(repo, ".artifex", "floor-state.json"),
      JSON.stringify({ v: 1, zones: null, buildings: {}, nextZoneX: 0, nextId: 1 }),
    );
    floor = await createFloorServer({ repo, port: 0 });
    const { snapshot } = await authedClient(floor);
    expect(snapshot.total).toBe(7);
    expect(existsSync(join(repo, ".artifex", "floor-state.json.bak"))).toBe(true);
  }, 30_000);

  test("one unreadable file does not abort boot (Claude review regression)", async () => {
    repo = fixtureRepo();
    const unreadable = join(repo, "src", "unreadable.ts");
    writeFileSync(unreadable, "export const hidden = 1;\n");
    chmodSync(unreadable, 0o000);
    try {
      floor = await createFloorServer({ repo, port: 0 });
      const { client, snapshot } = await authedClient(floor);
      expect(snapshot.buildings.map((b) => b.path)).not.toContain("src/unreadable.ts");
      expect(snapshot.total).toBe(7);
      // Zone counts count only real buildings (slot stays reserved).
      const srcZone = snapshot.zones.find((z) => z.name === "src")!;
      expect(srcZone.fileCount).toBe(snapshot.buildings.filter((b) => b.zoneId === "src").length);
      // Making it readable (size/mtime unchanged) must re-detect it:
      // unbuilt paths stay out of the watcher baseline.
      chmodSync(unreadable, 0o644);
      const patch = (await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/unreadable.ts"),
        "unreadable recovery patch",
        10_000,
      )) as PatchMessage;
      expect(patch.total).toBe(8);
    } finally {
      chmodSync(unreadable, 0o644);
    }
  }, 30_000);

  test("internally inconsistent persisted ids reset instead of minting duplicates", async () => {
    repo = fixtureRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    writeFileSync(
      join(repo, ".artifex", "floor-state.json"),
      JSON.stringify({
        v: 1,
        zones: { src: { x: 0, cols: 2, nextSlot: 1 } },
        buildings: { "src/a.ts": { id: "b50", zoneId: "src", slot: 0, x: 0, y: 40 } },
        nextZoneX: 240,
        nextId: 1,
      }),
    );
    floor = await createFloorServer({ repo, port: 0 });
    const { snapshot } = await authedClient(floor);
    expect(snapshot.total).toBe(7);
    expect(existsSync(join(repo, ".artifex", "floor-state.json.bak"))).toBe(true);
    expect(new Set(snapshot.buildings.map((b) => b.id)).size).toBe(snapshot.buildings.length);
  }, 30_000);

  test("crafted persisted coordinates beyond layout bounds reset", async () => {
    repo = fixtureRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    writeFileSync(
      join(repo, ".artifex", "floor-state.json"),
      JSON.stringify({
        v: 1,
        zones: { src: { x: 0, cols: 1_000_000_000, nextSlot: 1_000_000_001 } },
        buildings: { "src/a.ts": { id: "b1", zoneId: "src", slot: 1_000_000_000, x: 0, y: 40 } },
        nextZoneX: 96_000_000_048,
        nextId: 2,
      }),
    );
    floor = await createFloorServer({ repo, port: 0 });
    const { snapshot } = await authedClient(floor);
    expect(snapshot.total).toBe(7);
    expect(existsSync(join(repo, ".artifex", "floor-state.json.bak"))).toBe(true);
  }, 30_000);

  test("symlinked .artifex state is refused without renaming the outside file", async () => {
    repo = fixtureRepo();
    const outside = mkdtempSync(join(tmpdir(), "artifex-state-outside-"));
    try {
      writeFileSync(join(outside, "floor-state.json"), "{not json");
      symlinkSync(outside, join(repo, ".artifex"));
      floor = await createFloorServer({ repo, port: 0 });
      const { snapshot } = await authedClient(floor);
      expect(snapshot.total).toBe(7);
      expect(existsSync(join(outside, "floor-state.json"))).toBe(true);
      expect(existsSync(join(outside, "floor-state.json.bak"))).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  }, 30_000);

  test("a folder added while stopped gets a sized zone, not one column", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    await authedClient(floor);
    floor.stop();
    floor = undefined;
    mkdirSync(join(repo, "fresh"), { recursive: true });
    for (let i = 0; i < 25; i++) writeFileSync(join(repo, "fresh", `f${i}.ts`), "export {};\n");
    floor = await createFloorServer({ repo, port: 0 });
    const again = await authedClient(floor);
    const fresh = again.snapshot.zones.find((z) => z.name === "fresh")!;
    expect(fresh.fileCount).toBe(25);
    // 5 columns * 96 pitch + padding; a one-column pad would be 120.
    expect(fresh.w).toBe(504);
  }, 30_000);

  test("a folder created at runtime gets a sized zone from the batch", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    mkdirSync(join(repo, "burst"), { recursive: true });
    for (let i = 0; i < 25; i++) writeFileSync(join(repo, "burst", `f${i}.ts`), "export {};\n");
    const msg = (await client.waitFor(
      (m) => m.type === "patch" && m.stateVersion > snapshot.stateVersion
        && (m as PatchMessage).zones.some((z) => z.name === "burst" && z.fileCount === 25),
      "burst zone patch",
      10_000,
    )) as PatchMessage;
    expect(msg.zones.find((z) => z.name === "burst")?.w).toBe(504);
  }, 30_000);

  test("missing repo path rejects and creates nothing", async () => {
    const parent = mkdtempSync(join(tmpdir(), "artifex-missing-parent-"));
    const missing = join(parent, "no-such-repo");
    try {
      let error: unknown;
      try {
        await createFloorServer({ repo: missing, port: 0 });
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("not a directory");
      expect(existsSync(missing)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }, 30_000);

  test("prod.env and .envrc are hard-masked like .env", async () => {
    repo = fixtureRepo();
    writeFileSync(join(repo, "prod.env"), "DATABASE_URL=postgres://u:PRODSECRET@db/app\n");
    writeFileSync(join(repo, ".envrc"), "export SESSION=RCSECRET\n");
    floor = await createFloorServer({ repo, port: 0 });
    const { client } = await authedClient(floor);
    client.send({ v: 1, type: "open-file", path: "prod.env" });
    expect(await client.waitFor((m) => m.type === "error" && m.code === "masked-file", "prod.env masked")).toBeDefined();
    // Both requests use the same code; scope the second wait past
    // the first error instead of sleeping for it.
    const mark = client.messages.length;
    client.send({ v: 1, type: "open-file", path: ".envrc" });
    expect(await client.waitFor((m) => m.type === "error" && m.code === "masked-file", ".envrc masked", 5_000, mark)).toBeDefined();
    expect(JSON.stringify(client.messages)).not.toContain("PRODSECRET");
    expect(JSON.stringify(client.messages)).not.toContain("RCSECRET");
  }, 30_000);

  test("open-file only serves buildings, not excluded in-repo files", async () => {
    repo = fixtureRepo();
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(join(repo, "dist", "hidden.txt"), "build output secret\n");
    floor = await createFloorServer({ repo, port: 0 });
    const { client } = await authedClient(floor);
    client.send({ v: 1, type: "open-file", path: "dist/hidden.txt" });
    expect(await client.waitFor((m) => m.type === "error" && m.code === "not-found", "not-found")).toBeDefined();
    expect(JSON.stringify(client.messages)).not.toContain("build output secret");
  }, 30_000);

  test("relayout keeps reserved slots for unreadable files (review regression)", async () => {
    repo = fixtureRepo();
    const unreadable = join(repo, "src", "unreadable.ts");
    writeFileSync(unreadable, "export const hidden = 1;\n");
    chmodSync(unreadable, 0o000);
    try {
      floor = await createFloorServer({ repo, port: 0 });
      const { client } = await authedClient(floor);
      const mark = client.messages.length;
      client.send({ v: 1, type: "relayout" });
      await client.waitFor((m) => m.type === "snapshot", "relayout snapshot", 10_000, mark);
      floor.stop();
      floor = undefined;
      const state = JSON.parse(readFileSync(join(repo, ".artifex", "floor-state.json"), "utf8"));
      expect(Object.keys(state.buildings)).toContain("src/unreadable.ts");
    } finally {
      chmodSync(unreadable, 0o644);
    }
  }, 30_000);

  test("unauthenticated sockets time out; connections are capped (review regression)", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    // Idle socket: closed with 4001 after the 5 s auth timeout.
    const idle = await connectClient(floor.port);
    const idleCode = await new Promise((resolveClose) => {
      const timer = setTimeout(() => resolveClose("NOT-CLOSED"), 8_000);
      idle.ws.onclose = (e) => {
        clearTimeout(timer);
        resolveClose(e.code);
      };
    });
    expect(idleCode).toBe(4001);
    // Past the 64-socket cap, the next connection is refused.
    const port = floor.port;
    const many = await Promise.all(Array.from({ length: 64 }, () => connectClient(port)));
    void many;
    const extra = await connectClient(port);
    const extraCode = await new Promise((resolveClose) => {
      const timer = setTimeout(() => resolveClose("NOT-CLOSED"), 8_000);
      extra.ws.onclose = (e) => {
        clearTimeout(timer);
        resolveClose(e.code);
      };
    });
    expect(extraCode).toBe(4002);
  }, 30_000);

  // Value: protects=protocol error codes for malformed input;
  // fails_when=an error branch drops (client hangs) or codes drift;
  // why_new=Slice 6 gap (auth errors covered; message errors not).
  test("protocol: invalid JSON, bad version, unknown type, non-string path", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const client = await connectClient(floor.port);
    client.ws.send("this is not json");
    const badJson = await client.waitFor((m) => m.type === "error", "invalid-json error");
    expect(badJson).toMatchObject({ code: "bad-message", message: "invalid JSON" });
    let mark = client.messages.length;
    client.send({ v: 999, type: "auth", token: "x" });
    const badVer = await client.waitFor((m) => m.type === "error", "bad-version error", 5_000, mark);
    expect(badVer).toMatchObject({ code: "bad-message", message: "unsupported message version" });
    mark = client.messages.length;
    client.send({ v: 1, type: "auth", token: floor.token });
    await client.waitFor((m) => m.type === "snapshot", "snapshot");
    mark = client.messages.length;
    client.send({ v: 1, type: "bogus" });
    const unknown = await client.waitFor((m) => m.type === "error", "unknown-type error", 5_000, mark);
    expect(unknown).toMatchObject({ code: "bad-message", message: "unknown message type" });
    mark = client.messages.length;
    client.send({ v: 1, type: "open-file", path: 123 });
    const badPath = await client.waitFor((m) => m.type === "error", "non-string path error", 5_000, mark);
    expect(badPath).toMatchObject({ code: "bad-path", message: "path must be a string" });
  }, 30_000);

  // Value: protects=auth-ok/snapshot order + resync freshness;
  // fails_when=resync replays a stale snapshot (client diverges);
  // why_new=Slice 6 gap; seam=none.
  test("auth-ok precedes the snapshot; resync replays the current version", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const client = await connectClient(floor.port);
    client.send({ v: 1, type: "auth", token: floor.token });
    const ok = await client.waitFor((m) => m.type === "auth-ok", "auth-ok");
    const snap = (await client.waitFor((m) => m.type === "snapshot", "snapshot")) as {
      stateVersion: number;
    } & { type: string };
    expect(client.messages.findIndex((m) => m === ok)).toBeLessThan(
      client.messages.findIndex((m) => m === (snap as unknown)),
    );
    expect((ok as { stateVersion: number }).stateVersion).toBe(snap.stateVersion);
    writeFileSync(join(repo, "src", "bump.ts"), "export const b = 1;\n");
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && m.stateVersion > snap.stateVersion,
      "bump patch",
    )) as PatchMessage;
    const mark = client.messages.length;
    client.send({ v: 1, type: "resync" });
    const again = (await client.waitFor((m) => m.type === "snapshot", "resync snapshot", 5_000, mark)) as {
      stateVersion: number;
    } & { type: string };
    expect(again.stateVersion).toBe(patch.stateVersion);
  }, 30_000);

  // Value: protects=reset notice on corrupt boot (users learn the
  // floor was relaid out); fails_when=the notice drops (silent
  // relayout); why_new=Slice 6 gap; seam=none.
  test("corrupt boot notifies that the floor was relaid out", async () => {
    repo = fixtureRepo();
    mkdirSync(join(repo, ".artifex"), { recursive: true });
    writeFileSync(join(repo, ".artifex", "floor-state.json"), "{corrupt");
    floor = await createFloorServer({ repo, port: 0 });
    const { client } = await authedClient(floor);
    const mark = client.messages.length;
    const notice = await client.waitFor((m) => m.type === "notice", "reset notice", 5_000, mark);
    expect(notice).toMatchObject({ text: "floor relaid out: saved state was reset" });
  }, 30_000);

  // Value: protects=unbuilt notice when a persisted file goes
  // unreadable (users learn files are hidden); fails_when=the
  // notice drops (silent disappearance); why_new=Slice 6 gap.
  test("newly unreadable persisted file notifies instead of vanishing", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const first = await authedClient(floor);
    writeFileSync(join(repo, "src", "save.ts"), "export const s = 1;\n");
    await first.client.waitFor((m) => m.type === "patch", "save patch");
    closeAllClients();
    floor.stop();
    const unreadable = join(repo, "src", "bad.ts");
    chmodSync(unreadable, 0o000);
    try {
      floor = await createFloorServer({ repo, port: 0 });
      const { client, snapshot } = await authedClient(floor);
      expect(snapshot.buildings.map((b) => b.path)).not.toContain("src/bad.ts");
      const mark = client.messages.length;
      const notice = await client.waitFor((m) => m.type === "notice", "unbuilt notice", 5_000, mark);
      expect(notice).toMatchObject({ text: "1 unreadable file(s) not shown" });
    } finally {
      chmodSync(unreadable, 0o644);
    }
  }, 30_000);

  // Value: protects=large-file preview (truncated + masked, capped,
  // no leak); fails_when=truncation drops (multi-MB previews) or
  // masking misses (secret leak); why_new=Slice 6 gap; seam=none.
  test("open-file over 512KB truncates and masks without leaking", async () => {
    repo = fixtureRepo();
    const big = `const API_TOKEN = 'supersecretvalue';\n// MARKER-BELOW\n${"x\n".repeat(300_000)}`;
    writeFileSync(join(repo, "src", "big.ts"), big);
    floor = await createFloorServer({ repo, port: 0 });
    const { client } = await authedClient(floor);
    const mark = client.messages.length;
    client.send({ v: 1, type: "open-file", path: "src/big.ts" });
    const content = (await client.waitFor((m) => m.type === "file-content", "big preview", 5_000, mark)) as {
      truncated: boolean;
      masked: boolean;
      content: string;
    } & { type: string };
    expect(content.truncated).toBe(true);
    expect(content.masked).toBe(true);
    expect(content.content.length).toBeLessThanOrEqual(256 * 1024);
    expect(content.content).not.toContain("supersecretvalue");
    expect(content.content).toContain("MARKER-BELOW");
  }, 30_000);

  // Value: protects=one flush bumps exactly once + empty windows
  // stay silent; fails_when=double-bump (version gaps) or idle
  // chatter (client re-renders); why_new=Slice 6 gap; seam=none.
  test("one flush bumps the version once; empty windows send nothing", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    await new Promise((r) => setTimeout(r, 500));
    const mark = client.messages.length;
    await new Promise((r) => setTimeout(r, 400));
    expect(client.messages.slice(mark).filter((m) => m.type === "patch")).toEqual([]);
    writeFileSync(join(repo, "src", "one.ts"), "export const o = 1;\n");
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && m.stateVersion > snapshot.stateVersion,
      "single patch",
    )) as PatchMessage;
    expect(patch.stateVersion).toBe(snapshot.stateVersion + 1);
  }, 30_000);

  // Value: protects=all-unreadable zone disappearing (not an empty
  // pad); fails_when=empty pads render for fully hidden zones;
  // why_new=Slice 6 gap; seam=none.
  test("all-unreadable zone disappears from the snapshot", async () => {
    repo = fixtureRepo();
    const hidden = join(repo, "py", "bad.py");
    chmodSync(hidden, 0o000);
    try {
      floor = await createFloorServer({ repo, port: 0 });
      const { snapshot } = await authedClient(floor);
      expect(snapshot.zones.map((z) => z.name)).not.toContain("py");
    } finally {
      chmodSync(hidden, 0o644);
    }
  }, 30_000);

  // Value: protects=client asset serving (the floor is a blank
  // page without its bundle); fails_when=/app.js or /styles.css
  // drops from the fetch handler (unit suite never fetched them —
  // only the browser did); why_new=re-audit (index.ts:1143-1149).
  test("the client bundle and stylesheet are served with types", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const js = await fetch(`${floor.url}/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect((await js.text()).length).toBeGreaterThan(1000);
    const css = await fetch(`${floor.url}/styles.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get("content-type")).toContain("text/css");
    expect((await css.text()).length).toBeGreaterThan(0);
    expect((await fetch(`${floor.url}/nope`)).status).toBe(404);
  }, 30_000);

  // Value: protects=oversize-file policy (unparsed but shown, lines
  // counted for text, zeroed for binary); fails_when=text past 1MB
  // is parsed (multi-second batch stall) or binary past 1MB counts
  // phantom lines; why_new=re-audit (index.ts:425-426,479).
  test("files past 1MB show unparsed; runtime edits refresh without parsing", async () => {
    repo = fixtureRepo();
    writeFileSync(join(repo, "src", "big.ts"), `${"x\n".repeat(600_000)}`);
    const bin = Buffer.alloc(1_200_000, 0x41);
    bin[100] = 0;
    writeFileSync(join(repo, "src", "big.bin"), bin);
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const atBoot = byPath(snapshot.buildings);
    expect(atBoot.get("src/big.ts")).toMatchObject({ lines: 600_000, binary: false, parse: "unparsed" });
    expect(atBoot.get("src/big.bin")).toMatchObject({ lines: 0, binary: true, parse: "unparsed" });
    appendFileSync(join(repo, "src", "big.ts"), "y\n");
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/big.ts"),
      "oversize edit patch",
      10_000,
    )) as PatchMessage;
    expect(patch.upsert.find((b) => b.path === "src/big.ts")).toMatchObject({
      lines: 600_001,
      binary: false,
      parse: "unparsed",
    });
  }, 30_000);

  // Value: protects=unreadable-at-runtime eviction (rename-over with
  // an unreadable file: building drops, slot/id reserved, recovery
  // returns to the same id); fails_when=the evict branch drops (a
  // ghost building with stale content) or recovery mints a new id
  // (belts/inspector references drift); why_new=re-audit (:766-768).
  test("a file replaced by an unreadable one drops, then recovers its id", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client } = await authedClient(floor);
    writeFileSync(join(repo, "src", "toggle.ts"), "export const t = 1;\n");
    const created = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/toggle.ts"),
      "toggle create patch",
      10_000,
    )) as PatchMessage;
    const id = created.upsert.find((b) => b.path === "src/toggle.ts")!.id;
    const staged = join(repo, "src", "toggle.staged");
    writeFileSync(staged, "export const t = 2;\n");
    chmodSync(staged, 0o000);
    try {
      // Same path, new inode, unreadable content: a modify the
      // pre-pass cannot read (chmod alone changes no stat the diff
      // compares, so it would stay silent).
      renameSync(staged, join(repo, "src", "toggle.ts"));
      const dropped = (await client.waitFor(
        (m) => m.type === "patch" && (m as PatchMessage).remove.includes(id),
        "toggle evict patch",
        10_000,
      )) as PatchMessage;
      expect(dropped.upsert.some((b) => b.path === "src/toggle.ts")).toBe(false);
    } finally {
      chmodSync(join(repo, "src", "toggle.ts"), 0o644);
    }
    // Same id and slot reserved: readable content returns as the same
    // building instead of drifting to a fresh append slot.
    writeFileSync(join(repo, "src", "toggle.ts"), "export const t = 3;\n");
    const back = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/toggle.ts"),
      "toggle recovery patch",
      10_000,
    )) as PatchMessage;
    expect(back.upsert.find((b) => b.path === "src/toggle.ts")?.id).toBe(id);
  }, 30_000);

  // Value: protects=rename of an unreadable file (client told to drop
  // the building at the new path; layout keeps the id reserved);
  // fails_when=the rebuild-failed branch drops (ghost at the new
  // path) or the remove drops (client keeps stale content);
  // why_new=re-audit (index.ts:723,727).
  test("renaming an unreadable file drops the building but keeps its id", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client } = await authedClient(floor);
    const aPath = join(repo, "src", "moveme.ts");
    const bPath = join(repo, "src", "moved.ts");
    writeFileSync(aPath, "export const m = 1;\n");
    const created = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/moveme.ts"),
      "moveme create patch",
      10_000,
    )) as PatchMessage;
    const id = created.upsert.find((b) => b.path === "src/moveme.ts")!.id;
    chmodSync(aPath, 0o000);
    try {
      renameSync(aPath, bPath);
      const patch = (await client.waitFor(
        (m) =>
          m.type === "patch" &&
          (m as PatchMessage).rename.some((r) => r.to === "src/moved.ts") &&
          (m as PatchMessage).remove.includes(id),
        "unreadable rename patch",
        10_000,
      )) as PatchMessage;
      expect(patch.upsert.some((b) => b.path === "src/moved.ts")).toBe(false);
    } finally {
      chmodSync(bPath, 0o644);
    }
    // Layout kept the entry: the id still belongs to the new path.
    floor.stop();
    floor = undefined;
    const state = JSON.parse(readFileSync(join(repo, ".artifex", "floor-state.json"), "utf8"));
    expect(state.buildings["src/moved.ts"]?.id).toBe(id);
    expect(state.buildings["src/moveme.ts"]).toBeUndefined();
  }, 30_000);

  // Value: protects=open-file for a just-deleted file (not-found,
  // never a crash or stale content, whichever of the patch and the
  // request wins the race); fails_when=the stat-failure branch drops
  // (unhandled rejection kills the socket) or leaks the old preview;
  // why_new=re-audit (index.ts:1021-1022).
  test("open-file on a deleted file answers not-found either race order", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client } = await authedClient(floor);
    writeFileSync(join(repo, "src", "gone.ts"), "export const g = 1;\n");
    await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/gone.ts"),
      "gone create patch",
      10_000,
    );
    unlinkSync(join(repo, "src", "gone.ts"));
    // No patch wait: the request races the delete down the pipeline.
    const mark = client.messages.length;
    client.send({ v: 1, type: "open-file", path: "src/gone.ts" });
    const err = await client.waitFor(
      (m) => m.type === "error" && (m as { code?: string }).code === "not-found",
      "deleted not-found",
      5_000,
      mark,
    );
    expect(err).toMatchObject({ code: "not-found" });
  }, 30_000);

  // Value: protects=save-side state failure (a directory planted at
  // the state path: persist warns, cleans its tmp file, server keeps
  // serving; next boot resets without touching it); fails_when=the
  // tmp cleanup drops (.artifex fills with .tmp litter) or the throw
  // escapes (watcher callback dies); why_new=re-audit (:362-363).
  test("an unpersistable state path warns and litters nothing", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const stateFile = join(repo, ".artifex", "floor-state.json");
    // Saves are debounced 250ms: wait out the boot save first.
    const deadline = Date.now() + 5_000;
    while (!existsSync(stateFile)) {
      if (Date.now() > deadline) throw new Error("timed out waiting for the boot save");
      await new Promise((r) => setTimeout(r, 50));
    }
    rmSync(stateFile);
    mkdirSync(stateFile);
    writeFileSync(join(repo, "src", "trigger.ts"), "export const t = 1;\n");
    await client.waitFor(
      (m) => m.type === "patch" && m.stateVersion > snapshot.stateVersion,
      "trigger patch",
      10_000,
    );
    // Let the debounced persist attempt run before asserting.
    await new Promise((r) => setTimeout(r, 600));
    expect(readdirSync(join(repo, ".artifex")).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(existsSync(stateFile)).toBe(true);
    // Next boot resets around the planted directory (no .bak: an
    // irregular state file is never safe to rename).
    client.ws.close();
    floor.stop();
    floor = await createFloorServer({ repo, port: 0 });
    const again = await authedClient(floor);
    expect(again.snapshot.total).toBe(8);
    expect(existsSync(`${stateFile}.bak`)).toBe(false);
  }, 30_000);

  // Value: protects=bind-failure cleanup (second server on a live
  // port throws without killing the first or leaking a watcher);
  // fails_when=the catch drops the closes (watcher/parser leak per
  // retry) or the throw escapes as a hang; why_new=re-audit
  // (index.ts:1186,1188-1189).
  test("binding an occupied port throws and leaves the first server live", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const port = floor.port;
    let error: unknown;
    try {
      await createFloorServer({ repo, port });
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(Error);
    expect((await fetch(floor.url)).status).toBe(200);
    const { snapshot } = await authedClient(floor);
    expect(snapshot.total).toBe(7);
  }, 30_000);

  // Value: protects=/ws origin check (CSRF-class socket hijack);
  // fails_when=foreign origins upgrade (any site drives the floor);
  // why_new=Slice 6 gap (host check covered; origin not).
  test("foreign Origin on /ws is refused with 403", async () => {
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const port = floor.port;
    const get = (headers: Record<string, string>) =>
      new Promise<number>((resolveStatus) => {
        const req = httpRequest({ host: "127.0.0.1", port, path: "/ws", headers }, (res) =>
          resolveStatus(res.statusCode ?? 0),
        );
        req.on("error", () => resolveStatus(0));
        req.end();
      });
    expect(await get({ host: `127.0.0.1:${port}`, origin: "http://evil.example" })).toBe(403);
    // No Origin (non-browser client) proceeds past the check to the
    // upgrade attempt, which fails for a plain GET.
    expect(await get({ host: `127.0.0.1:${port}` })).toBe(400);
  }, 30_000);
});
