import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "./index.ts";
import type { PatchMessage } from "../floor-ui/wire.ts";
import { authedClient, closeAllClients } from "./test-client.ts";

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
  const dir = mkdtempSync(join(tmpdir(), "artifex-agent-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "b.ts"), "export function b(): number {\n  return 2;\n}\n");
  writeFileSync(join(dir, "src", "a.ts"), "import { b } from \"./b\";\nexport function a(): number {\n  return b();\n}\n");
  return dir;
}

type RpcBody = { v: number; id: unknown; result?: any; error?: { code: number; message: string } };

async function agent(method: string, params?: unknown, token?: string): Promise<{ status: number; json: RpcBody }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`http://127.0.0.1:${floor!.port}/agent`, {
    method: "POST",
    headers,
    body: JSON.stringify({ method, params: params ?? {}, id: 1 }),
  });
  return { status: res.status, json: (await res.json()) as RpcBody };
}

describe("agent interface integration", () => {
  test("boot writes a 0600 token file with the launch token and ignores it", async () => {
    // Value: protects=D19 bootstrap on real boots; fails_when=the file is missing, world-readable, or stale
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const file = join(repo, ".artifex", "agent-token");
    expect(readFileSync(file, "utf8")).toBe(`${floor.token}\n`);
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(repo, ".artifex", ".gitignore"), "utf8")).toContain("agent-token");
    // Rotation: a second boot replaces the token.
    const first = floor.token;
    floor.stop();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    expect(floor.token).not.toBe(first);
    expect(readFileSync(file, "utf8")).toBe(`${floor.token}\n`);
  });

  test("listBuildings and getBuilding answer over real HTTP with auth enforced", async () => {
    // Value: protects=the read contract end to end; fails_when=queries miswire or auth is skipped
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const list = await agent("floor.listBuildings", {}, floor.token);
    expect(list.status).toBe(200);
    expect(list.json.result.total).toBe(2);
    expect(list.json.result.buildings.map((b: { path: string }) => b.path)).toEqual(["src/a.ts", "src/b.ts"]);
    const detail = await agent("floor.getBuilding", { path: "src/a.ts" }, floor.token);
    expect(detail.json.result).toMatchObject({
      path: "src/a.ts",
      imports: ["src/b.ts"],
      dependents: [],
      testState: { status: "unknown" },
    });
    const dep = await agent("floor.getBuilding", { path: "src/b.ts" }, floor.token);
    expect(dep.json.result.dependents).toEqual(["src/a.ts"]);
    // Auth enforced: missing and forged tokens fail closed.
    expect((await agent("floor.listBuildings")).status).toBe(401);
    expect((await agent("floor.listBuildings", {}, "forged")).status).toBe(401);
  });

  test("annotate round-trips masked notes and rejects bad input explicitly", async () => {
    // Value: protects=annotate masking + explicit errors; fails_when=secrets store raw or bad input succeeds
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const noted = await agent(
      "floor.annotate",
      { building: "src/a.ts", note: "why: delegates\nconst API_KEY = \"sk-live\"", agent: "muse" },
      floor.token,
    );
    expect(noted.json.result).toMatchObject({ path: "src/a.ts", masked: true });
    const back = await agent("floor.getBuilding", { path: "src/a.ts" }, floor.token);
    expect(back.json.result.notes).toEqual([
      { note: "why: delegates\nconst API_KEY = [masked]", ts: noted.json.result.ts, agentId: "muse" },
    ]);
    // The durable log holds the masked event, never the secret.
    const log = readFileSync(join(repo, ".artifex", "event-log.jsonl"), "utf8");
    expect(log).toContain('"type":"annotate"');
    expect(log).not.toContain("sk-live");
    // Explicit errors, never silent.
    expect((await agent("floor.annotate", { building: "src/nope.ts", note: "x" }, floor.token)).json.error?.message)
      .toBe("unknown building: src/nope.ts");
    expect((await agent("floor.annotate", { building: "src/a.ts", note: "  " }, floor.token)).json.error?.message)
      .toBe("note must be non-empty");
    expect(
      (await agent("floor.annotate", { building: "src/a.ts", note: "n".repeat(9000) }, floor.token)).json.error?.message,
    ).toBe("note exceeds 8192 chars");
  });

  test("notes ship on snapshot and patch, and survive reboot", async () => {
    // Value: protects=Why-section data flow + durability; fails_when=notes skip the wire or die on restart
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const { client, snapshot } = await authedClient(floor);
    expect(snapshot.notes).toEqual([]);
    const mark = client.messages.length;
    await agent("floor.annotate", { building: "src/b.ts", note: "why" }, floor.token);
    const patched = (await client.waitFor(
      (m): m is PatchMessage => m.type === "patch" && m.notes !== undefined,
      "notes patch",
      5_000,
      mark,
    )) as PatchMessage;
    expect(patched.notes).toEqual([{ path: "src/b.ts", note: "why", ts: expect.any(Number) }]);
    // Reboot: the note rebuilds from the durable log.
    closeAllClients();
    floor.stop();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const again = await authedClient(floor);
    expect(again.snapshot.notes).toEqual([{ path: "src/b.ts", note: "why", ts: expect.any(Number) }]);
    const back = await agent("floor.getBuilding", { path: "src/b.ts" }, floor.token);
    expect(back.json.result.notes).toEqual([{ note: "why", ts: expect.any(Number) }]);
  });

  test("getTrace answers anchored markdown, deterministically, read-only", async () => {
    // Value: protects=agent trace contract (anchors, determinism,
    // read-only, explicit errors); fails_when=markdown drifts, a
    // read writes, or errors go unnamed
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const eventsBefore = floor.eventLog.length;
    const first = await agent("floor.getTrace", { path: "src/a.ts" }, floor.token);
    expect(first.status).toBe(200);
    expect(first.json.result.path).toBe("src/a.ts");
    const md = first.json.result.markdown as string;
    expect(md).toContain("# trace: src/a.ts\n");
    expect(md).toContain("## imports (1)\n- src/b.ts:1\n");
    const dep = await agent("floor.getTrace", { path: "src/b.ts" }, floor.token);
    expect((dep.json.result.markdown as string)).toContain("## imported by (1)\n- src/a.ts:1\n");
    // A second call is byte-identical (no timestamps, stable order).
    const again = await agent("floor.getTrace", { path: "src/a.ts" }, floor.token);
    expect(again.json.result.markdown).toBe(md);
    // Read-only: no events appended, no notes stored.
    expect(floor.eventLog.length).toBe(eventsBefore);
    const notes = await agent("floor.getBuilding", { path: "src/a.ts" }, floor.token);
    expect(notes.json.result.notes).toEqual([]);
    // Explicit errors naming the path.
    expect((await agent("floor.getTrace", { path: "src/nope.ts" }, floor.token)).json.error)
      .toEqual({ code: -32602, message: "unknown building: src/nope.ts" });
    expect((await agent("floor.getTrace", { path: "" }, floor.token)).json.error?.code).toBe(-32602);
  });

  test("protocol versions stay 1 across the additive slice", async () => {
    // Value: protects=NFR6 (additive wire/agent/parser changes ship
    // without a version bump); fails_when=a constant drifts
    const { WIRE_VERSION } = await import("../floor-ui/wire.ts");
    const { AGENT_API_VERSION } = await import("../agent-interface/protocol.ts");
    const { PARSER_PROTOCOL_VERSION } = await import("../parser/protocol.ts");
    expect([WIRE_VERSION, AGENT_API_VERSION, PARSER_PROTOCOL_VERSION]).toEqual([1, 1, 1]);
  });

  test("getPlan and getDbSchema answer honestly on an idle floor", async () => {
    // Value: protects=plan/schema honesty (idle worker, no scope over-claim); fails_when=either fabricates
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const plan = await agent("floor.getPlan", {}, floor.token);
    expect(plan.json.result).toMatchObject({ agent: { agentId: "muse", state: "idle" }, ghosts: [], runs: [] });
    const schema = await agent("floor.getDbSchema", {}, floor.token);
    expect(schema.json.result).toEqual({ tables: [], endpoints: [], schemaZoneBuilt: false });
  });

  test("unknown methods, bad JSON, and wrong verbs fail explicitly", async () => {
    // Value: protects=transport honesty; fails_when=garbage succeeds or miscodes
    repo = fixtureRepo();
    floor = await createFloorServer({ repo, port: 0, agent: false });
    expect((await agent("floor.nope", {}, floor.token)).json.error?.code).toBe(-32601);
    const badJson = await fetch(`http://127.0.0.1:${floor.port}/agent`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${floor.token}` },
      body: "{nope",
    });
    expect(badJson.status).toBe(400);
    expect(await fetch(`http://127.0.0.1:${floor.port}/agent`)).toMatchObject({ status: 405 });
    // Foreign Origin is refused like /ws.
    const foreignOrigin = await new Promise<number>((resolveStatus) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: floor!.port,
          path: "/agent",
          method: "POST",
          headers: { host: `127.0.0.1:${floor!.port}`, origin: "http://evil.example" },
        },
        (res) => resolveStatus(res.statusCode ?? 0),
      );
      req.on("error", () => resolveStatus(0));
      req.end("{}");
    });
    expect(foreignOrigin).toBe(403);
  });

  test("blocked state dir degrades: boot warns, serves, writes no token", async () => {
    // Value: protects=degraded boot when .artifex is unusable; fails_when=token write fails boot
    repo = fixtureRepo();
    writeFileSync(join(repo, ".artifex"), "not a dir");
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const list = await agent("floor.listBuildings", {}, floor.token);
    expect(list.status).toBe(200);
    expect(list.json.result.total).toBe(2);
  });

  test("path-unsafe filenames never become annotatable buildings", async () => {
    // Value: protects=path-safety honesty at the annotate boundary; fails_when=a backslash file lists or annotates
    repo = fixtureRepo();
    writeFileSync(join(repo, "src", "we\\ird.ts"), "export const x = 1;\n");
    floor = await createFloorServer({ repo, port: 0, agent: false });
    const list = await agent("floor.listBuildings", {}, floor.token);
    expect(list.json.result.buildings.map((b: { path: string }) => b.path)).not.toContain("src/we\\ird.ts");
    const got = await agent("floor.annotate", { building: "src/we\\ird.ts", note: "x" }, floor.token);
    expect(got.json.error).toEqual({ code: -32602, message: "unknown building: src/we\\ird.ts" });
  });
});
