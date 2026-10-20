/**
 * Connections extractor: literal-only facts with line provenance.
 * Fixtures mirror real Spring/Kotlin shapes found in private
 * multi-repo Java projects (hexagonal controllers, Feign clients
 * incl. the name-with-glued-path variant, native @Query text
 * blocks) plus generic TS/Python/Go HTTP surfaces. Nothing here
 * is project-specific.
 */
import { describe, expect, test } from "bun:test";
import { extractConnections } from "./extract.ts";
import { canonicalService, endpointKey } from "./types.ts";

describe("jvm controllers and services", () => {
  // Value: protects=endpoint expansion over multi-path class
  // mappings + handler/field/call capture; fails_when=the
  // annotation or member scan drifts (endpoints undercount);
  // why_new=connections milestone.
  test("controller endpoints expand over every class path, with handlers and calls", () => {
    const c = extractConnections("ArticuloController.java", [
      "package com.example.controller;",
      "@RestController",
      '@RequestMapping({"/articulo", "/api/example/core/articulo"})',
      "@RequiredArgsConstructor",
      "public class ArticuloController {",
      "    private final ArticuloService articuloService;",
      "    private final CuentaService cuentaService;",
      '    @PostMapping("/")',
      "    public ResponseEntity<ArticuloResponse> create(@RequestBody ArticuloRequest req) {",
      "        return ResponseEntity.ok(articuloService.create(req));",
      "    }",
      '    @GetMapping("/{id}")',
      "    public ResponseEntity<ArticuloResponse> byId(@PathVariable Long id) {",
      "        cuentaService.findByNumeroCuenta(id);",
      "        return null;",
      "    }",
      "}",
    ].join("\n"))!;
    expect(c.kinds).toContain("controller");
    expect(c.endpoints.map((e) => `${e.method} ${e.path} ->${e.handler}`)).toEqual([
      "POST /articulo ->create",
      "POST /api/example/core/articulo ->create",
      "GET /articulo/{id} ->byId",
      "GET /api/example/core/articulo/{id} ->byId",
    ]);
    expect(c.injections).toEqual([
      { field: "articuloService", type: "ArticuloService" },
      { field: "cuentaService", type: "CuentaService" },
    ]);
    const byId = c.methods.find((m) => m.name === "byId")!;
    expect(byId.calls).toContainEqual({ receiver: "cuentaService", method: "findByNumeroCuenta", line: 14 });
    expect(c.endpoints[0]!.line).toBe(8);
  });

  // Value: protects=Kotlin primary-constructor injections and fun
  // methods; fails_when=kt header parsing drops; why_new.
  test("kotlin service captures constructor injections and method calls", () => {
    const c = extractConnections("ChequeraService.kt", [
      "package com.example.kotlin.service",
      "@Service",
      "class ChequeraService(",
      "    private val chequeraRepository: ChequeraRepository,",
      "    private val pdfClient: PdfClient",
      ") {",
      "    fun send(id: Long): String {",
      "        val c = chequeraRepository.findById(id)",
      "        return pdfClient.generate(c)",
      "    }",
      "}",
    ].join("\n"))!;
    expect(c.kinds).toContain("service");
    expect(c.injections).toEqual([
      { field: "chequeraRepository", type: "ChequeraRepository" },
      { field: "pdfClient", type: "PdfClient" },
    ]);
    expect(c.methods.find((m) => m.name === "send")!.calls.map((x) => `${x.receiver}.${x.method}`))
      .toEqual(["chequeraRepository.findById", "pdfClient.generate"]);
  });
});

describe("jvm wrapped signatures", () => {
  // Value: protects=calls inside methods whose parameters wrap
  // over several lines (pervasive tab-formatted legacy style);
  // fails_when=body tracking requires '{' on the declaration line
  // (the real-core CarreraChequeraController break); why_new=audit.
  test("wrapped parameter lists still track the method body", () => {
    const c = extractConnections("Wrapped.java", [
      "public class Wrapped {",
      "    private final OrderService service;",
      "    public Object findAllByCurso(Integer facultadId,",
      "            Integer lectivoId, Integer curso) {",
      "        return service.findAll(facultadId, lectivoId, curso);",
      "    }",
      "    Object ifaceMethod(Integer a,",
      "            Integer b);",
      "    public Object after() { return service.other(); }",
      "}",
    ].join("\n"))!;
    expect(c.methods.find((m) => m.name === "findAllByCurso")!.calls)
      .toEqual([{ receiver: "service", method: "findAll", line: 5 }]);
    expect(c.methods.find((m) => m.name === "after")!.calls)
      .toEqual([{ receiver: "service", method: "other", line: 9 }]);
  });

  // Value: protects=bare same-class calls (no `this.`) chaining
  // to file-declared methods only, and fluent chains split across
  // lines attributing the first link to the field; fails_when=
  // facade-style bodies (ProcessBajaService.makeBaja) go dark or
  // undeclared names become phantom this-calls; why_new=audit.
  test("bare calls to declared methods and split fluent chains are captured", () => {
    const c = extractConnections("Facade.java", [
      "public class Facade {",
      "    private final Repo repository;",
      "    public Object make(Long id) {",
      "        Object x = loadIt(id);",
      "        unknownExternal(x);",
      "        return x;",
      "    }",
      "    private Object loadIt(Long id) {",
      "        return repository",
      "                .findById(id)",
      "                .orElseThrow();",
      "    }",
      "}",
    ].join("\n"))!;
    expect(c.methods.find((m) => m.name === "make")!.calls)
      .toEqual([{ receiver: "this", method: "loadIt", line: 4 }]);
    expect(c.methods.find((m) => m.name === "loadIt")!.calls)
      .toEqual([{ receiver: "repository", method: "findById", line: 10 }]);
  });
});

describe("kotlin bodiless forms and hostile text (outside review)", () => {
  // Value: protects=every interface method registering (bodiless
  // funs must not swallow the next declaration), expression-body
  // calls counting, and braces inside comments/text never shifting
  // structure; fails_when=pending-signature or brace tracking
  // desyncs; why_new=outside review P1/P2.
  test("kotlin interface funs, expression bodies, javadoc braces and comment calls", () => {
    const kt = extractConnections("Repo.kt", [
      "package acme",
      "interface Repo {",
      "    fun findById(id: Long): String?",
      "    fun findAll(): List<String>",
      "    fun count(): Int",
      "}",
      "class Svc(private val repo: Repo) {",
      "    fun one(id: Long): String? = repo.findById(id)",
      "    /** unbalanced { brace in javadoc",
      "     * repo.count() mentioned in a comment is not a call */",
      "    fun all(): List<String> {",
      "        // repo.count() in a line comment is not a call",
      '        val s = "repo.count() in a string is not a call"',
      "        return repo.findAll()",
      "    }",
      "}",
    ].join("\n"))!;
    expect(kt.methods.map((m) => m.name)).toEqual(["findById", "findAll", "count"]);
    expect(kt.isInterface).toBe(true);
    const svc = extractConnections("Svc.kt", [
      "package acme",
      "class Svc(private val repo: Repo) {",
      "    fun one(id: Long): String? = repo.findById(id)",
      "    fun all(): List<String> { return repo.findAll() }",
      "}",
    ].join("\n"))!;
    expect(svc.methods.find((m) => m.name === "one")!.calls).toEqual([{ receiver: "repo", method: "findById", line: 3 }]);
    expect(svc.methods.find((m) => m.name === "all")!.calls).toEqual([{ receiver: "repo", method: "findAll", line: 4 }]);
    const java = extractConnections("Facade.java", [
      "public class Facade {",
      "    private final Repo repo;",
      "    /** doc with { unbalanced brace and repo.delete() mention */",
      "    public Object get(Long id) {",
      '        String s = "repo.delete() in string";',
      "        // repo.delete() in comment",
      "        return repo.findById(id);",
      "    }",
      "    public Object after() { return repo.count(); }",
      "}",
    ].join("\n"))!;
    expect(java.methods.map((m) => m.name)).toEqual(["get", "after"]);
    expect(java.methods.find((m) => m.name === "get")!.calls).toEqual([{ receiver: "repo", method: "findById", line: 7 }]);
    expect(java.methods.find((m) => m.name === "after")!.calls).toEqual([{ receiver: "repo", method: "count", line: 9 }]);
  });

  // Value: protects=multi-path mapping arrays containing {param}
  // braces and constant paths landing in notes, never as the base
  // path; fails_when=balanced-brace or unresolved handling drops;
  // why_new=outside review P2.
  test("mapping arrays with path params survive; constant paths are unresolved notes", () => {
    const c = extractConnections("Paths.java", [
      "@RestController",
      '@RequestMapping({"/a/{id}", "/b/{name}"})',
      "public class Paths {",
      '    @GetMapping("/x")',
      "    public Object x() { return null; }",
      "    @GetMapping(Paths.CONSTANT)",
      "    public Object y() { return null; }",
      "}",
    ].join("\n"))!;
    expect(c.endpoints.map((e) => e.path).sort()).toEqual(["/a/{id}/x", "/b/{name}/x"]);
    expect(c.notes.some((n) => n.includes("unresolved mapping path"))).toBe(true);
  });
});

describe("jvm persistence", () => {
  // Value: protects=entity table derivation (explicit @Table wins,
  // implicit name is labeled, never silent); fails_when=derivation
  // order flips; why_new=connections milestone.
  test("explicit @Table beats the implicit naming strategy", () => {
    const explicit = extractConnections("ArticuloEntity.java", [
      "@Entity",
      '@Table(name = "articulos")',
      "public class ArticuloEntity { }",
    ].join("\n"))!;
    expect(explicit.entityTable).toMatchObject({ table: "articulos", derived: "explicit", via: "entity" });
    const implicit = extractConnections("FacturaPendienteEntity.java", [
      "@Entity",
      "@Immutable",
      "public class FacturaPendienteEntity { }",
    ].join("\n"))!;
    expect(implicit.entityTable).toMatchObject({ table: "factura_pendiente_entity", derived: "implicit-name" });
    expect(implicit.kinds).toContain("entity");
  });

  // Value: protects=native @Query text-block table extraction with
  // per-method access, and the JpaRepository entity binding;
  // fails_when=text-block or FROM/JOIN scanning drifts (the tables
  // a function uses go missing); why_new=connections milestone.
  test("native SQL tables land on the repository method with read/write access", () => {
    const c = extractConnections("JpaFacturaPendienteRepository.java", [
      "public interface JpaFacturaPendienteRepository extends JpaRepository<FacturaPendienteEntity, Long> {",
      "    @Modifying",
      "    @Query(",
      '        value = """',
      "        UPDATE movprov_detallecomprobantes d",
      "        JOIN valores p ON v.id = p.val_id",
      '        """, nativeQuery = true',
      "    )",
      "    void updateFechaPago();",
      '    @Query(value = "SELECT m.id FROM movprov m JOIN proveedores p ON p.id = m.p", nativeQuery = true)',
      "    List<FacturaPendienteEntity> findFacturasPendientes();",
      '    @Query("SELECT a FROM ArticuloEntity a WHERE a.tipo = :tipo")',
      "    List<ArticuloEntity> findByTipo(String tipo);",
      "}",
    ].join("\n"))!;
    expect(c.repoEntities).toEqual(["FacturaPendienteEntity"]);
    expect(c.kinds).toContain("repository");
    const upd = c.methods.find((m) => m.name === "updateFechaPago")!;
    expect(upd.tables.map((t) => `${t.table}:${t.access}:${t.via}`)).toEqual([
      "movprov_detallecomprobantes:write:native-sql",
      "valores:write:native-sql",
    ]);
    const find = c.methods.find((m) => m.name === "findFacturasPendientes")!;
    expect(find.tables.map((t) => `${t.table}:${t.access}`)).toEqual(["movprov:read", "proveedores:read"]);
    const jpql = c.methods.find((m) => m.name === "findByTipo")!;
    expect(jpql.jpqlEntities).toEqual(["ArticuloEntity"]);
    expect(jpql.tables).toEqual([]);
  });
});

describe("jvm clients and kafka", () => {
  // Value: protects=Feign call extraction incl. the real-world
  // name="svc/path" variant; fails_when=name splitting drops
  // (cross-repo matching keys on a bogus service); why_new.
  test("feign clients become calls with service + full path, glued names split", () => {
    const clean = extractConnections("ChequeraClient.java", [
      '@FeignClient(name = "sender-service", contextId = "chequeraClient", path = "/api/example/sender/chequera")',
      "public interface ChequeraClient {",
      '    @GetMapping("/generatePdf/{facultadId}")',
      "    Resource generatePdf(@PathVariable Integer facultadId);",
      '    @PostMapping("/send")',
      "    String send(@RequestBody String body);",
      "}",
    ].join("\n"))!;
    expect(clean.calls).toEqual([
      { method: "GET", path: "/api/example/sender/chequera/generatePdf/{facultadId}", targetService: "sender-service", via: "feign", caller: "generatePdf", line: 3 },
      { method: "POST", path: "/api/example/sender/chequera/send", targetService: "sender-service", via: "feign", caller: "send", line: 5 },
    ]);
    expect(clean.endpoints).toEqual([]);
    const glued = extractConnections("ComprobanteClient.java", [
      '@FeignClient(name = "core-service/api/example/core/comprobante")',
      "public interface ComprobanteClient {",
      '    @GetMapping("/{id}")',
      "    String byId(@PathVariable Long id);",
      "}",
    ].join("\n"))!;
    expect(glued.feign).toEqual({ targetService: "core-service", basePath: "/api/example/core/comprobante" });
    expect(glued.calls[0]).toMatchObject({ method: "GET", path: "/api/example/core/comprobante/{id}", targetService: "core-service" });
  });

  // Value: protects=WebClient literal-uri calls with the chain
  // verb, dynamic uris landing in notes; fails_when=window verb
  // detection drops; why_new=connections milestone.
  test("webclient uri literals become calls; dynamic uris are notes, never facts", () => {
    const c = extractConnections("PlanConsumer.java", [
      "public class PlanConsumer {",
      "    public Object plan(Integer facultadId) {",
      "        String baseUrl = resolver.getBaseUrl(facultadId);",
      "        return webClient.get()",
      '                .uri(baseUrl + "/plan/unique/{facultadId}/{planId}", facultadId)',
      "                .retrieve();",
      "    }",
      "    public Object dynamic(String path) {",
      "        return webClient.get().uri(path).retrieve();",
      "    }",
      "}",
    ].join("\n"))!;
    // `resolver` is not a literal `.uri(` receiver issue: caller tracks the enclosing method.
    expect(c.calls).toContainEqual({ method: "GET", path: "/plan/unique/{facultadId}/{planId}", via: "webclient", caller: "plan", line: 5, dynamicBase: true });
    expect(c.notes.some((n) => n.includes("unresolved WebClient uri"))).toBe(true);
  });

  // Value: protects=Kafka consume/produce with in-file constant
  // resolution and placeholder honesty; fails_when=topic args or
  // send() scanning drifts; why_new=connections milestone.
  test("kafka listener and template topics extract; placeholders are notes", () => {
    const c = extractConnections("MailService.java", [
      "public class MailService {",
      '    private static final String TOPIC = "send-chequera";',
      "    private final KafkaTemplate<String, Object> kafkaTemplate;",
      "    public void send(Object event) {",
      '        kafkaTemplate.send("send-chequera", event);',
      "        kafkaTemplate.send(TOPIC, event);",
      "    }",
      '    @KafkaListener(topics = "payment-processed", groupId = "g")',
      "    public void onPayment(Object event) { }",
      '    @KafkaListener(topics = "${app.topic}")',
      "    public void onOther(Object event) { }",
      "}",
    ].join("\n"))!;
    // KafkaTemplate<String, Object> as a field type proves the generic-field scan.
    expect(c.topics).toEqual([
      { topic: "payment-processed", direction: "consume", handler: "onPayment", line: 8 },
      { topic: "send-chequera", direction: "produce", handler: "send", line: 5 },
      { topic: "send-chequera", direction: "produce", handler: "send", line: 6 },
    ]);
    expect(c.notes.some((n) => n.includes("placeholder"))).toBe(true);
  });
});

describe("generic http passes", () => {
  // Value: protects=the same pipeline finding HTTP surfaces in
  // TS/Python/Go (any-repo promise); fails_when=a per-language
  // pass drops; why_new=connections milestone.
  test("ts, python and go endpoints and calls extract", () => {
    const ts = extractConnections("api.ts", [
      'app.get("/users/:id", handler);',
      'router.post("/users", handler);',
      'await fetch("https://example.com/api/things", { method: "POST" });',
      "await fetch(`/api/${id}`);",
    ].join("\n"))!;
    expect(ts.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /users/:id", "POST /users"]);
    expect(ts.calls).toEqual([{ method: "POST", path: "/api/things", via: "fetch", caller: "", line: 3, absoluteUrl: true }]);
    expect(ts.notes.length).toBe(1);

    const py = extractConnections("app.py", [
      '@app.get("/items/{item_id}")',
      "def read_item(item_id: int):",
      '    return requests.post("https://example.com/hook", json={})',
    ].join("\n"))!;
    expect(py.endpoints).toEqual([{ method: "GET", path: "/items/{item_id}", handler: "read_item", line: 1 }]);
    expect(py.calls).toEqual([{ method: "POST", path: "/hook", via: "http", caller: "", line: 3, absoluteUrl: true }]);

    const go = extractConnections("main.go", [
      'mux.HandleFunc("GET /widgets/{id}", h)',
      'r.POST("/widgets", h2)',
      'resp, err := http.Get("https://example.com/health")',
    ].join("\n"))!;
    expect(go.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(["GET /widgets/{id}", "POST /widgets"]);
    expect(go.calls).toEqual([{ method: "GET", path: "/health", via: "http", caller: "", line: 3, absoluteUrl: true }]);
  });

  // Value: protects=unsupported files returning undefined so the
  // server marks them unparsed instead of silently connection-free;
  // fails_when=the language gate widens accidentally; why_new.
  test("unsupported extensions extract nothing", () => {
    expect(extractConnections("notes.md", 'app.get("/x")')).toBeUndefined();
    expect(extractConnections("data.json", "{}")).toBeUndefined();
  });
});

describe("sql script declarations", () => {
  // Value: protects=migration table declarations (bare, quoted x3,
  // schema-qualified, IF NOT EXISTS, temp variants) each pinning
  // the CREATE line; fails_when=the ddl matcher drifts (declared
  // tables vanish from the join); why_new=contracts slice T1.
  test("a CREATE TABLE migration declares its table", () => {
    const c = extractConnections("migrations/001.sql", "CREATE TABLE users (\n  id INT\n);")!;
    expect(c.kinds).toEqual(["sql"]);
    expect(c.declaredTables).toEqual([{ table: "users", line: 1 }]);
    expect(c.tables).toEqual([]);
    expect(c.notes).toEqual([]);
    expect(c.methods).toEqual([]);
    expect(c.endpoints).toEqual([]);
    expect(c.calls).toEqual([]);
    expect(c.topics).toEqual([]);
    expect(c.injections).toEqual([]);
    expect(c.repoEntities).toEqual([]);
    expect(c.className).toBeUndefined();
    expect(c.entityName).toBeUndefined();
    expect(c.entityTable).toBeUndefined();
    expect(c.feign).toBeUndefined();
  });

  test("bare, quoted, schema-qualified, if-not-exists and temp declarations pin the CREATE line", () => {
    const c = extractConnections("migrations/001.sql", [
      "CREATE TABLE users (", // 1
      "  id INT", // 2
      ");", // 3
      'CREATE TABLE IF NOT EXISTS "AuditLog" (id INT);', // 4
      "CREATE TABLE app.accounts (id INT);", // 5
      "CREATE TEMPORARY TABLE tmp_import (id INT);", // 6
      "CREATE TEMP TABLE sesi (id INT);", // 7
      "CREATE TABLE `legacy` (id INT);", // 8
      "CREATE TABLE [dbo].[Staging] (id INT);", // 9
      "CREATE UNLOGGED TABLE fastcache (id INT);", // 10
      "CREATE FOREIGN TABLE fdw_remote (id INT);", // 11
      "CREATE GLOBAL TEMP TABLE gtmp (id INT);", // 12
      'CREATE TABLE "App"."Users" (id INT);', // 13
    ].join("\n"))!;
    expect(c.kinds).toEqual(["sql"]);
    expect(c.declaredTables).toEqual([
      { table: "users", line: 1 },
      { table: "auditlog", line: 4 },
      { table: "accounts", line: 5, schema: "app" },
      { table: "tmp_import", line: 6, temporary: true },
      { table: "sesi", line: 7, temporary: true },
      { table: "legacy", line: 8 },
      { table: "staging", line: 9, schema: "dbo" },
      { table: "fastcache", line: 10 },
      { table: "fdw_remote", line: 11 },
      { table: "gtmp", line: 12, temporary: true },
      { table: "users", line: 13, schema: "app" },
    ]);
    expect(c.tables).toEqual([]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=CTAS dual facts, view declarations, and FK
  // REFERENCES uses with per-token lines; fails_when=statement
  // matchers misattribute lines or drop the ddl side;
  // why_new=contracts slice T1.
  test("CTAS declares and references; views declare; FK references are ddl uses", () => {
    const c = extractConnections("migrations/002.sql", [
      "CREATE TABLE archive AS SELECT * FROM users;", // 1
      "CREATE VIEW active_users AS SELECT id FROM users JOIN accounts ON accounts.id = users.id;", // 2
      "CREATE TABLE orders (", // 3
      "  user_id INT REFERENCES users (id),", // 4
      "  FOREIGN KEY (user_id) REFERENCES app.users (id)", // 5
      ");", // 6
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([
      { table: "archive", line: 1 },
      { table: "active_users", line: 2 },
      { table: "orders", line: 3 },
    ]);
    expect(c.tables).toEqual([
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 1 },
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 2 },
      { table: "accounts", access: "read", via: "sql-script", derived: "explicit", line: 2 },
      { table: "users", access: "unknown", via: "ddl", derived: "explicit", line: 4 },
      { table: "app.users", access: "unknown", via: "ddl", derived: "explicit", line: 5 },
    ]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=ALTER/DROP/INDEX ddl uses and SELECT INTO
  // (use, not declaration); fails_when=ddl keywords drift;
  // why_new=contracts slice T1.
  test("alter, drop, index and select-into shapes", () => {
    const c = extractConnections("migrations/003.sql", [
      "ALTER TABLE users ADD COLUMN nick TEXT;", // 1
      "DROP TABLE IF EXISTS a, b CASCADE;", // 2
      "CREATE INDEX idx_users_nick ON users (nick);", // 3
      "SELECT id INTO archive_users FROM users;", // 4
      "SELECT * INTO TEMP TABLE tmp_users FROM users;", // 5
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([]);
    expect(c.tables).toEqual([
      { table: "users", access: "write", via: "ddl", derived: "explicit", line: 1 },
      { table: "a", access: "write", via: "ddl", derived: "explicit", line: 2 },
      { table: "b", access: "write", via: "ddl", derived: "explicit", line: 2 },
      { table: "users", access: "unknown", via: "ddl", derived: "explicit", line: 3 },
      { table: "archive_users", access: "write", via: "ddl", derived: "explicit", line: 4 },
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 4 },
      { table: "tmp_users", access: "write", via: "ddl", derived: "explicit", line: 5 },
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 5 },
    ]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=script SELECT/INSERT/UPDATE/DELETE/TABLE/WITH
  // access roll-up at keyword lines; fails_when=verb rules drift;
  // why_new=contracts slice T1.
  test("script dml pins keyword lines with rolled-up access", () => {
    const c = extractConnections("seed.sql", [
      "SELECT u.id, a.balance", // 1
      "FROM users u", // 2
      "JOIN accounts a ON a.id = u.id;", // 3
      "INSERT INTO audit (id) SELECT id FROM users;", // 4
      "UPDATE users SET nick = 'x' WHERE id = 1;", // 5
      "DELETE FROM sessions WHERE expired;", // 6
      "TABLE users;", // 7
      "WITH active AS (SELECT id FROM users) SELECT * FROM active;", // 8
    ].join("\n"))!;
    expect(c.tables).toEqual([
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 2 },
      { table: "accounts", access: "read", via: "sql-script", derived: "explicit", line: 3 },
      { table: "audit", access: "write", via: "sql-script", derived: "explicit", line: 4 },
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 4 },
      { table: "users", access: "write", via: "sql-script", derived: "explicit", line: 5 },
      { table: "sessions", access: "write", via: "sql-script", derived: "explicit", line: 6 },
      { table: "users", access: "unknown", via: "sql-script", derived: "explicit", line: 7 },
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 8 },
      { table: "active", access: "read", via: "sql-script", derived: "explicit", line: 8 },
    ]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=legacy comma joins (own name lines) and ONLY/
  // LATERAL noise skipping; fails_when=continuation parsing drops;
  // why_new=contracts slice T1.
  test("comma-joined tables cite their own name lines; only/lateral noise skipped", () => {
    const c = extractConnections("legacy.sql", [
      "SELECT * FROM a,", // 1
      "  b;", // 2
      "UPDATE ONLY c SET x = 1;", // 3
      "SELECT * FROM ONLY d;", // 4
      "SELECT * FROM t, LATERAL (SELECT * FROM u) x;", // 5
      "SELECT * FROM m, (SELECT * FROM n) y;", // 6
    ].join("\n"))!;
    expect(c.tables).toEqual([
      { table: "a", access: "read", via: "sql-script", derived: "explicit", line: 1 },
      { table: "b", access: "read", via: "sql-script", derived: "explicit", line: 2 },
      { table: "c", access: "write", via: "sql-script", derived: "explicit", line: 3 },
      { table: "d", access: "read", via: "sql-script", derived: "explicit", line: 4 },
      { table: "t", access: "read", via: "sql-script", derived: "explicit", line: 5 },
      { table: "u", access: "read", via: "sql-script", derived: "explicit", line: 5 },
      { table: "m", access: "read", via: "sql-script", derived: "explicit", line: 6 },
      { table: "n", access: "read", via: "sql-script", derived: "explicit", line: 6 },
    ]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=function-call FROM blanking (EXTRACT/
  // TRIM/SUBSTRING/OVERLAY/POSITION innards) and IS DISTINCT
  // FROM (predicate, never a table); fails_when=an inner token
  // becomes a table fact (created_at is a column, not a table).
  test("function-call FROM and DISTINCT FROM yield no table facts", () => {
    const c = extractConnections("funcs.sql", [
      "SELECT EXTRACT(YEAR FROM created_at) FROM events;", // 1
      "SELECT TRIM(BOTH ' ' FROM name) FROM users;", // 2
      "SELECT SUBSTRING(code FROM 1 FOR 3) FROM products;", // 3
      "SELECT OVERLAY(code PLACING 'XX' FROM 2 FOR 2) FROM products;", // 4
      "SELECT * FROM orders WHERE status IS DISTINCT FROM 'shipped';", // 5
      "SELECT POSITION(',' IN tags) FROM items;", // 6
      "SELECT SUBSTRING(TRIM(x FROM y) FROM 1) FROM nested;", // 7
    ].join("\n"))!;
    expect(c.tables).toEqual([
      { table: "events", access: "read", via: "sql-script", derived: "explicit", line: 1 },
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 2 },
      { table: "products", access: "read", via: "sql-script", derived: "explicit", line: 3 },
      { table: "products", access: "read", via: "sql-script", derived: "explicit", line: 4 },
      { table: "orders", access: "read", via: "sql-script", derived: "explicit", line: 5 },
      { table: "items", access: "read", via: "sql-script", derived: "explicit", line: 6 },
      { table: "nested", access: "read", via: "sql-script", derived: "explicit", line: 7 },
    ]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=trigger headers, upserts, subqueries, CTE
  // writes, view variants, and ddl edge names; fails_when=any
  // keyword-adjacency guard regresses; why_new=contracts T1.
  test("ddl edge shapes: trigger guards, on-conflict, subqueries, with-write, view variants", () => {
    const c = extractConnections("edge.sql", [
      "CREATE TRIGGER trg AFTER UPDATE ON t FOR EACH ROW EXECUTE FUNCTION f();", // 1
      "INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET id = 1;", // 2
      "SELECT * FROM (SELECT * FROM u) x;", // 3
      "WITH x AS (UPDATE t SET a = 1 RETURNING a) SELECT * FROM x;", // 4
      "CREATE OR REPLACE VIEW v AS SELECT * FROM s2;", // 5
      "CREATE MATERIALIZED VIEW mv AS SELECT * FROM s3;", // 6
      "CREATE TEMP VIEW tv AS SELECT * FROM s4;", // 7
      "CREATE TABLE a.b.c (id INT);", // 8
      "ALTER TABLE ONLY app.o ADD COLUMN x INT;", // 9
      "CREATE UNIQUE INDEX CONCURRENTLY ix ON ONLY p (x);", // 10
      "CREATE INDEX broken;", // 11
      "DROP TABLE;", // 12
      "CREATE TABLE;", // 13
      "SELECT * FROM t WHERE x IN (SELECT y FROM z);", // 14
      'UPDATE "on" SET x = 1;', // 15
      "CREATE VIEW;", // 16
      "CREATE TABLE bad!name (id INT);", // 17
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([
      { table: "v", line: 5 },
      { table: "mv", line: 6 },
      { table: "tv", line: 7, temporary: true },
    ]);
    expect(c.tables).toEqual([
      { table: "t", access: "write", via: "sql-script", derived: "explicit", line: 2 },
      { table: "u", access: "read", via: "sql-script", derived: "explicit", line: 3 },
      { table: "t", access: "write", via: "sql-script", derived: "explicit", line: 4 },
      { table: "x", access: "read", via: "sql-script", derived: "explicit", line: 4 },
      { table: "s2", access: "read", via: "sql-script", derived: "explicit", line: 5 },
      { table: "s3", access: "read", via: "sql-script", derived: "explicit", line: 6 },
      { table: "s4", access: "read", via: "sql-script", derived: "explicit", line: 7 },
      { table: "app.o", access: "write", via: "ddl", derived: "explicit", line: 9 },
      { table: "p", access: "unknown", via: "ddl", derived: "explicit", line: 10 },
      { table: "t", access: "read", via: "sql-script", derived: "explicit", line: 14 },
      { table: "z", access: "read", via: "sql-script", derived: "explicit", line: 14 },
      { table: "on", access: "write", via: "sql-script", derived: "explicit", line: 15 },
    ]);
    expect(c.notes).toEqual([
      "unresolved CREATE TABLE name at line 8",
      "unresolved CREATE INDEX name at line 11",
      "unresolved DROP TABLE name at line 12",
      "unresolved CREATE TABLE name at line 13",
      "unresolved CREATE VIEW name at line 16",
      "unresolved CREATE TABLE name at line 17",
    ]);
  });

  // Value: protects=FK ON UPDATE/DELETE actions (CASCADE is never
  // a table) and quoted dotted names; fails_when=the UPDATE
  // lookbehind or quoted-dot splitting drifts; why_new=T1.
  test("fk actions never become tables; quoted dots stay one name", () => {
    const c = extractConnections("fk.sql", [
      "CREATE TABLE k (a INT, FOREIGN KEY (a) REFERENCES p (id) ON UPDATE CASCADE ON DELETE SET NULL);", // 1
      'CREATE TABLE "a.b" (id INT);', // 2
      'SELECT * FROM "s"."T" JOIN [u] ON 1 = 1;', // 3
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([
      { table: "k", line: 1 },
      { table: "a.b", line: 2 },
    ]);
    expect(c.tables).toEqual([
      { table: "p", access: "unknown", via: "ddl", derived: "explicit", line: 1 },
      { table: "s.t", access: "read", via: "sql-script", derived: "explicit", line: 3 },
      { table: "u", access: "read", via: "sql-script", derived: "explicit", line: 3 },
    ]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=WITH..SELECT INTO and MERGE INTO access
  // rules; fails_when=the into-family classification drifts;
  // why_new=contracts slice T1.
  test("with-select-into creates; merge-into is a plain script use", () => {
    const c = extractConnections("into.sql", [
      "WITH x AS (SELECT id FROM s) SELECT * INTO t FROM x;", // 1
      "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET id = 1;", // 2
    ].join("\n"))!;
    expect(c.tables).toEqual([
      { table: "s", access: "read", via: "sql-script", derived: "explicit", line: 1 },
      { table: "t", access: "write", via: "ddl", derived: "explicit", line: 1 },
      { table: "x", access: "read", via: "sql-script", derived: "explicit", line: 1 },
      { table: "t", access: "unknown", via: "sql-script", derived: "explicit", line: 2 },
    ]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=unparseable ALTER/INDEX/REFERENCES names
  // noting (never silent, never facts) and multi-comma
  // continuations; fails_when=ddl edge notes drop;
  // why_new=contracts slice T1.
  test("unparseable ddl names note; three-way comma joins all cite", () => {
    const c = extractConnections("edge2.sql", [
      "ALTER TABLE;", // 1
      "ALTER TABLE bad!name ADD COLUMN x INT;", // 2
      "CREATE INDEX i ON;", // 3
      "CREATE INDEX i ON bad!x (a);", // 4
      "SELECT * FROM a, b, c;", // 5
      "CREATE TABLE q (x INT REFERENCES t!bad);", // 6
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([{ table: "q", line: 6 }]);
    expect(c.tables).toEqual([
      { table: "a", access: "read", via: "sql-script", derived: "explicit", line: 5 },
      { table: "b", access: "read", via: "sql-script", derived: "explicit", line: 5 },
      { table: "c", access: "read", via: "sql-script", derived: "explicit", line: 5 },
    ]);
    expect(c.notes).toEqual([
      "unresolved ALTER TABLE name at line 1",
      "unresolved ALTER TABLE name at line 2",
      "unresolved CREATE INDEX name at line 3",
      "unresolved CREATE INDEX name at line 4",
    ]);
  });

  // Value: protects=file selection (lowercase .sql only, sibling
  // extensions stay out) and empty-script shape; fails_when=the
  // language gate widens; why_new=contracts slice FR1/FR2.
  test("sql file selection is lowercase-.sql-only; empty scripts stay empty", () => {
    expect(extractConnections("SCHEMA.SQL", "CREATE TABLE t (id INT);")).toBeUndefined();
    expect(extractConnections("migrate.ddl", "CREATE TABLE t (id INT);")).toBeUndefined();
    expect(extractConnections("migrate.psql", "CREATE TABLE t (id INT);")).toBeUndefined();
    expect(extractConnections("001.migration", "CREATE TABLE t (id INT);")).toBeUndefined();
    const c = extractConnections("empty.sql", "-- nothing here\n")!;
    expect(c.kinds).toEqual(["sql"]);
    expect(c.declaredTables).toEqual([]);
    expect(c.tables).toEqual([]);
    expect(c.notes).toEqual([]);
  });
});

describe("sql script dynamics", () => {
  // Value: protects=FR9 dynamics (placeholder DDL, EXEC(UTE),
  // meta-commands, dollar bodies) noting without facts;
  // fails_when=a dynamic name becomes a fact or goes silent;
  // why_new=contracts slice T2.
  test("placeholder ddl names, execute, meta-commands and dollar bodies note without facts", () => {
    const c = extractConnections("dyn.sql", [
      "CREATE TABLE ${schema}.users (id INT);", // 1
      "CREATE TABLE :tbl (id INT);", // 2
      "EXECUTE 'CREATE TABLE dyn (id INT)';", // 3
      "EXEC sp_help;", // 4
      "\\i other.sql", // 5
      "CREATE FUNCTION f() RETURNS void AS $$", // 6
      "BEGIN", // 7
      "  CREATE TABLE hidden (id INT);", // 8
      "END", // 9
      "$$ LANGUAGE plpgsql;", // 10
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([]);
    expect(c.tables).toEqual([]);
    expect(c.notes).toEqual([
      "unresolved placeholder table name at line 1",
      "unresolved placeholder table name at line 2",
      "unresolved EXECUTE statement at line 3",
      "unresolved EXEC statement at line 4",
      "unresolved psql meta-command at line 5",
      "unresolved dollar-quoted body at line 6",
    ]);
  });

  // Value: protects=remaining placeholder shapes, comma
  // placeholders, and silent plain dollar strings;
  // fails_when=placeholder detection misses a shape;
  // why_new=contracts slice T2.
  test("remaining placeholder shapes note; plain dollar strings stay silent", () => {
    const c = extractConnections("dyn2.sql", [
      "CREATE TABLE t_$1 (id INT);", // 1
      "SELECT * FROM %(tbl)s;", // 2
      "SELECT * FROM @tbl;", // 3
      "SELECT $$just a string$$;", // 4
      "SELECT * FROM a, :b;", // 5
      "CREATE TABLE app.%(t)s (id INT);", // 6
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([]);
    expect(c.tables).toEqual([{ table: "a", access: "read", via: "sql-script", derived: "explicit", line: 5 }]);
    expect(c.notes).toEqual([
      "unresolved placeholder table name at line 1",
      "unresolved placeholder table name at line 2",
      "unresolved placeholder table name at line 3",
      "unresolved placeholder table name at line 5",
      "unresolved placeholder table name at line 6",
    ]);
  });

  // Value: protects=DDL-position placeholders, all listed
  // meta-commands, procedure/DO bodies, and silent unlisted
  // meta-commands; fails_when=any FR9 construct goes silent;
  // why_new=contracts slice T2.
  test("ddl placeholders, every listed meta-command, procedure and do bodies", () => {
    const c = extractConnections("dyn3.sql", [
      "ALTER TABLE ${t} ADD COLUMN x INT;", // 1
      "DROP TABLE ${gone};", // 2
      "CREATE INDEX i ON :t (a);", // 3
      "CREATE TABLE r (x INT REFERENCES ${p} (id));", // 4
      "CREATE TABLE r2 (x INT REFERENCES);", // 5
      "\\include base.sql", // 6
      "\\ir rel.sql", // 7
      "\\gexec", // 8
      "\\d users", // 9
      "CREATE PROCEDURE p() AS $body$ BEGIN END $body$ LANGUAGE plpgsql;", // 10
      "DO $do$ BEGIN RAISE NOTICE 'x'; END $do$;", // 11
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([
      { table: "r", line: 4 },
      { table: "r2", line: 5 },
    ]);
    expect(c.tables).toEqual([]);
    expect(c.notes).toEqual([
      "unresolved placeholder table name at line 1",
      "unresolved placeholder table name at line 2",
      "unresolved placeholder table name at line 3",
      "unresolved placeholder table name at line 4",
      "unresolved psql meta-command at line 6",
      "unresolved psql meta-command at line 7",
      "unresolved psql meta-command at line 8",
      "unresolved dollar-quoted body at line 10",
      "unresolved dollar-quoted body at line 11",
    ]);
  });

  // Value: protects=quoted CASCADE (deliberate) vs bare CASCADE
  // (list end) in DROP; fails_when=the cascade guard flips;
  // why_new=contracts slice T1.
  test("drop lists end at bare cascade; quoted cascade is a table", () => {
    const c = extractConnections("drop.sql", 'DROP TABLE "cascade", q RESTRICT;')!;
    expect(c.tables).toEqual([
      { table: "cascade", access: "write", via: "ddl", derived: "explicit", line: 1 },
      { table: "q", access: "write", via: "ddl", derived: "explicit", line: 1 },
    ]);
    expect(c.notes).toEqual([]);
  });
});

describe("sql splitter traps", () => {
  // Value: protects=FR3/FR5 (comment/string keyword tokens never
  // yield facts, `;` inside literals never splits) with true
  // lines around the traps; fails_when=masking leaks;
  // why_new=contracts slice T3.
  test("comment and string tokens yield nothing; semicolons inside literals do not split", () => {
    const c = extractConnections("trap.sql", [
      "-- CREATE TABLE fake1 (id INT);", // 1
      "/* CREATE TABLE fake2 (id INT);", // 2
      "   FROM fake3 */", // 3
      "CREATE TABLE real1 (id INT);", // 4
      "SELECT 'FROM fake4; CREATE TABLE fake5' FROM real2;", // 5
      'SELECT "FROM fake6" FROM real3;', // 6
      "# CREATE TABLE fake7 (id INT)", // 7
      "SELECT `weird;col` FROM real4;", // 8
      "SELECT/*c*/a FROM real5;", // 9
      "/* outer /* inner FROM fake8 */ still comment */ SELECT * FROM real6;", // 10
      "CREATE VIEW v AS SELECT * FROM references r;", // 11
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([
      { table: "real1", line: 4 },
      { table: "v", line: 11 },
    ]);
    expect(c.tables).toEqual([
      { table: "real2", access: "read", via: "sql-script", derived: "explicit", line: 5 },
      { table: "real3", access: "read", via: "sql-script", derived: "explicit", line: 6 },
      { table: "real4", access: "read", via: "sql-script", derived: "explicit", line: 8 },
      { table: "real5", access: "read", via: "sql-script", derived: "explicit", line: 9 },
      { table: "real6", access: "read", via: "sql-script", derived: "explicit", line: 10 },
      { table: "references", access: "read", via: "sql-script", derived: "explicit", line: 11 },
    ]);
    expect(c.notes).toEqual([]);
  });

  // Value: protects=same-line statements, quote escapes, CRLF,
  // and unclosed constructs masking to EOF; fails_when=the
  // splitter misattributes lines; why_new=contracts T3.
  test("same-line statements, escapes, crlf and unclosed constructs", () => {
    const c = extractConnections("trap2.sql", [
      "CREATE TABLE a (id INT); CREATE TABLE b (id INT);;", // 1
      "SELECT 'it''s; tricky' FROM c;", // 2
      "SELECT 'a\\'b' FROM d;", // 3
      "/* unclosed comment", // 4
      "CREATE TABLE ghost (id INT);", // 5
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([
      { table: "a", line: 1 },
      { table: "b", line: 1 },
    ]);
    expect(c.tables.map((t) => `${t.table}@${t.line}`)).toEqual(["c@2", "d@3"]);
    expect(c.notes).toEqual([]);
    const crlf = extractConnections("crlf.sql", "CREATE TABLE t (id INT);\r\nSELECT * FROM t;\r\n")!;
    expect(crlf.declaredTables).toEqual([{ table: "t", line: 1 }]);
    expect(crlf.tables).toEqual([{ table: "t", access: "read", via: "sql-script", derived: "explicit", line: 2 }]);
    const unclosed = extractConnections("unclosed.sql", "SELECT 'abc")!;
    expect(unclosed.declaredTables).toEqual([]);
    expect(unclosed.tables).toEqual([]);
    expect(unclosed.notes).toEqual([]);
    const unclosedDollar = extractConnections("undollar.sql", "CREATE FUNCTION g() RETURNS void AS $$\nBEGIN\n")!;
    expect(unclosedDollar.notes).toEqual([
      "unresolved unterminated dollar-quote at line 1",
      "unresolved dollar-quoted body at line 1",
    ]);
  });

  // Value: protects=the Postgres `#` carve-out (`#>`/`#>>`/
  // `#-`/glued `#` are operators: tables stay visible,
  // statements still split) while spaced `#` stays a comment,
  // and the unterminated dollar-quote note; fails_when=`#`
  // hides a table or an unclosed quote goes silent.
  test("hash operators parse; spaced hash comments; unterminated dollar quotes note", () => {
    const c = extractConnections("hash.sql", [
      "SELECT payload #> '{a}' FROM events;", // 1
      "SELECT payload #>> '{a}' FROM items;", // 2
      "SELECT payload #- '{a}' FROM stash;", // 3
      "SELECT a#b FROM bits;", // 4
      "# a real comment: CREATE TABLE fake (id INT);", // 5
      "SELECT * FROM users; -- trailing", // 6
      "SELECT one FROM t1; SELECT two FROM t2;", // 7
    ].join("\n"))!;
    expect(c.declaredTables).toEqual([]);
    expect(c.tables).toEqual([
      { table: "events", access: "read", via: "sql-script", derived: "explicit", line: 1 },
      { table: "items", access: "read", via: "sql-script", derived: "explicit", line: 2 },
      { table: "stash", access: "read", via: "sql-script", derived: "explicit", line: 3 },
      { table: "bits", access: "read", via: "sql-script", derived: "explicit", line: 4 },
      { table: "users", access: "read", via: "sql-script", derived: "explicit", line: 6 },
      { table: "t1", access: "read", via: "sql-script", derived: "explicit", line: 7 },
      { table: "t2", access: "read", via: "sql-script", derived: "explicit", line: 7 },
    ]);
    expect(c.notes).toEqual([]);
    const u = extractConnections("undollar2.sql", [
      "SELECT * FROM ok;", // 1
      "SELECT $body$oops FROM nowhere;", // 2
      "SELECT * FROM hidden;", // 3
    ].join("\n"))!;
    expect(u.tables).toEqual([{ table: "ok", access: "read", via: "sql-script", derived: "explicit", line: 1 }]);
    expect(u.notes).toEqual(["unresolved unterminated dollar-quote at line 2"]);
  });
});

describe("canonical keys", () => {
  // Value: protects=cross-repo join keys (param names collapse,
  // service spelling variants unify); fails_when=normalization
  // drifts on either side (matched endpoints silently split);
  // why_new=connections milestone.
  test("endpoint and service keys normalize spelling variants", () => {
    expect(endpointKey("GET", "/api/chequera/generatePdf/{facultadId}/")).toBe("GET /api/chequera/generatePdf/{}");
    expect(endpointKey("get", "api/x/{id}")).toBe(endpointKey("GET", "/api/x/{otherId}"));
    expect(canonicalService("Example.Core_Service")).toBe("example-core-service");
    expect(canonicalService("example-core-service")).toBe(canonicalService("Example.Core-Service"));
  });
});

describe("codex outside-review fixes", () => {
  // Value: protects=Feign explicit url winning over name (no local
  // join), Kotlin constructor property types not becoming
  // supertypes, declaration-line strings not becoming calls,
  // constant class bases not becoming root paths;
  // fails_when=any of these literal-only guards regresses.
  test("feign name+url is absolute, kotlin supertype is the port, decl-line strings are not calls, const class base unresolved", () => {
    const feign = extractConnections("PayClient.java", [
      '@FeignClient(name = "payments", url = "https://third-party.example")',
      "public interface PayClient {",
      '    @GetMapping("/charge")',
      "    Object charge();",
      "}",
    ].join("\n"))!;
    expect(feign.calls.length).toBe(1);
    expect(feign.calls[0]!.absoluteUrl).toBe(true);
    expect(feign.calls[0]!.targetService).toBe("third-party.example");

    const kt = extractConnections("Svc.kt", [
      "@Service",
      "class Svc(private val repo: Repo) : Port {",
      "    override fun go() = repo.findAll()",
      "}",
    ].join("\n"))!;
    expect(kt.supertypes).toEqual(["Port"]);

    const phantom = extractConnections("P.java", [
      "public class P {",
      '    public Object get() { String s = "repo.deleteAll()"; return null; }',
      "}",
    ].join("\n"))!;
    expect(phantom.methods.flatMap((m) => m.calls)).toEqual([]);

    const constBase = extractConnections("C.java", [
      "@RestController",
      "@RequestMapping(Paths.BASE)",
      "public class C {",
      '    @GetMapping("/x")',
      "    public Object x() { return null; }",
      "}",
    ].join("\n"))!;
    expect(constBase.endpoints).toEqual([]);
    expect(constBase.notes.some((n) => n.includes("unresolved class-level mapping"))).toBe(true);
  });

  // Value: protects=concatenated literals staying unresolved
  // prefixes, and JAX-RS/Django being visibly unsupported;
  // fails_when=partial literals become complete paths or an
  // unsupported framework goes silent.
  test("concatenated literals are notes; jax-rs and django say unsupported", () => {
    const ts = extractConnections("a.ts", [
      'fetch("/users/" + id);',
      'app.get("/prefix" + suffix, handler);',
    ].join("\n"))!;
    expect(ts.calls).toEqual([]);
    expect(ts.endpoints).toEqual([]);
    expect(ts.notes.length).toBe(2);

    const jax = extractConnections("R.java", [
      "import jakarta.ws.rs.Path;",
      '@Path("/items")',
      "public class R {}",
    ].join("\n"))!;
    expect(jax.endpoints).toEqual([]);
    expect(jax.notes.some((n) => n.includes("JAX-RS"))).toBe(true);

    const dj = extractConnections("urls.py", [
      "from django.urls import path",
      "urlpatterns = [path('x/', view)]",
    ].join("\n"))!;
    expect(dj.endpoints).toEqual([]);
    expect(dj.notes.some((n) => n.includes("Django"))).toBe(true);
  });
});
