/**
 * Connection graph over per-file extracted facts (pure, no I/O).
 *
 * Answers the questions the floor renders:
 * - per file: its endpoints, calls, topics, and the tables it can
 *   reach transitively through injected collaborators;
 * - per endpoint handler (a function): the tables reachable from
 *   that method through field-receiver calls (Controller method ->
 *   Service method -> ... -> Repository method -> entity/native SQL);
 * - per endpoint key: which calls (in any indexed repo) hit it, and
 *   per topic: who produces/consumes it — the cross-repo join.
 *
 * Type resolution for injected fields and repository entities is
 * by declaring-file index: the importer's resolved import targets
 * disambiguate same-named types; an ambiguous or missing type
 * stays unresolved (counted, never guessed).
 */
import type { FileConnections, TableUse } from "./types.ts";
import { canonicalService, endpointKey } from "./types.ts";

export type TableRef = {
  table: string;
  access: TableUse["access"];
  via: TableUse["via"] | "transitive";
  derived: TableUse["derived"];
  /** First hop that reaches the table: "ClassName.method" or the file's own class. */
  through: string;
};

export type EndpointSummary = {
  method: string;
  path: string;
  handler: string;
  line: number;
  tables: TableRef[];
  /** Incoming calls matched by endpoint key: "RepoLabel:ClassName.method (via)"-free — file paths. */
  callers: { path: string; caller: string; via: string; line: number }[];
};

export type BuildingConnections = {
  repo: string; // repo label ("" in single-repo mode)
  service?: string; // spring.application.name-style service name for this repo, as written
  kinds: string[];
  className?: string;
  endpoints: EndpointSummary[];
  tables: TableRef[];
  calls: { method: string; path: string; targetService?: string; via: string; caller: string; line: number; matchedPath?: string; dynamicBase?: boolean; absoluteUrl?: boolean }[];
  topics: { topic: string; direction: string; handler: string; line: number; peers: string[] }[];
  unresolvedNotes: number;
};

export type RepoInput = {
  label: string;
  serviceName?: string;
  files: Map<string, FileConnections>;
  /** Declared type simple name -> declaring files (all languages with declarations). */
  typeIndex: Map<string, string[]>;
  /** Resolved import targets per path (disambiguates same-named types). */
  importTargets: Map<string, Set<string>>;
  /** Raw import specifiers per path: an explicit external binding beats a local same-named type. */
  importSpecifiers?: Map<string, string[]>;
};

const MAX_DEPTH = 14;

function mergeAccess(a: TableUse["access"], b: TableUse["access"]): TableUse["access"] {
  if (a === b) return a;
  if (a === "readwrite" || b === "readwrite") return "readwrite";
  if ((a === "read" && b === "write") || (a === "write" && b === "read")) return "readwrite";
  return a === "unknown" ? b : a;
}

class TableSet {
  private byTable = new Map<string, TableRef>();
  add(t: TableRef) {
    const prev = this.byTable.get(t.table);
    if (!prev) { this.byTable.set(t.table, { ...t }); return; }
    prev.access = mergeAccess(prev.access, t.access);
    if (prev.derived === "implicit-name" && t.derived === "explicit") {
      prev.derived = "explicit";
      prev.via = t.via;
      prev.through = t.through;
    }
  }
  addAll(ts: Iterable<TableRef>) { for (const t of ts) this.add(t); }
  list(): TableRef[] { return [...this.byTable.values()].sort((a, b) => (a.table < b.table ? -1 : 1)); }
}

/** Interface simple name -> files declaring it as a supertype. */
function buildImplIndex(repo: RepoInput): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const [path, fc] of repo.files) {
    if (fc.isInterface) continue; // a sub-interface is not an implementation
    for (const s of fc.supertypes) {
      const list = index.get(s) ?? [];
      list.push(path);
      index.set(s, list);
    }
  }
  return index;
}

/**
 * The unique implementation of an interface type, disambiguated by
 * the importer's resolved imports when several exist. Ambiguous
 * stays undefined (never guessed).
 */
function resolveImpl(repo: RepoInput, impls: Map<string, string[]>, fromPath: string, interfaceName: string): string | undefined {
  let candidates = impls.get(interfaceName) ?? [];
  // Production code never runs test doubles: a lone test fake must
  // not become "the" implementation, nor make a real one ambiguous.
  const production = candidates.filter((c) => !/(^|\/)(test|tests)\//.test(c) && !/Test\.(java|kt)$/.test(c));
  if (production.length > 0) candidates = production;
  if (candidates.length === 1) return candidates[0];
  if (candidates.length === 0) return undefined;
  const imports = repo.importTargets.get(fromPath);
  const imported = candidates.filter((c) => imports?.has(c));
  return imported.length === 1 ? imported[0] : undefined;
}

/**
 * Resolve an injected/referenced type to the file whose code runs:
 * the declaring file, redirected through a unique implementation
 * when the declaration is an interface (hexagonal ports, service
 * interfaces). Repository interfaces keep their own file — Spring
 * Data generates their implementation, and the entity binding
 * lives on the interface.
 */
function resolveRuntimeType(repo: RepoInput, impls: Map<string, string[]>, fromPath: string, simpleName: string): string | undefined {
  const declared = resolveType(repo, fromPath, simpleName);
  if (!declared) return undefined;
  const fc = repo.files.get(declared);
  if (fc?.isInterface && fc.repoEntities.length === 0) {
    return resolveImpl(repo, impls, fromPath, simpleName) ?? declared;
  }
  return declared;
}

/** Resolve a simple type name as used in `fromPath` to exactly one declaring file, or undefined. */
function resolveType(repo: RepoInput, fromPath: string, simpleName: string): string | undefined {
  const candidates = repo.typeIndex.get(simpleName);
  if (!candidates || candidates.length === 0) return undefined;
  const imports = repo.importTargets.get(fromPath);
  // An explicit import binding for this simple name is decisive:
  // when it resolved to one of the candidates use it; when it
  // resolved nowhere local it names an external type, and a local
  // same-named type must never silently take its place.
  const specifiers = repo.importSpecifiers?.get(fromPath) ?? [];
  const bound = specifiers.some((s) => {
    const clean = s.replace(/^static\s+/, "");
    return clean === simpleName || clean.endsWith(`.${simpleName}`);
  });
  if (bound) {
    const imported = candidates.filter((c) => imports?.has(c));
    return imported.length === 1 ? imported[0] : undefined;
  }
  if (candidates.length === 1) return candidates[0];
  const imported = candidates.filter((c) => imports?.has(c));
  return imported.length === 1 ? imported[0] : undefined;
}

/** Access a Spring Data repository method name proves (derived-query semantics). */
function repoMethodAccess(methodName: string): TableRef["access"] {
  if (/^(find|get|read|query|search|exists|count|stream|fetch|load)/.test(methodName)) return "read";
  if (/^(save|delete|remove|update|insert|persist|merge|create)/.test(methodName)) return "write";
  return "unknown";
}

/** Tables a repository/entity file itself proves (entity bindings expanded in-repo). */
function directTables(repo: RepoInput, path: string, fc: FileConnections): TableRef[] {
  const set = new TableSet();
  const self = fc.className ?? path;
  for (const t of fc.tables) set.add({ table: t.table, access: t.access, via: t.via, derived: t.derived, through: self });
  for (const entity of fc.repoEntities) {
    const entityPath = resolveType(repo, path, entity);
    const entityFc = entityPath ? repo.files.get(entityPath) : undefined;
    if (entityFc?.entityTable) {
      set.add({
        table: entityFc.entityTable.table, access: "readwrite", via: "repository",
        derived: entityFc.entityTable.derived, through: self,
      });
    }
  }
  return set.list();
}

/** Cross-repo tables keyed `${repo}\0${clientPath}\0${clientMethod}` from matched calls. */
type CrossTables = Map<string, TableRef[]>;

/** Tables reached from one method through injected receivers, transitively. */
function methodTables(
  repo: RepoInput,
  impls: Map<string, string[]>,
  cross: CrossTables,
  path: string,
  methodName: string,
  seen: Set<string>,
  depth: number,
  cache: Map<string, TableRef[]> = new Map(),
): TableRef[] {
  const key = `${path}\0${methodName}`;
  // Root (handler) results are complete closures; reuse across the
  // duplicate expanded endpoints that share one handler.
  if (depth === 0) {
    const cached = cache.get(key);
    if (cached) return cached;
  }
  if (seen.has(key) || depth > MAX_DEPTH) return [];
  seen.add(key);
  const fc = repo.files.get(path);
  if (!fc) return [];
  const set = new TableSet();
  const self = fc.className ?? path;
  // Repository call: only the bound entities' tables, with the
  // access the called method's name proves under Spring Data
  // derived-query semantics. The repository file's OTHER methods'
  // native SQL belongs to those methods, never to this call.
  for (const entity of fc.repoEntities) {
    const entityPath = resolveType(repo, path, entity);
    const entityFc = entityPath ? repo.files.get(entityPath) : undefined;
    if (entityFc?.entityTable) {
      set.add({ table: entityFc.entityTable.table, access: repoMethodAccess(methodName), via: "repository", derived: entityFc.entityTable.derived, through: self });
    }
  }
  if (fc.entityName && fc.entityTable) {
    set.add({ table: fc.entityTable.table, access: fc.entityTable.access, via: fc.entityTable.via, derived: fc.entityTable.derived, through: self });
  }
  const method = fc.methods.find((m) => m.name === methodName);
  if (!method) {
    const out = set.list();
    if (depth === 0) cache.set(key, out);
    return out;
  }
  for (const t of method.tables) set.add({ table: t.table, access: t.access, via: t.via, derived: t.derived, through: `${self}.${methodName}` });
  for (const entity of method.jpqlEntities) {
    const entityPath = resolveType(repo, path, entity);
    const entityFc = entityPath ? repo.files.get(entityPath) : undefined;
    if (entityFc?.entityTable) {
      set.add({ table: entityFc.entityTable.table, access: "read", via: "jpql", derived: entityFc.entityTable.derived, through: `${self}.${methodName}` });
    }
  }
  const fieldTypes = new Map(fc.injections.map((i) => [i.field, i.type]));
  for (const call of method.calls) {
    if (call.receiver === "this") {
      set.addAll(methodTables(repo, impls, cross, path, call.method, seen, depth + 1, cache));
      continue;
    }
    const type = fieldTypes.get(call.receiver);
    if (!type) continue;
    const target = resolveRuntimeType(repo, impls, path, type);
    if (!target) continue;
    // A call into an HTTP client (Feign/WebClient contract file)
    // continues in the matched endpoint's repo: add its tables.
    const crossHit = cross.get(`${repo.label}\0${target}\0${call.method}`);
    if (crossHit) set.addAll(crossHit);
    set.addAll(methodTables(repo, impls, cross, target, call.method, seen, depth + 1, cache));
  }
  const out = set.list();
  if (depth === 0) cache.set(key, out);
  return out;
}

/**
 * Tables reachable from a whole file: direct + through every
 * injection, file-level DFS. Reachability closure from a node is
 * entry-independent, so completed closures memoize across roots
 * within one graph build (the `through` label keeps the first
 * computation's hop wording).
 */
function fileTables(repo: RepoInput, impls: Map<string, string[]>, cross: CrossTables, path: string, seen: Set<string>, depth: number, cache: Map<string, TableRef[]>): TableRef[] {
  if (depth > MAX_DEPTH) return [];
  const cached = cache.get(path);
  if (cached) return cached;
  if (seen.has(path)) return [];
  seen.add(path);
  const fc = repo.files.get(path);
  if (!fc) return [];
  const set = new TableSet();
  set.addAll(directTables(repo, path, fc));
  // An HTTP contract file reaches the matched endpoints' tables.
  for (const call of fc.calls) {
    const hit = cross.get(`${repo.label}\0${path}\0${call.caller}`);
    if (hit) set.addAll(hit);
  }
  for (const inj of fc.injections) {
    const target = resolveRuntimeType(repo, impls, path, inj.type);
    if (!target) continue;
    set.addAll(fileTables(repo, impls, cross, target, seen, depth + 1, cache));
  }
  const out = set.list();
  // Only a root call (fresh seen set) computed the full closure;
  // a nested call ran with ancestors already seen and may legitimately miss cycle back-edges.
  if (depth === 0) cache.set(path, out);
  return out;
}

/**
 * Spring service name from config files (bootstrap/application
 * yml|yaml|properties), generic to any Spring repo. Placeholders
 * with defaults resolve to the default; unresolvable values are
 * skipped rather than guessed.
 */
export function detectServiceName(files: Iterable<string>, readFile: (path: string) => string | undefined): string | undefined {
  const candidates = [...files]
    .filter((p) => /(?:^|\/)(?:bootstrap|application)(?:-[\w.-]+)?\.(yml|yaml|properties)$/.test(p))
    .sort();
  const names = new Set<string>();
  for (const path of candidates) {
    const text = readFile(path);
    if (!text) continue;
    let raw: string | undefined;
    if (path.endsWith(".properties")) {
      raw = /^spring\.application\.name\s*=\s*(\S+)/m.exec(text)?.[1];
    } else {
      // Only spring.application.name counts. A bare top-level
      // `name:` is something else entirely (kept out on purpose).
      raw = /application:\s*\n\s+name:\s*([^\s#]+)/.exec(text)?.[1];
    }
    if (!raw) continue;
    const placeholder = /^\$\{[\w.]+:([^}]+)\}$/.exec(raw);
    if (placeholder) raw = placeholder[1];
    else if (raw.startsWith("${")) continue;
    names.add(raw.replace(/['"]/g, ""));
  }
  // A monorepo naming several distinct applications has no single
  // repo-level service name; claim none rather than the first.
  return names.size === 1 ? [...names][0] : undefined;
}

export type GraphResult = {
  /** repoLabel\0path -> summary */
  byFile: Map<string, BuildingConnections>;
  /**
   * repoLabel\0path -> direct-only tables: the file's own facts
   * (directTables) before transitive merging. The summary `tables`
   * merge access across direct and transitive reachability, so a
   * merged row cannot discriminate them — consumers that need
   * direct use (the trace export) read this map instead.
   */
  directByFile: Map<string, TableRef[]>;
  totals: {
    endpoints: number; calls: number; matchedCalls: number; unmatchedCalls: number;
    tables: number; topics: number; crossRepoLinks: number;
  };
};

export function buildConnectionGraph(repos: RepoInput[]): GraphResult {
  // Global endpoint index: key -> owners (repo,path) ; service index for Feign filtering.
  type Owner = { repo: string; path: string };
  const endpointOwners = new Map<string, Owner[]>();
  for (const repo of repos) {
    for (const [path, fc] of repo.files) {
      for (const ep of fc.endpoints) {
        const key = endpointKey(ep.method, ep.path);
        const list = endpointOwners.get(key) ?? [];
        list.push({ repo: repo.label, path });
        endpointOwners.set(key, list);
      }
    }
  }
  const repoByLabel = new Map(repos.map((r) => [r.label, r]));
  // Topic index: topic -> participants with direction (peers are
  // only ever the opposite side: producers see consumers).
  const topicPeers = new Map<string, { id: string; direction: string }[]>();
  for (const repo of repos) {
    for (const [path, fc] of repo.files) {
      for (const t of fc.topics) {
        const list = topicPeers.get(t.topic) ?? [];
        list.push({ id: `${repo.label ? `${repo.label}:` : ""}${path}`, direction: t.direction });
        topicPeers.set(t.topic, list);
      }
    }
  }

  const byFile = new Map<string, BuildingConnections>();
  const incoming = new Map<string, { path: string; caller: string; via: string; line: number }[]>();
  let matchedCalls = 0;
  let unmatchedCalls = 0;
  let crossRepoLinks = 0;

  // First pass: calls + incoming attribution (needs every repo's endpoints indexed).
  const callSummaries = new Map<string, BuildingConnections["calls"]>();
  for (const repo of repos) {
    for (const [path, fc] of repo.files) {
      const summaries: BuildingConnections["calls"] = [];
      for (const call of fc.calls) {
        const key = endpointKey(call.method === "ANY" ? "ANY" : call.method, call.path);
        // A dynamic-base URL (`base + "/x"`) names no proven host:
        // path alone must not join it to an indexed endpoint.
        let owners = call.dynamicBase || call.absoluteUrl ? [] : endpointOwners.get(key) ?? [];
        if (owners.length === 0 && call.method !== "ANY" && !call.dynamicBase && !call.absoluteUrl) owners = endpointOwners.get(endpointKey("ANY", call.path)) ?? [];
        if (call.targetService) {
          // A named target only matches repos that claim that
          // service name. "Cannot be disproven" is a guess even on
          // a single-repo floor: the client may name a service that
          // simply is not this repo.
          const target = canonicalService(call.targetService);
          owners = owners.filter((o) => {
            const ownerService = repoByLabel.get(o.repo)?.serviceName;
            return ownerService !== undefined && canonicalService(ownerService) === target;
          });
        } else {
          // No proven service: a relative call can only be claimed
          // by its own repo. Joining another repo's same-path
          // endpoint is exactly the guess this graph must not make.
          owners = owners.filter((o) => o.repo === repo.label);
        }
        // One proven owner file, or none: several distinct files
        // claiming the key make the destination ambiguous, and an
        // ambiguous destination is not a match (for this call, nor
        // as incoming attribution on any of them).
        const distinct = [...new Map(owners.map((o) => [`${o.repo}\0${o.path}`, o])).values()];
        owners = distinct.length === 1 ? distinct : [];
        const matchedPath = owners.length === 1 ? `${owners[0]!.repo ? `${owners[0]!.repo}:` : ""}${owners[0]!.path}` : undefined;
        if (matchedPath) matchedCalls++;
        else unmatchedCalls++;
        for (const owner of owners) {
          const ownerKey = `${owner.repo}\0${owner.path}\0${key}`;
          const list = incoming.get(ownerKey) ?? [];
          list.push({ path: `${repo.label ? `${repo.label}:` : ""}${path}`, caller: call.caller, via: call.via, line: call.line });
          incoming.set(ownerKey, list);
          if (owner.repo !== repo.label) crossRepoLinks++;
        }
        summaries.push({
          method: call.method, path: call.path, targetService: call.targetService,
          via: call.via, caller: call.caller, line: call.line, matchedPath,
          dynamicBase: call.dynamicBase || undefined,
          absoluteUrl: call.absoluteUrl || undefined,
        });
      }
      callSummaries.set(`${repo.label}\0${path}`, summaries);
    }
  }

  let totalEndpoints = 0;
  let totalCalls = 0;
  for (const repo of repos) for (const fc of repo.files.values()) { totalEndpoints += fc.endpoints.length; totalCalls += fc.calls.length; }
  const allTables = new Set<string>();

  // Direct-only tables per file: original facts before transitive
  // merging. Independent of the cross-repo fixpoint below, so it is
  // computed once, not per round.
  const directByFile = new Map<string, TableRef[]>();
  for (const repo of repos) {
    for (const [path, fc] of repo.files) {
      directByFile.set(`${repo.label}\0${path}`, directTables(repo, path, fc));
    }
  }

  // Fixpoint over matched calls: round 0 is intra-repo only; each
  // round lets one more repo hop contribute its endpoint tables to
  // callers (sender endpoint -> feign -> core endpoint -> tables).
  let cross: CrossTables = new Map();
  const computeSummaries = (): Map<string, BuildingConnections> => {
    const out = new Map<string, BuildingConnections>();
    for (const repo of repos) {
      const impls = buildImplIndex(repo);
      const fileTableCache = new Map<string, TableRef[]>();
      const methodTableCache = new Map<string, TableRef[]>();
      for (const [path, fc] of repo.files) {
        const tables = fileTables(repo, impls, cross, path, new Set(), 0, fileTableCache);
        const endpoints: EndpointSummary[] = fc.endpoints.map((ep) => ({
          method: ep.method,
          path: ep.path,
          handler: ep.handler,
          line: ep.line,
          tables: methodTables(repo, impls, cross, path, ep.handler, new Set(), 0, methodTableCache),
          callers: incoming.get(`${repo.label}\0${path}\0${endpointKey(ep.method, ep.path)}`) ?? [],
        }));
        out.set(`${repo.label}\0${path}`, {
          repo: repo.label,
          service: repo.serviceName,
          kinds: fc.kinds,
          className: fc.className,
          endpoints,
          tables,
          calls: callSummaries.get(`${repo.label}\0${path}`) ?? [],
          topics: fc.topics.map((t) => ({
            ...t,
            peers: [...new Set((topicPeers.get(t.topic) ?? [])
              .filter((p) => p.direction !== t.direction && p.id !== `${repo.label ? `${repo.label}:` : ""}${path}`)
              .map((p) => p.id))].slice(0, 100),
          })),
          unresolvedNotes: fc.notes.length,
        });
      }
    }
    return out;
  };
  for (let round = 0; round < 4; round++) {
    const summaries = computeSummaries();
    byFile.clear();
    for (const [k, v] of summaries) byFile.set(k, v);
    const next: CrossTables = new Map();
    for (const repo of repos) {
      for (const [path] of repo.files) {
        const own = callSummaries.get(`${repo.label}\0${path}`) ?? [];
        for (const call of own) {
          if (!call.matchedPath || !call.caller) continue;
          const sep = call.matchedPath.indexOf(":");
          const ownerRepo = sep === -1 ? "" : call.matchedPath.slice(0, sep);
          const ownerPath = sep === -1 ? call.matchedPath : call.matchedPath.slice(sep + 1);
          const ownerSummary = summaries.get(`${ownerRepo}\0${ownerPath}`);
          const ep = ownerSummary?.endpoints.find((e) => endpointKey(e.method, e.path) === endpointKey(call.method, call.path))
            ?? ownerSummary?.endpoints.find((e) => endpointKey("ANY", e.path) === endpointKey("ANY", call.path));
          if (!ep || ep.tables.length === 0) continue;
          const key = `${repo.label}\0${path}\0${call.caller}`;
          const set = new TableSet();
          set.addAll(next.get(key) ?? []);
          for (const t of ep.tables) set.add(ownerRepo && ownerRepo !== repo.label ? { ...t, through: `${ownerRepo}:${t.through}` } : t);
          next.set(key, set.list());
        }
      }
    }
    if (JSON.stringify([...next]) === JSON.stringify([...cross])) break;
    cross = next;
  }
  for (const summary of byFile.values()) for (const t of summary.tables) allTables.add(t.table);
  return {
    byFile,
    directByFile,
    totals: {
      endpoints: totalEndpoints,
      calls: totalCalls,
      matchedCalls,
      unmatchedCalls,
      tables: allTables.size,
      topics: topicPeers.size,
      crossRepoLinks,
    },
  };
}
