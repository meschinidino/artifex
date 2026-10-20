import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFloorServer, type FloorServer } from "./index.ts";
import type { PatchMessage } from "../floor-ui/wire.ts";
import { authedClient, byPath, closeAllClients } from "./test-client.ts";

let floor: FloorServer | undefined;
let repo: string | undefined;

afterEach(() => {
  closeAllClients();
  floor?.stop();
  floor = undefined;
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

function beltFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-belts-"));
  mkdirSync(join(dir, "src", "dir"), { recursive: true });
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "src", "a.ts"), `import "./b";\nimport "./missing";\nimport "node:fs";\n`);
  writeFileSync(join(dir, "src", "b.ts"), `import "./dir";\n`);
  writeFileSync(join(dir, "src", "dir", "index.ts"), `export const x = 1;\n`);
  writeFileSync(join(dir, "src", "c.ts"), `import "@src/b";\n`);
  writeFileSync(join(dir, "src", "d.ts"), `import "belt-fixture/feat";\n`);
  writeFileSync(join(dir, "src", "feat.ts"), `export const f = 1;\n`);
  writeFileSync(
    join(dir, "tsconfig.json"),
    `{\n// belt fixture paths,\n"compilerOptions": { "baseUrl": ".", "paths": { "@src/*": ["src/*"] } },\n}\n`,
  );
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "belt-fixture", exports: { "./feat": "./src/feat.ts" } }));
  writeFileSync(join(dir, "pkg", "__init__.py"), ``);
  writeFileSync(join(dir, "pkg", "mod.py"), `from . import sib\nimport os\n`);
  writeFileSync(join(dir, "pkg", "sib.py"), `x = 1\n`);
  return dir;
}

const EXPECTED_BELTS: [string, string][] = [
  ["pkg/mod.py", "pkg/sib.py"],
  ["src/a.ts", "src/b.ts"],
  ["src/b.ts", "src/dir/index.ts"],
  ["src/c.ts", "src/b.ts"],
  ["src/d.ts", "src/feat.ts"],
];

describe("floor server belts (T3b)", () => {
  test("snapshot carries the exact belt set with unresolved counts", async () => {
    repo = beltFixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const idToPath = new Map([...buildings.values()].map((b) => [b.id, b.path]));
    const beltPaths = snapshot.belts
      .map((e) => [idToPath.get(e.fromId), idToPath.get(e.toId)] as [string, string])
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1));
    expect(beltPaths).toEqual(EXPECTED_BELTS);
    // No duplicates: the id pairs are unique.
    expect(new Set(snapshot.belts.map((e) => `${e.fromId}\0${e.toId}`)).size).toBe(snapshot.belts.length);
    // Unresolved counts: only a.ts misses (node:fs and os are external).
    expect(buildings.get("src/a.ts")?.unresolvedCount).toBe(1);
    for (const [path, b] of buildings) {
      if (path !== "src/a.ts") expect(b.unresolvedCount).toBe(0);
    }
  }, 30_000);

  test("adding then removing an import updates belts promptly", async () => {
    // 2 s, not 1: the path includes a cold parser spawn plus WASM
    // init, and 1 s flakes on a loaded machine (review note).
    repo = beltFixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const idOf = (path: string) => buildings.get(path)!.id;
    const hasBelt = (belts: { fromId: string; toId: string }[] | undefined, from: string, to: string) =>
      belts?.some((e) => e.fromId === idOf(from) && e.toId === idOf(to)) ?? false;

    // Checkpointed: the boot reconcile flushes a stale belts patch
    // that a bare history scan would match for the removal below,
    // passing without testing removal at all.
    let mark = client.messages.length;
    const start = Date.now();
    writeFileSync(join(repo, "src", "b.ts"), `import "./dir";\nimport "./c";\n`);
    const added = (await client.waitFor(
      (m) => m.type === "patch" && hasBelt((m as PatchMessage).belts, "src/b.ts", "src/c.ts"),
      "belt-add patch",
      5_000,
      mark,
    )) as PatchMessage;
    expect(Date.now() - start).toBeLessThan(2000);
    expect(added.upsert.find((b) => b.path === "src/b.ts")?.unresolvedCount).toBe(0);

    mark = client.messages.length;
    const start2 = Date.now();
    writeFileSync(join(repo, "src", "b.ts"), `import "./dir";\n`);
    const removed = (await client.waitFor(
      (m) =>
        m.type === "patch" &&
        (m as PatchMessage).belts !== undefined &&
        !hasBelt((m as PatchMessage).belts, "src/b.ts", "src/c.ts"),
      "belt-remove patch",
      5_000,
      mark,
    )) as PatchMessage;
    expect(Date.now() - start2).toBeLessThan(2000);
    expect(removed.belts).toBeDefined();
    // The stale boot patch carries an empty upsert: this assertion
    // fails if the wait matched anything but the removal's own patch.
    expect(removed.upsert.find((b) => b.path === "src/b.ts")).toBeDefined();
  }, 30_000);

  test("rename keeps the renamed file's belts via its stable id", async () => {
    repo = beltFixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const bId = buildings.get("src/b.ts")!.id;
    const dirId = buildings.get("src/dir/index.ts")!.id;
    const aId = buildings.get("src/a.ts")!.id;
    const cId = buildings.get("src/c.ts")!.id;

    const mark = client.messages.length;
    renameSync(join(repo, "src", "b.ts"), join(repo, "src", "b2.ts"));
    const msg = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).rename.some((r) => r.to === "src/b2.ts"),
      "rename patch",
      5_000,
      mark,
    )) as PatchMessage;
    expect(msg.rename).toContainEqual({ id: bId, from: "src/b.ts", to: "src/b2.ts" });
    expect(msg.belts).toBeDefined();
    // The renamed file's own belt follows its stable id.
    expect(msg.belts).toContainEqual({ fromId: bId, toId: dirId });
    // Importers of the old path genuinely dangle now: their belts
    // drop and their counts rise (text is truth).
    expect(msg.belts).not.toContainEqual({ fromId: aId, toId: bId });
    expect(msg.belts).not.toContainEqual({ fromId: cId, toId: bId });
    const upserted = byPath(msg.upsert);
    expect(upserted.get("src/a.ts")?.unresolvedCount).toBe(2);
    expect(upserted.get("src/c.ts")?.unresolvedCount).toBe(1);
    expect(upserted.get("src/b2.ts")?.unresolvedCount).toBe(0);
  }, 30_000);

  test("deleting tsconfig.json drops its alias belts (review regression)", async () => {
    repo = beltFixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const cId = buildings.get("src/c.ts")!.id;
    const bId = buildings.get("src/b.ts")!.id;

    const mark = client.messages.length;
    unlinkSync(join(repo, "tsconfig.json"));
    // Wait for the alias belt to actually drop: a stale pre-delete
    // patch still carries it, and matching that would pass without
    // testing the rebuild.
    const msg = (await client.waitFor(
      (m) =>
        m.type === "patch" &&
        (m as PatchMessage).belts !== undefined &&
        !(m as PatchMessage).belts!.some((e) => e.fromId === cId && e.toId === bId),
      "config-delete patch",
      10_000,
      mark,
    )) as PatchMessage;
    // Without the context rebuild the stale alias keeps resolving.
    expect(msg.belts).not.toContainEqual({ fromId: cId, toId: bId });
    // The package.json self-reference belt is untouched.
    const dId = buildings.get("src/d.ts")!.id;
    const featId = buildings.get("src/feat.ts")!.id;
    expect(msg.belts).toContainEqual({ fromId: dId, toId: featId });
  }, 30_000);

  test("a burst of new files resolves every link (review regression)", async () => {
    repo = beltFixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const mark = client.messages.length;
    const N = 10;
    for (let i = 0; i < N; i++) {
      const next = i + 1 < N ? `import "./f${i + 1}";\n` : `export const end = 1;\n`;
      writeFileSync(join(repo, "src", `f${i}.ts`), next);
    }
    // A patch carries the full belt list when present: wait until
    // one patch shows every chain link (robust whether the burst
    // lands as one batch or several).
    const ids = new Map(snapshot.buildings.map((b) => [b.path, b.id]));
    await client.waitFor(
      (m) => {
        if (m.type !== "patch") return false;
        const p = m as PatchMessage;
        for (const b of p.upsert) ids.set(b.path, b.id);
        if (!p.belts) return false;
        const set = new Set(p.belts.map((e) => `${e.fromId}\0${e.toId}`));
        for (let i = 0; i + 1 < N; i++) {
          const a = ids.get(`src/f${i}.ts`);
          const c = ids.get(`src/f${i + 1}.ts`);
          if (!a || !c || !set.has(`${a}\0${c}`)) return false;
        }
        return true;
      },
      "burst patch",
      10_000,
      mark,
    );
    // Ground truth comes from a fresh snapshot, not the patch shape.
    const mark2 = client.messages.length;
    client.send({ v: 1, type: "resync" });
    const resnap = await client.waitFor((m) => m.type === "snapshot", "resync snapshot", 10_000, mark2);
    if (resnap.type !== "snapshot") throw new Error("expected snapshot");
    const buildings = byPath(resnap.buildings);
    const idOf = (path: string) => buildings.get(path)!.id;
    const beltSet = new Set(resnap.belts.map((e) => `${e.fromId}\0${e.toId}`));
    for (let i = 0; i + 1 < N; i++) {
      expect(beltSet.has(`${idOf(`src/f${i}.ts`)}\0${idOf(`src/f${i + 1}.ts`)}`)).toBe(true);
    }
    for (let i = 0; i < N; i++) {
      expect(buildings.get(`src/f${i}.ts`)?.unresolvedCount).toBe(0);
    }
  }, 30_000);

  test("a transient syntax error keeps last-good belts with the error lamp (review regression)", async () => {
    repo = beltFixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const bId = buildings.get("src/b.ts")!.id;
    const dirId = buildings.get("src/dir/index.ts")!.id;

    let mark = client.messages.length;
    writeFileSync(join(repo, "src", "b.ts"), `import "./dir";\nexport function f( { return ; }\n`);
    const broken = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/b.ts" && b.parse === "error"),
      "parse-error patch",
      10_000,
      mark,
    )) as PatchMessage;
    expect(broken.upsert.find((b) => b.path === "src/b.ts")?.parseError).toContain("parse error");

    // The belts survive on the last good parse.
    mark = client.messages.length;
    client.send({ v: 1, type: "resync" });
    const resnap = await client.waitFor((m) => m.type === "snapshot", "resync snapshot", 10_000, mark);
    if (resnap.type !== "snapshot") throw new Error("expected snapshot");
    expect(resnap.belts).toContainEqual({ fromId: bId, toId: dirId });

    // And a fixed file with new imports resolves from the new text.
    mark = client.messages.length;
    writeFileSync(join(repo, "src", "b.ts"), `import "./c";\n`);
    const fixed = (await client.waitFor(
      (m) =>
        m.type === "patch" &&
        (m as PatchMessage).upsert.some((b) => b.path === "src/b.ts" && b.parse === "ok") &&
        (m as PatchMessage).belts !== undefined,
      "fixed patch",
      10_000,
      mark,
    )) as PatchMessage;
    const cId = buildings.get("src/c.ts")!.id;
    expect(fixed.belts).toContainEqual({ fromId: bId, toId: cId });
    expect(fixed.belts).not.toContainEqual({ fromId: bId, toId: dirId });
  }, 30_000);

  test("creating or deleting __init__.py refreshes Python roots (review regression)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "artifex-belts-initpy-"));
    repo = dir;
    mkdirSync(join(dir, "srclib", "pkg"), { recursive: true });
    writeFileSync(join(dir, "main.py"), `import pkg.mod\n`);
    writeFileSync(join(dir, "srclib", "pkg", "mod.py"), `x = 1\n`);
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const idOf = (path: string) => byPath(snapshot.buildings).get(path)!.id;
    expect(snapshot.belts).not.toContainEqual({ fromId: idOf("main.py"), toId: idOf("srclib/pkg/mod.py") });

    let mark = client.messages.length;
    writeFileSync(join(dir, "srclib", "pkg", "__init__.py"), ``);
    const added = (await client.waitFor(
      (m) =>
        m.type === "patch" &&
        (m as PatchMessage).belts !== undefined &&
        (m as PatchMessage).belts!.some((e) => e.fromId === idOf("main.py")),
      "initpy-add patch",
      10_000,
      mark,
    )) as PatchMessage;
    // New ids may have minted for the new file only; main/mod ids are stable.
    const ids = new Map(snapshot.buildings.map((b) => [b.path, b.id]));
    for (const b of added.upsert) ids.set(b.path, b.id);
    const mainId = ids.get("main.py")!;
    const modId = ids.get("srclib/pkg/mod.py")!;
    expect(added.belts).toContainEqual({ fromId: mainId, toId: modId });

    mark = client.messages.length;
    unlinkSync(join(dir, "srclib", "pkg", "__init__.py"));
    const removed = (await client.waitFor(
      (m) =>
        m.type === "patch" &&
        (m as PatchMessage).belts !== undefined &&
        !(m as PatchMessage).belts!.some((e) => e.fromId === mainId),
      "initpy-delete patch",
      10_000,
      mark,
    )) as PatchMessage;
    expect(removed.belts).not.toContainEqual({ fromId: mainId, toId: modId });
  }, 30_000);

  test("rename carries last-good imports across a broken file (review regression)", async () => {
    repo = beltFixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const bId = buildings.get("src/b.ts")!.id;
    const dirId = buildings.get("src/dir/index.ts")!.id;

    let mark = client.messages.length;
    writeFileSync(join(repo, "src", "b.ts"), `import "./dir";\nexport function f( { return ; }\n`);
    await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).upsert.some((b) => b.path === "src/b.ts" && b.parse === "error"),
      "parse-error patch",
      10_000,
      mark,
    );
    mark = client.messages.length;
    renameSync(join(repo, "src", "b.ts"), join(repo, "src", "b2.ts"));
    const msg = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).rename.some((r) => r.to === "src/b2.ts"),
      "rename patch",
      10_000,
      mark,
    )) as PatchMessage;
    expect(msg.belts).toContainEqual({ fromId: bId, toId: dirId });
  }, 30_000);
});

function javaFixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "artifex-java-"));
  const base = join(dir, "src", "main", "java", "acme", "shop");
  mkdirSync(base, { recursive: true });
  mkdirSync(join(dir, "src", "main", "resources"), { recursive: true });
  writeFileSync(join(dir, "src", "main", "resources", "bootstrap.yml"), "spring:\n  application:\n    name: shop-core-service\n");
  writeFileSync(join(base, "OrderController.java"), [
    "package acme.shop;",
    "import acme.shop.OrderService;",
    "@RestController",
    '@RequestMapping("/api/shop/order")',
    "public class OrderController {",
    "    private final OrderService orderService;",
    '    @GetMapping("/{id}")',
    "    public Object byId(Long id) { return orderService.getById(id); }",
    "}",
  ].join("\n"));
  writeFileSync(join(base, "OrderService.java"), [
    "package acme.shop;",
    "@Service",
    "public class OrderService {",
    "    private final OrderRepository orderRepository;",
    "    private final OrderHelper helper;",
    "    public Object getById(Long id) { helper.touch(); return orderRepository.findById(id); }",
    "}",
  ].join("\n"));
  writeFileSync(join(base, "OrderHelper.java"), [
    "package acme.shop;",
    "@Component",
    "public class OrderHelper { public void touch() { } }",
  ].join("\n"));
  writeFileSync(join(base, "OrderRepository.java"), [
    "package acme.shop;",
    "public interface OrderRepository extends JpaRepository<OrderEntity, Long> {",
    "    Object findById(Long id);",
    "}",
  ].join("\n"));
  writeFileSync(join(base, "OrderEntity.java"), [
    "package acme.shop;",
    "@Entity",
    '@Table(name = "orders")',
    "public class OrderEntity { }",
  ].join("\n"));
  writeFileSync(join(dir, "go.mod"), "module example.com/shop\n\ngo 1.22\n");
  mkdirSync(join(dir, "cmd"), { recursive: true });
  mkdirSync(join(dir, "pkg"), { recursive: true });
  writeFileSync(join(dir, "cmd", "main.go"), 'package main\n\nimport "example.com/shop/pkg"\n\nfunc main() { pkg.Run() }\n');
  writeFileSync(join(dir, "pkg", "run.go"), "package pkg\n\nfunc Run() {}\n");
  return dir;
}

describe("floor server JVM/Go belts + connections", () => {
  // Value: protects=the any-repo promise end to end over the wire:
  // Java import + same-package belts, Go module belts, and the
  // per-endpoint table chain in the snapshot's conn summaries;
  // fails_when=any leg (grammar, FQN index, graph, wire) drops;
  // why_new=connections milestone.
  test("java/go snapshot carries belts and endpoint-to-table connections", async () => {
    repo = javaFixtureRepo();
    floor = await createFloorServer({ repo, port: 0 });
    const { snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const idToPath = new Map([...buildings.values()].map((b) => [b.id, b.path]));
    const beltPaths = new Set(snapshot.belts.map((e) => `${idToPath.get(e.fromId)} -> ${idToPath.get(e.toId)}`));
    const P = "src/main/java/acme/shop";
    expect(beltPaths.has(`${P}/OrderController.java -> ${P}/OrderService.java`)).toBe(true);
    expect(beltPaths.has(`${P}/OrderService.java -> ${P}/OrderRepository.java`)).toBe(true);
    // Same-package use with no import statement still belts (typeRefs).
    expect(beltPaths.has(`${P}/OrderService.java -> ${P}/OrderHelper.java`)).toBe(true);
    expect(beltPaths.has("cmd/main.go -> pkg/run.go")).toBe(true);
    const ctrl = buildings.get(`${P}/OrderController.java`)!;
    expect(ctrl.parse).toBe("ok");
    expect(ctrl.conn?.service).toBe("shop-core-service");
    expect(ctrl.conn?.endpoints).toEqual([
      {
        method: "GET", path: "/api/shop/order/{id}", handler: "byId", line: 7,
        tables: [{ table: "orders", access: "read", via: "repository", derived: "explicit", through: "OrderRepository" }],
        callers: [],
      },
    ]);
    expect(ctrl.conn?.tables.map((t) => t.table)).toEqual(["orders"]);
    // A plain TS-less fixture: files with no connections carry no conn key.
    expect(buildings.get("pkg/run.go")?.conn).toBeUndefined();
  }, 60_000);

  // Value: protects=.sql files flowing through boot content loading
  // into the graph join (migration path:line on the endpoint's
  // tables over the wire); fails_when=.sql is filtered from text
  // retention or the parser filter eats it; why_new=contracts T4.
  test("migration tables join endpoint closures over the wire", async () => {
    repo = mkdtempSync(join(tmpdir(), "artifex-conn-sql-"));
    const P = "src/main/java/acme/shop";
    writeJava(repo, `${P}/UserController.java`, [
      "@RestController",
      "public class UserController {",
      "    private final UserService service;",
      '    @GetMapping("/users/{id}")',
      "    public Object byId(Long id) { return service.byId(id); }",
      "}",
    ]);
    writeJava(repo, `${P}/UserService.java`, [
      "@Service",
      "public class UserService {",
      "    private final UserRepository repo;",
      "    public Object byId(Long id) { return repo.findById(id); }",
      "}",
    ]);
    writeJava(repo, `${P}/UserRepository.java`, [
      "public interface UserRepository extends JpaRepository<User, Long> {}",
    ]);
    writeJava(repo, `${P}/User.java`, [
      "@Entity",
      '@Table(name = "users")',
      "public class User {}",
    ]);
    writeJava(repo, "migrations/001.sql", [
      "CREATE TABLE users (",
      "  id INT",
      ");",
    ]);
    floor = await createFloorServer({ repo, port: 0 });
    const { snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const ctrl = buildings.get(`${P}/UserController.java`)!;
    expect(ctrl.conn?.endpoints[0]?.tables).toEqual([
      { table: "users", access: "read", via: "repository", derived: "explicit", through: "UserRepository", declaredBy: [{ repo: "", path: "migrations/001.sql", line: 1 }] },
    ]);
    // The migration building carries a connections summary (it declares).
    expect(buildings.get("migrations/001.sql")?.conn?.kinds).toEqual(["sql"]);
  }, 60_000);
});

function writeJava(dir: string, rel: string, lines: string[]) {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, lines.join("\n"));
}

describe("federated floor (two repos, one floor)", () => {
  // Value: protects=districts per repo, cross-repo belts only from
  // matched contracts (Feign endpoint + shared Kafka topic), and
  // tables flowing across the repo boundary into the caller's
  // endpoint summary; fails_when=federation joins by name alone
  // or districts collapse; why_new=connections milestone.
  test("core+sender fixture: districts, http/topic belts, cross-repo tables", async () => {
    const parent = mkdtempSync(join(tmpdir(), "artifex-fed-"));
    repo = parent;
    const core = join(parent, "core");
    const sender = join(parent, "sender");
    writeJava(core, "src/main/resources/bootstrap.yml", ["spring:", "  application:", "    name: shop-core-service"]);
    writeJava(sender, "src/main/resources/bootstrap.yml", ["spring:", "  application:", "    name: shop-sender-service"]);
    const CP = "src/main/java/acme/shop";
    writeJava(core, `${CP}/OrderController.java`, [
      "package acme.shop;", "@RestController", '@RequestMapping("/api/shop/order")',
      "public class OrderController {",
      "    private final OrderRepository repository;",
      '    @GetMapping("/{id}")',
      "    public Object byId(Long id) { return repository.findById(id); }",
      "}",
    ]);
    writeJava(core, `${CP}/OrderRepository.java`, [
      "package acme.shop;",
      "public interface OrderRepository extends JpaRepository<OrderEntity, Long> { Object findById(Long id); }",
    ]);
    writeJava(core, `${CP}/OrderEntity.java`, [
      "package acme.shop;", "@Entity", '@Table(name = "orders")', "public class OrderEntity { }",
    ]);
    writeJava(core, `${CP}/MailService.java`, [
      "package acme.shop;", "@Service",
      "public class MailService {",
      "    private final KafkaTemplate<String, Object> kafkaTemplate;",
      '    public void sendIt(Object e) { kafkaTemplate.send("send-order", e); }',
      "}",
    ]);
    const SP = "src/main/java/acme/sender";
    writeJava(sender, `${SP}/OrderClient.java`, [
      "package acme.sender;",
      '@FeignClient(name = "shop-core-service", path = "/api/shop/order")',
      "public interface OrderClient {",
      '    @GetMapping("/{id}")',
      "    String byId(Long id);",
      "}",
    ]);
    writeJava(sender, `${SP}/SendController.java`, [
      "package acme.sender;", "@RestController",
      "public class SendController {",
      "    private final OrderClient orderClient;",
      '    @PostMapping("/send/{id}")',
      "    public Object send(Long id) { return orderClient.byId(id); }",
      "}",
    ]);
    writeJava(sender, `${SP}/OrderEventListener.java`, [
      "package acme.sender;", "@Component",
      "public class OrderEventListener {",
      '    @KafkaListener(topics = "send-order")',
      "    public void onEvent(Object e) { }",
      "}",
    ]);
    floor = await createFloorServer({ repo: core, repos: [core, sender], port: 0 });
    const { snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    expect(snapshot.repo).toBe("core + sender");
    expect(buildings.get(`core/${CP}/OrderController.java`)?.zoneId).toBe("core");
    expect(buildings.get(`sender/${SP}/SendController.java`)?.zoneId).toBe("sender");
    const idToPath = new Map([...buildings.values()].map((b) => [b.id, b.path]));
    const kindBelts = snapshot.belts.filter((e) => e.kind).map((e) => `${idToPath.get(e.fromId)} -${e.kind}-> ${idToPath.get(e.toId)}`);
    expect(kindBelts).toContain(`sender/${SP}/OrderClient.java -http-> core/${CP}/OrderController.java`);
    expect(kindBelts).toContain(`core/${CP}/MailService.java -topic-> sender/${SP}/OrderEventListener.java`);
    const send = buildings.get(`sender/${SP}/SendController.java`)!;
    expect(send.conn?.endpoints[0]?.tables.map((t) => `${t.table}@${t.through}`)).toEqual(["orders@core:OrderRepository"]);
    const coreEp = buildings.get(`core/${CP}/OrderController.java`)!.conn!.endpoints[0]!;
    expect(coreEp.callers).toEqual([{ path: `sender:${SP}/OrderClient.java`, caller: "byId", via: "feign", line: 4 }]);
  }, 60_000);
});

describe("connection edits and notes-only summaries (Codex review)", () => {
  // Value: protects=contract edits (route change with no import
  // change) re-emitting belts, and a notes-only file keeping its
  // conn summary; fails_when=belts go stale after a route edit or
  // unresolved-only files go silent; why_new=Codex outside P1/P2.
  test("renaming a route re-emits belts without the stale http edge; dynamic-only files keep conn", async () => {
    repo = mkdtempSync(join(tmpdir(), "artifex-conn-edit-"));
    const P = "src/main/java/acme/shop";
    writeJava(repo, `${P}/ThingController.java`, [
      "package acme.shop;", "@RestController",
      "public class ThingController {",
      '    @GetMapping("/thing")',
      "    public Object thing() { return null; }",
      "}",
    ]);
    writeJava(repo, `${P}/ThingCaller.java`, [
      "package acme.shop;",
      "public class ThingCaller {",
      '    public Object go() { return restTemplate.getForObject("/thing", String.class); }',
      "}",
    ]);
    writeFileSync(join(repo, "dynamic.ts"), "export const load = (id: string) => fetch(`/users/${id}`);\n");
    floor = await createFloorServer({ repo, port: 0 });
    const { client, snapshot } = await authedClient(floor);
    const buildings = byPath(snapshot.buildings);
    const idOf = (path: string) => buildings.get(path)!.id;
    const hasHttp = (belts: { fromId: string; toId: string; kind?: string }[] | undefined) =>
      belts?.some((e) => e.kind === "http" && e.fromId === idOf(`${P}/ThingCaller.java`) && e.toId === idOf(`${P}/ThingController.java`)) ?? false;
    expect(hasHttp(snapshot.belts)).toBe(true);
    // Notes-only file: the template fetch is its only fact.
    expect(buildings.get("dynamic.ts")?.conn?.unresolvedNotes).toBeGreaterThan(0);

    const mark = client.messages.length;
    writeJava(repo, `${P}/ThingController.java`, [
      "package acme.shop;", "@RestController",
      "public class ThingController {",
      '    @GetMapping("/renamed-thing")',
      "    public Object thing() { return null; }",
      "}",
    ]);
    const patch = (await client.waitFor(
      (m) => m.type === "patch" && (m as PatchMessage).belts !== undefined && !hasHttp((m as PatchMessage).belts)
        && (m as PatchMessage).upsert.some((b) => b.path === `${P}/ThingController.java`),
      "route-rename patch",
      10_000,
      mark,
    )) as PatchMessage;
    expect(patch.belts).toBeDefined();
  }, 60_000);
});
