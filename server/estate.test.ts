import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeAllClients, connectClient, type Client } from "./test-client.ts";
import type { ErrorCode, ServerMessage, SnapshotMessage } from "../floor-ui/wire.ts";
import {
  createEstateServer,
  estateSnapshot,
  hostAllowedFor,
  loadEstateDir,
  originAllowedFor,
  type EstateServer,
} from "./estate.ts";
import { buildEstateFloor } from "./estate-build.ts";

const FAT = "UM.tesoreria.core-service";
const THIN = "UM.tesoreria.sender-service";

function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "estate-test-"));
  const entities: Record<string, unknown> = {};
  for (let i = 0; i < 10; i++) {
    entities[`${FAT}\0src/E${i}.java`] = { repo: FAT, kinds: ["entity"], className: `E${i}`, endpoints: [], tables: [], calls: [], topics: [], unresolvedNotes: 0 };
  }
  const estate = {
    repos: [{ repo: FAT }, { repo: THIN }],
    byFile: {
      ...entities,
      [`${FAT}\0src/Ctl.java`]: {
        repo: FAT, kinds: ["controller"], className: "Ctl",
        endpoints: [{ method: "GET", path: "/a", handler: "a", line: 10, tables: [{ table: "t1", access: "read", via: "repository", derived: "explicit", through: "Ctl.a" }], callers: [] }],
        tables: [], calls: [], topics: [], unresolvedNotes: 0,
      },
      [`${FAT}\0src/Client.java`]: {
        repo: FAT, kinds: ["feign"], className: "Client", endpoints: [], tables: [],
        calls: [{ method: "GET", path: "/t", via: "feign", caller: "Client.go", line: 5, matchedPath: `${THIN}:src/T.java` }],
        topics: [], unresolvedNotes: 0,
      },
      [`${THIN}\0src/T.java`]: {
        repo: THIN, kinds: ["controller"], className: "T",
        endpoints: [{ method: "GET", path: "/t", handler: "t", line: 7, tables: [{ table: "t3", access: "read", via: "repository", derived: "explicit", through: "T.t" }], callers: [] }],
        tables: [], calls: [], topics: [], unresolvedNotes: 0,
      },
    },
  };
  const boxes = {
    boxes: [
      {
        id: "box-01", name: "alpha", tables: ["t1"], tableCount: 1, endpointCount: 1, fileCount: 1,
        repos: [FAT], writes: [], seeded: [], endpoints: [`${FAT}:src/Ctl.java:GET /a`], files: [`${FAT}:src/Ctl.java`], consumers: [],
      },
    ],
    unboxed: ["orphan-table"],
  };
  writeFileSync(join(dir, "estate.json"), JSON.stringify(estate));
  writeFileSync(join(dir, "estate-boxes.json"), JSON.stringify(boxes));
  writeFileSync(join(dir, "gateway-bootstrap.yml"), "routes:\n  - id: tesoreria-core-service\n    uri: lb://tesoreria-core-service\n    predicates:\n      - Path=/api/tesoreria/core/**\n");
  return dir;
}

describe("estate guards", () => {
  test("host allowlist", () => {
    expect(hostAllowedFor("127.0.0.1:4531", "4531")).toBe(true);
    expect(hostAllowedFor("localhost:4531", "4531")).toBe(true);
    expect(hostAllowedFor("evil:4531", "4531")).toBe(false);
    expect(hostAllowedFor(null, "4531")).toBe(false);
  });
  test("origin allowlist", () => {
    expect(originAllowedFor(null, "4531")).toBe(true);
    expect(originAllowedFor("http://127.0.0.1:4531", "4531")).toBe(true);
    expect(originAllowedFor("http://localhost:4531", "4531")).toBe(true);
    expect(originAllowedFor("http://evil:4531", "4531")).toBe(false);
  });
});

describe("loadEstateDir", () => {
  test("missing dir fails with the file name", async () => {
    await expect(loadEstateDir(join(tmpdir(), "estate-test-nope"))).rejects.toThrow("missing or invalid JSON");
  });
  test("missing gateway table fails instead of marking all internal", async () => {
    const dir = fixtureDir();
    rmSync(join(dir, "gateway-bootstrap.yml"));
    await expect(loadEstateDir(dir)).rejects.toThrow("gateway-bootstrap.yml");
    rmSync(dir, { recursive: true, force: true });
  });
  test("routeless gateway table fails", async () => {
    const dir = fixtureDir();
    writeFileSync(join(dir, "gateway-bootstrap.yml"), "routes: []\n");
    await expect(loadEstateDir(dir)).rejects.toThrow("no routes");
    rmSync(dir, { recursive: true, force: true });
  });
  test("missing frontend layer boots without (older snapshots)", async () => {
    const dir = fixtureDir();
    const loaded = await loadEstateDir(dir);
    expect(loaded.frontend).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
  });
  test("frontend layer loads when present", async () => {
    const dir = fixtureDir();
    const fe = { repo: "FE", commit: "abc", calls: [] };
    writeFileSync(join(dir, "frontend-calls.json"), JSON.stringify(fe));
    const loaded = await loadEstateDir(dir);
    expect(loaded.frontend).toEqual(fe);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("estateSnapshot", () => {
  test("static snapshot shape", async () => {
    const dir = fixtureDir();
    const floor = buildEstateFloor(
      JSON.parse(await Bun.file(join(dir, "estate.json")).text()),
      JSON.parse(await Bun.file(join(dir, "estate-boxes.json")).text()),
      [{ id: "tesoreria-core-service", service: "tesoreria-core-service", path: "/api/tesoreria/core" }],
    );
    const snap = estateSnapshot(floor);
    expect(snap.repo).toBe("estate:tes-um");
    expect(snap.stateVersion).toBe(1);
    expect(snap.total).toBe(snap.buildings.length);
    expect(snap.agent).toEqual({ agentId: "estate", state: "idle" });
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("createEstateServer", () => {
  let dir: string;
  let floor: EstateServer;
  let client: Client;

  beforeAll(async () => {
    dir = fixtureDir();
    floor = await createEstateServer({ estateDir: dir, port: 0 });
    client = await connectClient(floor.port);
  });

  afterAll(() => {
    closeAllClients();
    floor.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  test("serves the app with the token injected", async () => {
    const html = await (await fetch(floor.url)).text();
    expect(html).toContain(floor.token);
    expect(html).not.toContain("%ARTIFEX_TOKEN%");
    const js = await (await fetch(`${floor.url}app.js`)).text();
    expect(js.length).toBeGreaterThan(1000);
    const css = await (await fetch(`${floor.url}styles.css`)).text();
    expect(css).toContain(".topstrip");
    expect((await fetch(`${floor.url}nope`)).status).toBe(404);
  });

  test("auth gates the snapshot", async () => {
    const stranger = await connectClient(floor.port);
    stranger.send({ v: 1, type: "resync" });
    const gated = (await stranger.waitFor((m) => m.type === "error", "gated")) as Extract<ServerMessage, { type: "error" }>;
    expect(gated.code).toBe("bad-auth");
    stranger.send({ v: 1, type: "auth", token: "wrong" });
    const wrong = (await stranger.waitFor((m) => m.type === "error", "wrong", 5_000, stranger.messages.length)) as Extract<ServerMessage, { type: "error" }>;
    expect(wrong.code).toBe("bad-auth");
  });

  test("auth-ok then a full snapshot", async () => {
    client.send({ v: 1, type: "auth", token: floor.token });
    await client.waitFor((m) => m.type === "auth-ok", "auth-ok");
    const snap = (await client.waitFor((m) => m.type === "snapshot", "snapshot")) as SnapshotMessage;
    expect(snap.repo).toBe("estate:tes-um");
    expect(snap.buildings.map((b) => b.id).sort()).toEqual(["box-01", "svc-t-sender", "unboxed-orphan-table", "yard-t-core"]);
    expect(snap.belts.length).toBe(1);
    expect(snap.zones.map((z) => z.id).sort()).toEqual(["services", "shelf"]);
  });

  test("resync and relayout resend the snapshot", async () => {
    client.send({ v: 1, type: "resync" });
    await client.waitFor((m) => m.type === "snapshot", "resync", 5_000, client.messages.length);
    client.send({ v: 1, type: "relayout" });
    await client.waitFor((m) => m.type === "snapshot", "relayout", 5_000, client.messages.length);
  });

  test("file ops fail with matching codes", async () => {
    const cases: [string, object, ErrorCode][] = [
      ["open-file", { path: "core/box-01-alpha" }, "bad-path"],
      ["get-diff", { path: "core/box-01-alpha" }, "bad-path"],
      ["export-trace", { path: "core/box-01-alpha" }, "bad-path"],
      ["get-lines", { path: "core/box-01-alpha", center: 1 }, "lines-failed"],
      ["get-summary", { target: { kind: "file", path: "core/box-01-alpha" } }, "summary-failed"],
      ["get-phrases", {}, "phrases-failed"],
    ];
    for (const [type, rest, code] of cases) {
      const from = client.messages.length;
      client.send({ v: 1, type, ...rest });
      const msg = (await client.waitFor((m) => m.type === "error", type, 5_000, from)) as Extract<ServerMessage, { type: "error" }>;
      expect(msg.code).toBe(code);
    }
  });

  test("agent ops notice, garbage errors", async () => {
    for (const type of ["dispatch", "stop-agent", "writeback"]) {
      const from = client.messages.length;
      client.send({ v: 1, type, text: "hi", runId: "r", lessons: [] });
      const msg = (await client.waitFor((m) => m.type === "notice", type, 5_000, from)) as Extract<ServerMessage, { type: "notice" }>;
      expect(msg.text).toContain("no agent");
    }
    const from = client.messages.length;
    client.send({ v: 1, type: "bogus" });
    const unknown = (await client.waitFor((m) => m.type === "error", "unknown", 5_000, from)) as Extract<ServerMessage, { type: "error" }>;
    expect(unknown.code).toBe("bad-message");
    client.send({ v: 2, type: "resync" });
    await client.waitFor((m) => m.type === "error", "bad version", 5_000, client.messages.length);
    client.ws.send("not json");
    await client.waitFor((m) => m.type === "error", "bad json", 5_000, client.messages.length);
  });
});
