import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
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
});
