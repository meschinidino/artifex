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
