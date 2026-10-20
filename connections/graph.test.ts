/**
 * Graph chains: endpoint->service->usecase->repository->entity and
 * native SQL, plus the two-repo Feign/Kafka join. Fixtures are fed
 * through the real extractor, so this is also an integration test
 * of extractor field/method shapes.
 */
import { describe, expect, test } from "bun:test";
import { extractConnections } from "./extract.ts";
import { buildConnectionGraph, detectServiceName, type RepoInput } from "./graph.ts";
import type { FileConnections } from "./types.ts";

function repoFromSources(label: string, serviceName: string | undefined, sources: Record<string, string>, imports: Record<string, string[]>, specifiers: Record<string, string[]> = {}): RepoInput {
  const files = new Map<string, FileConnections>();
  const typeIndex = new Map<string, string[]>();
  for (const [path, src] of Object.entries(sources)) {
    const fc = extractConnections(path, src)!;
    files.set(path, fc);
    if (fc.className) typeIndex.set(fc.className, [...(typeIndex.get(fc.className) ?? []), path]);
  }
  const importTargets = new Map(Object.entries(imports).map(([k, v]) => [k, new Set(v)]));
  const importSpecifiers = new Map(Object.entries(specifiers));
  return { label, serviceName, files, typeIndex, importTargets, importSpecifiers };
}

const CORE = repoFromSources("core", "example-core-service", {
  "ArticuloController.java": [
    "@RestController",
    '@RequestMapping("/api/example/core/articulo")',
    "public class ArticuloController {",
    "    private final ArticuloService articuloService;",
    '    @GetMapping("/{id}")',
    "    public Object byId(Long id) { return articuloService.getById(id); }",
    "}",
  ].join("\n"),
  "ArticuloService.java": [
    "@Service",
    "public class ArticuloService {",
    "    private final GetArticuloUseCase getArticuloUseCase;",
    "    public Object getById(Long id) { return getArticuloUseCase.get(id); }",
    "}",
  ].join("\n"),
  "GetArticuloUseCase.java": [
    "public interface GetArticuloUseCase {",
    "    Object get(Long id);",
    "}",
  ].join("\n"),
  "GetArticuloUseCaseImpl.java": [
    "@Service",
    "public class GetArticuloUseCaseImpl implements GetArticuloUseCase {",
    "    private final JpaArticuloRepository articuloRepository;",
    "    private final ChequeraClient chequeraClient;",
    "    public Object get(Long id) {",
    "        chequeraClient.generatePdf(1);",
    "        return articuloRepository.findById(id);",
    "    }",
    "}",
  ].join("\n"),
  "JpaArticuloRepository.java": [
    "public interface JpaArticuloRepository extends JpaRepository<ArticuloEntity, Long> {",
    '    @Query(value = "SELECT a.id FROM articulos a JOIN cuentas c ON c.id = a.cuenta_id", nativeQuery = true)',
    "    List<ArticuloEntity> findById(Long id);",
    "}",
  ].join("\n"),
  "ArticuloEntity.java": [
    "@Entity",
    '@Table(name = "articulos")',
    "public class ArticuloEntity { }",
  ].join("\n"),
  "ChequeraClient.java": [
    '@FeignClient(name = "example-sender-service", path = "/api/example/sender/chequera")',
    "public interface ChequeraClient {",
    '    @GetMapping("/generatePdf/{id}")',
    "    String generatePdf(Integer id);",
    "}",
  ].join("\n"),
  "MailChequeraService.java": [
    "@Service",
    "public class MailChequeraService {",
    "    private final KafkaTemplate<String, Object> kafkaTemplate;",
    "    public void send(Object e) { kafkaTemplate.send(\"send-chequera\", e); }",
    "}",
  ].join("\n"),
}, {
  "ArticuloController.java": ["ArticuloService.java"],
  "ArticuloService.java": ["GetArticuloUseCase.java"],
  "GetArticuloUseCaseImpl.java": ["JpaArticuloRepository.java", "ChequeraClient.java", "GetArticuloUseCase.java"],
  "JpaArticuloRepository.java": ["ArticuloEntity.java"],
});

const SENDER = repoFromSources("sender", "example-sender-service", {
  "ChequeraController.java": [
    "@RestController",
    '@RequestMapping("/api/example/sender/chequera")',
    "public class ChequeraController {",
    '    @GetMapping("/generatePdf/{chequeraId}")',
    "    public Object generatePdf(Integer chequeraId) { return null; }",
    "}",
  ].join("\n"),
  "ChequeraEventListener.java": [
    "@Component",
    "public class ChequeraEventListener {",
    '    @KafkaListener(topics = "send-chequera")',
    "    public void onEvent(Object e) { }",
    "}",
  ].join("\n"),
  "ArticuloClient.java": [
    '@FeignClient(name = "example-core-service/api/example/core/articulo")',
    "public interface ArticuloClient {",
    '    @GetMapping("/{articuloId}")',
    "    String byId(Long articuloId);",
    "}",
  ].join("\n"),
}, {});

describe("connection graph", () => {
  // Value: protects=the per-function table claim end to end
  // (handler -> service -> usecase -> repo method -> entity+native
  // SQL); fails_when=any hop drops (empty per-endpoint tables);
  // why_new=connections milestone.
  // Value: protects=F6 (trace ## tables shows direct use: a
  // direct read plus an injected write must not report as direct
  // readwrite); fails_when=direct tables derive from the merged
  // closure instead of the file's own facts.
  test("directByFile keeps the file's own access before transitive merging", () => {
    const R = repoFromSources("shop", undefined, {
      "ReportService.java": [
        "public class ReportService {",
        "    private final WriterService writer;",
        '    @Query(value = "SELECT id FROM orders", nativeQuery = true)',
        "    List<Long> ids();",
        "}",
      ].join("\n"),
      "WriterService.java": [
        "public class WriterService {",
        '    @Query(value = "INSERT INTO orders (id) VALUES (1)", nativeQuery = true)',
        "    void add();",
        "}",
      ].join("\n"),
    }, { "ReportService.java": ["WriterService.java"] });
    const g = buildConnectionGraph([R]);
    const key = (p: string): string => `shop${String.fromCharCode(0)}${p}`;
    expect(g.directByFile.get(key("ReportService.java"))).toEqual([
      { table: "orders", access: "read", via: "native-sql", derived: "explicit", through: "ReportService" },
    ]);
    // The merged summary still reports the transitive closure.
    expect(g.byFile.get(key("ReportService.java"))!.tables).toEqual([
      { table: "orders", access: "readwrite", via: "native-sql", derived: "explicit", through: "ReportService" },
    ]);
  });

  test("endpoint tables chain through injected collaborators, across an interface port, to entity and native SQL", () => {
    const g = buildConnectionGraph([CORE]);
    const ctrl = g.byFile.get("core\0ArticuloController.java")!;
    expect(ctrl.endpoints.length).toBe(1);
    const ep = ctrl.endpoints[0]!;
    expect(`${ep.method} ${ep.path}`).toBe("GET /api/example/core/articulo/{id}");
    // findById proves read (its own native SELECT + derived-name
    // semantics); the repository's capability is never inflated.
    expect(ep.tables.map((t) => `${t.table}:${t.access}`)).toEqual(["articulos:read", "cuentas:read"]);
    // File-level tables agree with the endpoint chain here.
    expect(ctrl.tables.map((t) => t.table)).toEqual(["articulos", "cuentas"]);
    // A file with no persistence reach shows no tables rather than guesses.
    expect(g.byFile.get("core\0ChequeraClient.java")!.tables).toEqual([]);
  });

  // Value: protects=the cross-repo join: Feign calls match
  // controller endpoints across repos by canonical key+service,
  // in both directions, and Kafka topics pair producer/consumer;
  // fails_when=normalization or service filtering drifts;
  // why_new=connections milestone.
  test("feign calls and kafka topics join across repos in both directions", () => {
    const g = buildConnectionGraph([CORE, SENDER]);
    const client = g.byFile.get("core\0ChequeraClient.java")!;
    expect(client.calls[0]!.matchedPath).toBe("sender:ChequeraController.java");
    const senderCtrl = g.byFile.get("sender\0ChequeraController.java")!;
    expect(senderCtrl.endpoints[0]!.callers).toEqual([
      { path: "core:ChequeraClient.java", caller: "generatePdf", via: "feign", line: 3 },
    ]);
    const back = g.byFile.get("sender\0ArticuloClient.java")!;
    expect(back.calls[0]!.matchedPath).toBe("core:ArticuloController.java");
    const producer = g.byFile.get("core\0MailChequeraService.java")!;
    expect(producer.topics[0]).toMatchObject({ topic: "send-chequera", direction: "produce" });
    expect(producer.topics[0]!.peers).toEqual(["sender:ChequeraEventListener.java"]);
    expect(g.totals.matchedCalls).toBe(2);
    expect(g.totals.unmatchedCalls).toBe(0);
    expect(g.totals.crossRepoLinks).toBe(2);
    expect(g.totals.topics).toBe(1);
  });

  // Value: protects=unmatched calls staying visible as unmatched
  // (no owner in the indexed repos) instead of joining a same-path
  // endpoint on the wrong service; fails_when=service filtering
  // drops; why_new=connections milestone.
  test("a feign call to an unindexed service does not match a same-path endpoint elsewhere", () => {
    const OTHER = repoFromSources("other", "other-service", {
      "ChequeraController.java": SENDER.files.get("ChequeraController.java") ? [
        "@RestController",
        '@RequestMapping("/api/example/sender/chequera")',
        "public class ChequeraController {",
        '    @GetMapping("/generatePdf/{x}")',
        "    public Object generatePdf(Integer x) { return null; }",
        "}",
      ].join("\n") : "",
    }, {});
    // Core's client targets example-sender-service; only "other" (a
    // different service name) is indexed alongside core here.
    const g = buildConnectionGraph([CORE, OTHER]);
    expect(g.byFile.get("core\0ChequeraClient.java")!.calls[0]!.matchedPath).toBeUndefined();
    expect(g.totals.unmatchedCalls).toBeGreaterThan(0);
  });

  // Value: protects=dynamic-base WebClient calls (`base + "/x"`)
  // never joining a same-path endpoint on an unproven host (the
  // extern-facultad false positive found on real core);
  // fails_when=path-only matching returns; why_new=audit fix.
  // Value: protects=absolute external URLs never joining by path
  // alone, and topic peers being only the opposite direction (no
  // producer->producer belts); fails_when=matching or peer
  // filtering regresses; why_new=outside review P1/P2.
  test("absolute urls do not join, and topic peers are opposite-direction only", () => {
    const A = repoFromSources("a", "a-service", {
      "HealthController.java": [
        "@RestController",
        "public class HealthController {",
        '    @GetMapping("/health")',
        "    public Object health() { return null; }",
        "}",
      ].join("\n"),
      "Pinger.java": [
        "public class Pinger {",
        '    public Object ping() { return restTemplate.getForObject("https://example.com/health", String.class); }',
        "}",
      ].join("\n"),
      "ProducerOne.java": [
        "public class ProducerOne {",
        "    private final KafkaTemplate<String, Object> kafkaTemplate;",
        '    public void go(Object e) { kafkaTemplate.send("events", e); }',
        "}",
      ].join("\n"),
      "ProducerTwo.java": [
        "public class ProducerTwo {",
        "    private final KafkaTemplate<String, Object> kafkaTemplate;",
        '    public void go(Object e) { kafkaTemplate.send("events", e); }',
        "}",
      ].join("\n"),
      "Consumer.java": [
        "public class Consumer {",
        '    @KafkaListener(topics = "events")',
        "    public void onEvent(Object e) { }",
        "}",
      ].join("\n"),
    }, {});
    const B = repoFromSources("b", "b-service", {}, {});
    const g = buildConnectionGraph([A, B]);
    expect(g.byFile.get("a\0Pinger.java")!.calls[0]!.matchedPath).toBeUndefined();
    expect(g.byFile.get("a\0HealthController.java")!.endpoints[0]!.callers).toEqual([]);
    expect(g.byFile.get("a\0ProducerOne.java")!.topics[0]!.peers).toEqual(["a:Consumer.java"]);
    expect(g.byFile.get("a\0Consumer.java")!.topics[0]!.peers.sort()).toEqual(["a:ProducerOne.java", "a:ProducerTwo.java"]);
  });

  test("dynamic-base webclient calls stay unmatched even when the path exists in-repo", () => {
    const R = repoFromSources("r", "r-service", {
      "PlanController.java": [
        "@RestController",
        "public class PlanController {",
        '    @GetMapping("/plan/unique/{id}")',
        "    public Object unique(Long id) { return null; }",
        "}",
      ].join("\n"),
      "PlanConsumer.java": [
        "public class PlanConsumer {",
        "    public Object get(String baseUrl) {",
        '        return webClient.get().uri(baseUrl + "/plan/unique/{id}", 1).retrieve();',
        "    }",
        "}",
      ].join("\n"),
    }, {});
    const g = buildConnectionGraph([R]);
    const consumer = g.byFile.get("r\0PlanConsumer.java")!;
    expect(consumer.calls.length).toBe(1);
    expect(consumer.calls[0]!.matchedPath).toBeUndefined();
    expect(g.byFile.get("r\0PlanController.java")!.endpoints[0]!.callers).toEqual([]);
  });

  // Value: protects=a targetless relative call never joining another
  // repo's same-path endpoint, a named Feign target never matching
  // an unclaimed service name, and ambiguous owners never matching
  // at all; fails_when=path-only matching returns;
  // why_new=Codex outside review P1.
  test("unproven destinations stay unmatched: cross-repo relative, unclaimed service, ambiguous owners", () => {
    const FRONT = repoFromSources("front", undefined, {
      "api.ts": 'export const load = () => fetch("/users");',
    }, {});
    const BACK = repoFromSources("back", "back-service", {
      "UserController.java": [
        "@RestController",
        "public class UserController {",
        '    @GetMapping("/users")',
        "    public Object users() { return null; }",
        "}",
      ].join("\n"),
    }, {});
    const g = buildConnectionGraph([FRONT, BACK]);
    expect(g.byFile.get("front\0api.ts")!.calls[0]!.matchedPath).toBeUndefined();
    expect(g.byFile.get("back\0UserController.java")!.endpoints[0]!.callers).toEqual([]);

    // Named Feign target, repo claims no service name: no match even
    // on a single-repo floor.
    const SOLO = repoFromSources("solo", undefined, {
      "PaymentsClient.java": [
        '@FeignClient(name = "payments-service")',
        "public interface PaymentsClient {",
        '    @GetMapping("/pay")',
        "    Object pay();",
        "}",
      ].join("\n"),
      "PayController.java": [
        "@RestController",
        "public class PayController {",
        '    @GetMapping("/pay")',
        "    public Object pay() { return null; }",
        "}",
      ].join("\n"),
    }, {});
    const g2 = buildConnectionGraph([SOLO]);
    expect(g2.byFile.get("solo\0PaymentsClient.java")!.calls[0]!.matchedPath).toBeUndefined();

    // Two files claim the same key: ambiguous, so unmatched.
    const DUO = repoFromSources("duo", "duo-service", {
      "AController.java": [
        "@RestController",
        "public class AController {",
        '    @GetMapping("/dup")',
        "    public Object a() { return null; }",
        "}",
      ].join("\n"),
      "BController.java": [
        "@RestController",
        "public class BController {",
        '    @GetMapping("/dup")',
        "    public Object b() { return null; }",
        "}",
      ].join("\n"),
      "Caller.java": [
        "public class Caller {",
        '    public Object go() { return restTemplate.getForObject("/dup", String.class); }',
        "}",
      ].join("\n"),
    }, {});
    const g3 = buildConnectionGraph([DUO]);
    expect(g3.byFile.get("duo\0Caller.java")!.calls[0]!.matchedPath).toBeUndefined();
    expect(g3.byFile.get("duo\0AController.java")!.endpoints[0]!.callers).toEqual([]);
  });

  // Value: protects=an explicit external import (vendor.Service)
  // never being overridden by a local same-named type, and a
  // monorepo with several app names claiming none; fails_when=
  // simple-name uniqueness substitutes for binding;
  // why_new=Codex outside review P1/P2.
  test("external import bindings beat local same-named types; multi-app repos claim no service name", () => {
    const R = repoFromSources("r", "r-service", {
      "Ctrl.java": [
        "import vendor.Service;",
        "@RestController",
        "public class Ctrl {",
        "    private final Service service;",
        '    @GetMapping("/x")',
        "    public Object x() { return service.work(); }",
        "}",
      ].join("\n"),
      "Service.java": [
        "@Service",
        "public class Service {",
        "    private final Repo repo;",
        "    public Object work() { return repo.findAll(); }",
        "}",
      ].join("\n"),
      "Repo.java": "public interface Repo extends JpaRepository<Thing, Long> {}",
      "Thing.java": [
        "@Entity",
        '@Table(name = "internal_only")',
        "public class Thing {}",
      ].join("\n"),
    }, {}, { "Ctrl.java": ["vendor.Service"] });
    const g = buildConnectionGraph([R]);
    expect(g.byFile.get("r\0Ctrl.java")!.endpoints[0]!.tables).toEqual([]);

    const configs: Record<string, string> = {
      "billing/application.yml": "spring:\n  application:\n    name: billing-service\n",
      "shipping/application.yml": "spring:\n  application:\n    name: shipping-service\n",
    };
    expect(detectServiceName(Object.keys(configs), (p) => configs[p])).toBeUndefined();
    expect(detectServiceName(["billing/application.yml"], (p) => configs[p])).toBe("billing-service");
  });

  // Value: protects=access widening when one endpoint reaches the
  // same table through a read and a write (the inspector must say
  // readwrite, not whichever hop ran first); fails_when=merge order
  // decides the label; why_new=mergeAccess had no fixture firing it.
  test("read and write hops to the same table merge into readwrite", () => {
    const R = repoFromSources("r", "r-service", {
      "OrderController.java": [
        "@RestController",
        "public class OrderController {",
        "    private final OrderService service;",
        '    @PostMapping("/orders/touch")',
        "    public Object touch(Long id) { return service.touch(id); }",
        "}",
      ].join("\n"),
      "OrderService.java": [
        "@Service",
        "public class OrderService {",
        "    private final OrderRepository repo;",
        "    public Object touch(Long id) {",
        "        Object o = repo.findById(id);",
        "        return repo.save(o);",
        "    }",
        "}",
      ].join("\n"),
      "OrderRepository.java": "public interface OrderRepository extends JpaRepository<Order, Long> {}",
      "Order.java": [
        "@Entity",
        '@Table(name = "orders")',
        "public class Order {}",
      ].join("\n"),
    }, {});
    const g = buildConnectionGraph([R]);
    const tables = g.byFile.get("r\0OrderController.java")!.endpoints[0]!.tables;
    expect(tables).toEqual([
      { table: "orders", access: "readwrite", via: "repository", through: "OrderRepository", derived: "explicit" },
    ]);
  });

  // Value: protects=ambiguous implementations resolve only via a
  // proven import (two impls, one imported → that one; none
  // imported → no guess); fails_when=first-declared wins silently;
  // why_new=the multi-candidate filter arms never fired in fixtures.
  test("two implementations resolve by import, and stay unresolved without one", () => {
    const sources = {
      "Ctrl.java": [
        "@RestController",
        "public class Ctrl {",
        "    private final Port port;",
        '    @GetMapping("/y")',
        "    public Object y() { return port.work(); }",
        "}",
      ].join("\n"),
      "Port.java": "public interface Port { Object work(); }",
      "ImplA.java": [
        "@Service",
        "public class ImplA implements Port {",
        "    private final RepoA repo;",
        "    public Object work() { return repo.findAll(); }",
        "}",
      ].join("\n"),
      "ImplB.java": [
        "@Service",
        "public class ImplB implements Port {",
        "    private final RepoB repo;",
        "    public Object work() { return repo.findAll(); }",
        "}",
      ].join("\n"),
      "RepoA.java": "public interface RepoA extends JpaRepository<ThingA, Long> {}",
      "RepoB.java": "public interface RepoB extends JpaRepository<ThingB, Long> {}",
      "ThingA.java": ["@Entity", '@Table(name = "a_table")', "public class ThingA {}"].join("\n"),
      "ThingB.java": ["@Entity", '@Table(name = "b_table")', "public class ThingB {}"].join("\n"),
    };
    const withImport = repoFromSources("r", "r-service", sources, { "Ctrl.java": ["ImplB.java"] });
    const g1 = buildConnectionGraph([withImport]);
    expect(g1.byFile.get("r\0Ctrl.java")!.endpoints[0]!.tables.map((t) => t.table)).toEqual(["b_table"]);
    const noImport = repoFromSources("r", "r-service", sources, {});
    const g2 = buildConnectionGraph([noImport]);
    expect(g2.byFile.get("r\0Ctrl.java")!.endpoints[0]!.tables).toEqual([]);
  });
});

describe("declared-table join", () => {
  // Value: protects=AC1 (migration + entity + controller: the
  // endpoint closure names the migration path:line) and the
  // declared/undeclared totals; fails_when=the index or the
  // attachment drops; why_new=contracts slice T4.
  test("endpoint closures carry declaration sites; totals count declared and undeclared", () => {
    const R = repoFromSources("shop", "shop-service", {
      "migrations/001.sql": ["CREATE TABLE users (", "  id INT", ");"].join("\n"),
      "User.java": ["@Entity", '@Table(name = "users")', "public class User {}"].join("\n"),
      "UserRepository.java": "public interface UserRepository extends JpaRepository<User, Long> {}",
      "UserService.java": [
        "@Service",
        "public class UserService {",
        "    private final UserRepository repo;",
        "    public Object byId(Long id) { return repo.findById(id); }",
        "}",
      ].join("\n"),
      "UserController.java": [
        "@RestController",
        "public class UserController {",
        "    private final UserService service;",
        '    @GetMapping("/users/{id}")',
        "    public Object byId(Long id) { return service.byId(id); }",
        "}",
      ].join("\n"),
    }, {});
    const g = buildConnectionGraph([R]);
    const ctrl = g.byFile.get("shop\0UserController.java")!;
    expect(ctrl.endpoints[0]!.tables).toEqual([
      { table: "users", access: "read", via: "repository", derived: "explicit", through: "UserRepository", declaredBy: [{ repo: "shop", path: "migrations/001.sql", line: 1 }] },
    ]);
    expect(ctrl.tables).toEqual([
      { table: "users", access: "readwrite", via: "repository", derived: "explicit", through: "UserRepository", declaredBy: [{ repo: "shop", path: "migrations/001.sql", line: 1 }] },
    ]);
    // The migration itself declares without referencing: no self-listed uses.
    expect(g.byFile.get("shop\0migrations/001.sql")!.tables).toEqual([]);
    expect(g.byFile.get("shop\0migrations/001.sql")!.kinds).toEqual(["sql"]);
    expect(g.totals.declaredTables).toBe(1);
    expect(g.totals.undeclaredTables).toBe(0);
  });

  // Value: protects=AC4 (every declarer lists, none preferred;
  // schema-qualified refs need schema-qualified decls) and temp
  // declarations counting; fails_when=matching guesses;
  // why_new=contracts slice T4.
  test("multiple declarers all list; schema-qualified refs need schema-qualified decls", () => {
    const R = repoFromSources("shop", undefined, {
      "migrations/001.sql": "CREATE TABLE users (id INT);",
      "migrations/002.sql": "CREATE TABLE users (id INT, extra INT);",
      "migrations/003.sql": "CREATE TABLE app.users (id INT);",
      "migrations/004.sql": "CREATE TEMPORARY TABLE sessions (id INT);",
      "User.java": ["@Entity", '@Table(name = "users")', "public class User {}"].join("\n"),
      "AppUser.java": ["@Entity", '@Table(name = "users", schema = "app")', "public class AppUser {}"].join("\n"),
      "Session.java": ["@Entity", '@Table(name = "sessions")', "public class Session {}"].join("\n"),
    }, {});
    const g = buildConnectionGraph([R]);
    // An unqualified reference matches declarations under any schema or none.
    expect(g.byFile.get("shop\0User.java")!.tables).toEqual([
      {
        table: "users", access: "unknown", via: "entity", derived: "explicit", through: "User",
        declaredBy: [
          { repo: "shop", path: "migrations/001.sql", line: 1 },
          { repo: "shop", path: "migrations/002.sql", line: 1 },
          { repo: "shop", path: "migrations/003.sql", line: 1, schema: "app" },
        ],
      },
    ]);
    // A schema-qualified reference matches only the same dotted name.
    expect(g.byFile.get("shop\0AppUser.java")!.tables).toEqual([
      {
        table: "app.users", access: "unknown", via: "entity", derived: "explicit", through: "AppUser",
        declaredBy: [{ repo: "shop", path: "migrations/003.sql", line: 1, schema: "app" }],
      },
    ]);
    expect(g.byFile.get("shop\0Session.java")!.tables[0]!.declaredBy).toEqual([
      { repo: "shop", path: "migrations/004.sql", line: 1, temporary: true },
    ]);
    expect(g.totals.declaredTables).toBe(3);
    expect(g.totals.undeclaredTables).toBe(0);
  });

  // Value: protects=the anti-guess rule (unqualified declarations
  // never prove schema-qualified references) with an explicit
  // undeclared case; fails_when=matching over-merges;
  // why_new=contracts slice AC4/T4.
  test("schema-qualified references stay undeclared without a schema-qualified declaration", () => {
    const R = repoFromSources("shop", undefined, {
      "migrations/001.sql": "CREATE TABLE users (id INT);",
      "AppUser.java": ["@Entity", '@Table(name = "users", schema = "app")', "public class AppUser {}"].join("\n"),
    }, {});
    const g = buildConnectionGraph([R]);
    const tables = g.byFile.get("shop\0AppUser.java")!.tables;
    expect(tables).toEqual([
      { table: "app.users", access: "unknown", via: "entity", derived: "explicit", through: "AppUser" },
    ]);
    expect(tables[0]!.declaredBy).toBeUndefined();
    expect(g.totals.declaredTables).toBe(1);
    expect(g.totals.undeclaredTables).toBe(1);
  });

  // Value: protects=the 100-declarer cap; fails_when=unbounded
  // declarer lists bloat the wire; why_new=contracts T4.
  test("declarer lists cap at 100 per table", () => {
    const sources: Record<string, string> = {
      "User.java": ["@Entity", '@Table(name = "users")', "public class User {}"].join("\n"),
    };
    for (let i = 0; i < 101; i++) sources[`migrations/${String(i).padStart(3, "0")}.sql`] = "CREATE TABLE users (id INT);";
    const g = buildConnectionGraph([repoFromSources("shop", undefined, sources, {})]);
    const declaredBy = g.byFile.get("shop\0User.java")!.tables[0]!.declaredBy!;
    expect(declaredBy.length).toBe(100);
    expect(declaredBy[0]).toEqual({ repo: "shop", path: "migrations/000.sql", line: 1 });
    expect(g.totals.declaredTables).toBe(1);
  });

  // Value: protects=cross-repo declaration joins with declaredBy
  // surviving the fixpoint rounds; fails_when=declaration facts
  // turn round-dependent; why_new=contracts slice T4/FR13.
  test("declarations join across repos; fixpoint rounds preserve declaredBy", () => {
    const A = repoFromSources("shop", "shop-service", {
      "OrderController.java": [
        "@RestController",
        "public class OrderController {",
        "    private final OrderService service;",
        '    @GetMapping("/orders/{id}")',
        "    public Object byId(Long id) { return service.byId(id); }",
        "}",
      ].join("\n"),
      "OrderService.java": [
        "@Service",
        "public class OrderService {",
        "    private final OrderRepository repo;",
        "    private final WidgetClient widgets;",
        "    public Object byId(Long id) {",
        "        widgets.getWidget(id);",
        "        return repo.findById(id);",
        "    }",
        "}",
      ].join("\n"),
      "OrderRepository.java": "public interface OrderRepository extends JpaRepository<Order, Long> {}",
      "Order.java": ["@Entity", '@Table(name = "orders")', "public class Order {}"].join("\n"),
      "WidgetClient.java": [
        '@FeignClient(name = "widget-service", path = "/api/widgets")',
        "public interface WidgetClient {",
        '    @GetMapping("/{id}")',
        "    String getWidget(Long id);",
        "}",
      ].join("\n"),
    }, {});
    const B = repoFromSources("widgets", "widget-service", {
      "migrations/001.sql": ["CREATE TABLE widgets (", "  id INT", ");"].join("\n"),
      "WidgetController.java": [
        "@RestController",
        "public class WidgetController {",
        "    private final WidgetService service;",
        '    @GetMapping("/api/widgets/{id}")',
        "    public Object byId(Long id) { return service.byId(id); }",
        "}",
      ].join("\n"),
      "WidgetService.java": [
        "@Service",
        "public class WidgetService {",
        "    private final WidgetRepository repo;",
        "    public Object byId(Long id) { return repo.findById(id); }",
        "}",
      ].join("\n"),
      "WidgetRepository.java": "public interface WidgetRepository extends JpaRepository<Widget, Long> {}",
      "Widget.java": ["@Entity", '@Table(name = "widgets")', "public class Widget {}"].join("\n"),
    }, {});
    const g = buildConnectionGraph([A, B]);
    const ep = g.byFile.get("shop\0OrderController.java")!.endpoints[0]!;
    expect(ep.tables).toEqual([
      { table: "orders", access: "read", via: "repository", derived: "explicit", through: "OrderRepository" },
      {
        table: "widgets", access: "read", via: "repository", derived: "explicit", through: "widgets:WidgetRepository",
        declaredBy: [{ repo: "widgets", path: "migrations/001.sql", line: 1 }],
      },
    ]);
    expect(g.totals.declaredTables).toBe(1);
    expect(g.totals.undeclaredTables).toBe(1);
  });
});
