/**
 * Estate floor builder (pure): frozen estate JSON -> buildings/belts/zones.
 *
 * Inputs are the frozen artifacts from the D mapping run:
 * `estate.json` (connections-report over all repos, cross-repo linked)
 * and `estate-boxes.json` (table clustering into capability boxes).
 * No I/O here: the server loads the files and calls buildEstateFloor.
 * Deterministic: same inputs, same floor (sorted everywhere, stable ids).
 */
import { layoutFloor, zoneRects, type Band, type ZoneRect } from "../floor-ui/layout.ts";
import type { BeltEdge, Building, BuildingConnections } from "../floor-ui/wire.ts";
import type { EndpointSummary, TableRef } from "../connections/graph.ts";

/** One byFile entry of estate.json (the graph's BuildingConnections). */
export type EstateFileEntry = BuildingConnections;

/** Minimal estate.json shape: only what the builder reads. */
export type EstateJson = {
  repos: { repo: string; serviceName?: string }[];
  byFile: Record<string, EstateFileEntry>;
};

export type BoxJson = {
  id: string;
  name: string;
  tables: string[];
  tableCount: number;
  endpointCount: number;
  fileCount: number;
  repos: string[];
  writes: string[];
  seeded: string[];
  endpoints: string[];
  files: string[];
  consumers: string[];
};

/** Minimal estate-boxes.json shape. */
export type BoxesJson = {
  boxes: BoxJson[];
  unboxed: string[];
};

/**
 * Frozen frontend calls (frontend-calls.json): one HttpClient call
 * site per record. `match` names the proven backend owner;
 * `intent` names the implied backend repo when nothing matched.
 */
export type FrontendCallJson = {
  method: string;
  path: string;
  file: string;
  line: number;
  app: string;
  match: { kind: "exact" | "literal-param" | "backend-literal"; repo: string; file: string } | null;
  intent: string | null;
};

export type FrontendJson = {
  repo: string;
  commit: string;
  calls: FrontendCallJson[];
};

/** `repo:path:METHOD /path` -> parts. Repos and file paths never hold `:`. */
export function parseBoxEndpointId(id: string): { repo: string; file: string; method: string; path: string } | undefined {
  const first = id.indexOf(":");
  const last = id.lastIndexOf(":");
  if (first <= 0 || last <= first) return undefined;
  const repo = id.slice(0, first);
  const file = id.slice(first + 1, last);
  const rest = id.slice(last + 1);
  const space = rest.indexOf(" ");
  if (space <= 0) return undefined;
  return { repo, file, method: rest.slice(0, space), path: rest.slice(space + 1) };
}

/**
 * `UM.tesoreria.sender-service` -> `t-sender` (the `-service` infix is
 * dropped, dotted suffixes kept: `compras-service.upstream` ->
 * `compras.upstream`). Unknown shapes pass through.
 */
export function shortRepo(repo: string): string {
  const m = /^UM\.(tesoreria|haberes)\.(.+)$/.exec(repo);
  if (!m) return repo;
  return `${m[1] === "tesoreria" ? "t" : "h"}-${m[2].replace("-service", "")}`;
}

/** Size band by traffic (endpoints for boxes, endpoints+calls for services). */
export function bandForTraffic(n: number): Band {
  if (n < 5) return 0;
  if (n < 20) return 1;
  if (n < 60) return 2;
  return 3;
}

/** Big boxes get the core zone; the rest sit on the shelf. */
export function isBigBox(box: BoxJson): boolean {
  return box.tableCount >= 2 || box.endpointCount >= 10;
}

/**
 * Gateway route table from the Spring Cloud Gateway bootstrap YAML:
 * route id, load-balanced service name, first Path= base. One block
 * per `- id:` entry; blocks without all three are skipped. Routes
 * forward the whole /** remainder to the service, so exposure is
 * service-level: every endpoint of a routed service faces frontends.
 */
export type GatewayRoute = { id: string; service: string; path: string };

export function parseGatewayRoutes(yml: string): GatewayRoute[] {
  const routes: GatewayRoute[] = [];
  for (const block of yml.split(/-\s*id\s*:/).slice(1)) {
    const id = block.split("\n")[0]!.trim();
    const service = block.match(/uri:\s*lb:\/\/([^\s"']+)/)?.[1] ?? "";
    const path = block.match(/Path=([^\s"']+)/)?.[1].replace(/\/\*+$/, "").replace(/\/$/, "") ?? "";
    if (id && service && path.startsWith("/")) routes.push({ id, service, path });
  }
  if (routes.length === 0) throw new Error("gateway bootstrap.yml has no routes with id, uri, and Path=");
  return routes;
}

/** Service slug: declared spring name when the estate has one, else derived from the repo name. */
export function repoSlug(repo: string, serviceName?: string): string {
  if (serviceName) return serviceName.toLowerCase();
  return repo.replace(/^UM\./i, "").replace(/\./g, "-").toLowerCase();
}

/**
 * True when the repo's service sits behind a gateway route. Exact match
 * on route id or service name, or a dash-boundary suffix in either
 * direction (tesoreria-pyafipws-service behind pyafipws-service).
 * Anything else stays internal rather than guessed.
 */
export function isExposed(repo: string, serviceName: string | undefined, routes: readonly GatewayRoute[]): boolean {
  const slug = repoSlug(repo, serviceName);
  return routes.some((r) =>
    [r.id.toLowerCase(), r.service.toLowerCase()].some(
      (cand) => cand === slug || slug.endsWith(`-${cand}`) || cand.endsWith(`-${slug}`),
    ),
  );
}

export type EstateStats = {
  boxes: number;
  unboxed: number;
  services: number;
  yards: number;
  belts: number;
  callBelts: number;
  couplingBelts: number;
  skippedSelf: number;
  skippedUnowned: number;
  unmatchedSkipped: number;
  unmappedFiles: number;
  missingEndpoints: number;
  frontendMachines: number;
  frontendCalls: number;
  frontendUnmatched: number;
};

export type EstateFloor = {
  buildings: Building[];
  belts: BeltEdge[];
  zones: ZoneRect[];
  stats: EstateStats;
};

type Access = TableRef["access"];

function mergeAccess(a: Access, b: Access): Access {
  if (a === b) return a;
  if (a === "readwrite" || b === "readwrite") return "readwrite";
  if ((a === "read" && b === "write") || (a === "write" && b === "read")) return "readwrite";
  return a === "unknown" ? b : a;
}

function aggregateTables(endpoints: EndpointSummary[]): TableRef[] {
  const byTable = new Map<string, TableRef>();
  for (const ep of endpoints) {
    for (const t of ep.tables) {
      const prev = byTable.get(t.table);
      if (!prev) byTable.set(t.table, { ...t });
      else prev.access = mergeAccess(prev.access, t.access);
    }
  }
  return [...byTable.values()].sort((a, b) => (a.table < b.table ? -1 : 1));
}

/**
 * A box's own tables (box.tables), with access merged across the box
 * endpoints that touch them. Tables the endpoints never cite keep an
 * honest unknown row instead of vanishing or borrowing access.
 */
function boxTables(box: BoxJson, endpoints: EndpointSummary[]): TableRef[] {
  const refs = new Map<string, TableRef[]>();
  for (const ep of endpoints) {
    for (const t of ep.tables) {
      const list = refs.get(t.table) ?? [];
      list.push(t);
      refs.set(t.table, list);
    }
  }
  return [...box.tables].sort().map((table) => {
    const cited = refs.get(table) ?? [];
    const first = cited[0];
    return {
      table,
      access: cited.reduce<Access>((a, t) => mergeAccess(a, t.access), "unknown"),
      via: first?.via ?? "repository",
      derived: first?.derived ?? "explicit",
      through: first?.through ?? `${box.id} membership (no endpoint cites it)`,
      ...(first?.declaredBy ? { declaredBy: first.declaredBy } : {}),
    };
  });
}

const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

export function buildEstateFloor(estate: EstateJson, boxesJson: BoxesJson, gatewayRoutes: readonly GatewayRoute[], frontend?: FrontendJson): EstateFloor {
  if (!estate || typeof estate.byFile !== "object") throw new Error("estate.json: missing byFile");
  if (!boxesJson || !Array.isArray(boxesJson.boxes)) throw new Error("estate-boxes.json: missing boxes");
  if (frontend !== undefined && (typeof frontend.repo !== "string" || !Array.isArray(frontend.calls))) {
    throw new Error("frontend-calls.json: missing repo/calls");
  }
  const stats: EstateStats = {
    boxes: 0, unboxed: 0, services: 0, yards: 0, belts: 0, callBelts: 0,
    couplingBelts: 0, skippedSelf: 0, skippedUnowned: 0, unmatchedSkipped: 0, unmappedFiles: 0, missingEndpoints: 0,
    frontendMachines: 0, frontendCalls: 0, frontendUnmatched: 0,
  };

  // Endpoint lookup: box endpoint ids resolve back into byFile entries.
  const byRepoFile = new Map<string, EstateFileEntry>();
  for (const [k, entry] of Object.entries(estate.byFile)) byRepoFile.set(k, entry);

  const serviceNames = new Map(estate.repos.map((r) => [r.repo, r.serviceName]));
  const exposedFor = (repo: string): boolean => isExposed(repo, serviceNames.get(repo), gatewayRoutes);

  const resolveEndpoint = (id: string): EndpointSummary | undefined => {
    const parts = parseBoxEndpointId(id);
    if (!parts) return undefined;
    const entry = byRepoFile.get(`${parts.repo}\0${parts.file}`);
    if (!entry) return undefined;
    const ep = entry.endpoints.find((e) => e.method === parts.method && e.path === parts.path);
    // Copy, never mutate: the byFile entries are shared inputs.
    return ep ? { ...ep, exposed: exposedFor(parts.repo) } : undefined;
  };

  // File ownership: box files first, then thin-service / yard machines.
  const fileOwner = new Map<string, string>(); // `repo:path` -> building id
  for (const box of boxesJson.boxes) {
    for (const f of box.files) fileOwner.set(f, box.id);
  }
  // Fat repos (their remainder is a yard, not a service): table owners,
  // i.e. repos holding @Entity files. Box `repos` can't decide this —
  // thin-repo controllers join boxes through the tables their endpoints
  // touch. The bar is 10 entities: owners hold dozens, experiments 2.
  const entityCount = new Map<string, number>();
  for (const [k, entry] of byRepoFile) {
    if (!entry.kinds.includes("entity")) continue;
    const repo = k.slice(0, k.indexOf("\0"));
    entityCount.set(repo, (entityCount.get(repo) ?? 0) + 1);
  }
  const fatRepos = new Set([...entityCount.entries()].filter(([, n]) => n >= 10).map(([r]) => r));
  const repoLabels = [...new Set((estate.repos ?? []).map((r) => r.repo))].sort();
  const thinRepos = repoLabels.filter((r) => !fatRepos.has(r));

  type Draft = Omit<Building, "x" | "y" | "zoneId">;
  const drafts: Draft[] = [];

  // --- box machines ------------------------------------------------
  for (const box of [...boxesJson.boxes].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const endpoints: EndpointSummary[] = [];
    for (const id of box.endpoints) {
      const ep = resolveEndpoint(id);
      if (ep) endpoints.push(ep);
      else stats.missingEndpoints++;
    }
    const calls = [];
    const topics = [];
    let unresolvedNotes = 0;
    const members = [...box.files].sort();
    for (const f of members) {
      const entry = byRepoFile.get(f.replace(":", "\0"));
      if (!entry) continue;
      calls.push(...entry.calls);
      topics.push(...entry.topics);
      unresolvedNotes += entry.unresolvedNotes;
    }
    calls.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.method < b.method ? -1 : 1));
    const zone = isBigBox(box) ? "core" : "shelf";
    const shorts = [...new Set(box.repos.map(shortRepo))].sort();
    drafts.push({
      id: box.id,
      path: `${zone}/${box.id}-${box.name}`,
      band: bandForTraffic(box.endpointCount),
      lines: box.endpointCount,
      bytes: 0,
      mtimeMs: 0,
      binary: false,
      parse: "ok",
      unresolvedCount: 0,
      members,
      conn: {
        // The full repo list, never truncated: this is the box's
        // address, and a `+N more` tail would hide where it lives.
        repo: shorts.join(", "),
        kinds: ["box"],
        endpoints,
        tables: boxTables(box, endpoints),
        calls,
        topics,
        unresolvedNotes,
      },
    });
    stats.boxes++;
  }

  // --- unboxed tables: visible, not hidden --------------------------------
  for (const table of [...boxesJson.unboxed].sort()) {
    drafts.push({
      id: `unboxed-${table}`,
      path: `shelf/unboxed-${table}`,
      band: 0,
      lines: 0,
      bytes: 0,
      mtimeMs: 0,
      binary: false,
      parse: "ok",
      unresolvedCount: 0,
      members: [],
      conn: {
        repo: "",
        kinds: ["unboxed"],
        endpoints: [],
        tables: [{ table, access: "unknown", via: "repository", derived: "explicit", through: "no endpoint reaches this table" }],
        calls: [],
        topics: [],
        unresolvedNotes: 0,
      },
    });
    stats.unboxed++;
  }
  // --- thin-service + yard machines -------------------------------------
  const serviceConn = (entries: EstateFileEntry[], repo: string): BuildingConnections => {
    const exposed = exposedFor(repo);
    const endpoints = entries.flatMap((e) => e.endpoints.map((ep) => ({ ...ep, exposed })));
    endpoints.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const calls = entries.flatMap((e) => e.calls);
    calls.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
      repo: "",
      kinds: [],
      endpoints,
      tables: aggregateTables(endpoints),
      calls,
      topics: entries.flatMap((e) => e.topics),
      unresolvedNotes: entries.reduce((n, e) => n + e.unresolvedNotes, 0),
    };
  };
  const filesOfRepo = (repo: string): [string, EstateFileEntry][] =>
    [...byRepoFile.entries()].filter(([k]) => k.startsWith(`${repo}\0`)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const hasContracts = (e: EstateFileEntry): boolean =>
    e.endpoints.length + e.calls.length + e.tables.length + e.topics.length > 0;

  for (const repo of thinRepos) {
    const id = `svc-${shortRepo(repo)}`;
    const owned = filesOfRepo(repo);
    const contractFiles = owned.filter(([, e]) => hasContracts(e));
    stats.unmappedFiles += owned.length - contractFiles.length;
    for (const [k] of owned) fileOwner.set(k.replace("\0", ":"), id);
    const members = contractFiles.map(([k]) => k.replace("\0", ":"));
    const entries = contractFiles.map(([, e]) => e);
    const traffic = entries.reduce((n, e) => n + e.endpoints.length + e.calls.length, 0);
    drafts.push({
      id,
      path: `services/${shortRepo(repo)}`,
      band: bandForTraffic(traffic),
      lines: traffic,
      bytes: 0,
      mtimeMs: 0,
      binary: false,
      parse: "ok",
      unresolvedCount: 0,
      members,
      conn: { ...serviceConn(entries, repo), service: shortRepo(repo), kinds: ["service"] },
    });
    stats.services++;
  }
  for (const repo of [...fatRepos].sort()) {
    const orphans = filesOfRepo(repo).filter(([k]) => !fileOwner.has(k.replace("\0", ":")));
    const contractOrphans = orphans.filter(([, e]) => hasContracts(e));
    stats.unmappedFiles += orphans.length - contractOrphans.length;
    if (contractOrphans.length === 0) continue;
    const id = `yard-${shortRepo(repo)}`;
    for (const [k] of orphans) fileOwner.set(k.replace("\0", ":"), id);
    const members = contractOrphans.map(([k]) => k.replace("\0", ":"));
    const entries = contractOrphans.map(([, e]) => e);
    const traffic = entries.reduce((n, e) => n + e.endpoints.length + e.calls.length, 0);
    drafts.push({
      id,
      path: `services/${shortRepo(repo)}-yard`,
      band: bandForTraffic(traffic),
      lines: traffic,
      bytes: 0,
      mtimeMs: 0,
      binary: false,
      parse: "ok",
      unresolvedCount: 0,
      members,
      conn: { ...serviceConn(entries, repo), service: `${shortRepo(repo)} unboxed`, kinds: ["yard"] },
    });
    stats.yards++;
  }

  // --- frontend machines (one per app + shared libs; their calls
  // belt into boxes, services, and yards like any other caller) ------
  const feCalls: FrontendCallJson[] = (frontend?.calls ?? [])
    .filter((c) => c && typeof c.method === "string" && typeof c.path === "string")
    .sort((a, b) => (a.app < b.app ? -1 : a.app > b.app ? 1 : a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const feByApp = new Map<string, FrontendCallJson[]>();
  for (const c of feCalls) {
    const list = feByApp.get(c.app) ?? [];
    list.push(c);
    feByApp.set(c.app, list);
  }
  const feId = (app: string) => `fe-${app}`;
  for (const app of [...feByApp.keys()].sort()) {
    const calls = feByApp.get(app)!;
    const members = [...new Set(calls.map((c) => `${frontend!.repo}:${c.file}`))].sort();
    drafts.push({
      id: feId(app),
      path: `frontend/${feId(app)}`,
      band: bandForTraffic(calls.length),
      lines: calls.length,
      bytes: 0,
      mtimeMs: 0,
      binary: false,
      parse: "ok",
      unresolvedCount: 0,
      members,
      conn: {
        repo: "frontend",
        kinds: ["frontend"],
        service: app,
        endpoints: [],
        tables: [],
        calls: calls.map((c) => ({
          method: c.method,
          path: c.path,
          via: "angular",
          caller: `${c.file}:${c.line}`,
          line: c.line,
          ...(c.match ? { matchedPath: `${c.match.repo}:${c.match.file}` } : {}),
        })),
        topics: [],
        unresolvedNotes: 0,
      },
    });
    stats.frontendMachines++;
  }
  stats.frontendCalls = feCalls.length;
  stats.frontendUnmatched = feCalls.filter((c) => !c.match).length;
  // Intent targets: the implied service machine (svc first, else its yard).
  const draftIds = new Set(drafts.map((d) => d.id));
  const intentTarget = (repo: string): string | undefined => {
    const short = shortRepo(repo);
    if (draftIds.has(`svc-${short}`)) return `svc-${short}`;
    if (draftIds.has(`yard-${short}`)) return `yard-${short}`;
    return undefined;
  };

  // --- call-flow belts (every cite ships: a `+N more` tail hides
  // the evidence the card exists to show) -----------------------------------
  type Pair = { fromId: string; toId: string; cites: string[] };
  const pairs = new Map<string, Pair>();
  for (const [k, entry] of [...byRepoFile.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const fromId = fileOwner.get(k.replace("\0", ":"));
    for (const c of entry.calls) {
      if (!c.matchedPath) { stats.unmatchedSkipped++; continue; }
      const toId = fileOwner.get(c.matchedPath);
      if (!fromId || !toId) { stats.skippedUnowned++; continue; }
      if (fromId === toId) { stats.skippedSelf++; continue; }
      const key = `${fromId}\0${toId}`;
      let pair = pairs.get(key);
      if (!pair) { pair = { fromId, toId, cites: [] }; pairs.set(key, pair); }
      pair.cites.push(`${c.method} ${c.path} — line ${c.line}: ${c.caller || "?"} (${c.via}) → ${baseName(c.matchedPath)}`);
    }
  }
  // Frontend calls belt the same way. Unmatched calls belt to the
  // implied service machine with an UNMATCHED cite: the call exists
  // in code, the endpoint does not — the void, drawn.
  for (const c of feCalls) {
    const fromId = feId(c.app);
    let toId: string | undefined;
    let cite: string;
    if (c.match) {
      toId = fileOwner.get(`${c.match.repo}:${c.match.file}`);
      if (!toId) { stats.skippedUnowned++; continue; }
      const kind = c.match.kind === "exact" ? "" : `, ${c.match.kind}`;
      cite = `${c.method} ${c.path} — line ${c.line}: ${c.file} (angular${kind}) → ${baseName(c.match.file)}`;
    } else {
      if (!c.intent) { stats.skippedUnowned++; continue; }
      toId = intentTarget(c.intent);
      if (!toId) { stats.skippedUnowned++; continue; }
      cite = `${c.method} ${c.path} — UNMATCHED line ${c.line}: ${c.file} (angular) → ${shortRepo(c.intent)} (no such endpoint)`;
    }
    if (fromId === toId) { stats.skippedSelf++; continue; }
    const key = `${fromId}\0${toId}`;
    let pair = pairs.get(key);
    if (!pair) { pair = { fromId, toId, cites: [] }; pairs.set(key, pair); }
    pair.cites.push(cite);
  }
  const belts: BeltEdge[] = [...pairs.values()]
    .sort((a, b) => (a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : a.toId < b.toId ? -1 : 1))
    .map((p) => ({ fromId: p.fromId, toId: p.toId, kind: "http" as const, via: p.cites }));
  stats.callBelts = belts.length;

  // --- coupling belts: shared endpoints between big boxes ------------------
  const epBoxes = new Map<string, string[]>();
  for (const box of boxesJson.boxes) {
    if (!isBigBox(box)) continue;
    for (const id of box.endpoints) {
      const list = epBoxes.get(id) ?? [];
      list.push(box.id);
      epBoxes.set(id, list);
    }
  }
  const shared = new Map<string, string[]>();
  for (const [ep, ids] of epBoxes) {
    const uniq = [...new Set(ids)].sort();
    for (let i = 0; i < uniq.length; i++) for (let j = i + 1; j < uniq.length; j++) {
      const key = `${uniq[i]}\0${uniq[j]}`;
      const list = shared.get(key) ?? [];
      list.push(ep);
      shared.set(key, list);
    }
  }
  const coupled = [...shared.entries()].filter(([, eps]) => eps.length >= 8).sort((a, b) => b[1].length - a[1].length).slice(0, 25);
  for (const [key, eps] of coupled) {
    const [a, b] = key.split("\0") as [string, string];
    const via: string[] = [];
    for (const id of [...eps].sort()) {
      const parts = parseBoxEndpointId(id);
      const ep = resolveEndpoint(id);
      if (parts && ep) via.push(`shared endpoint ${ep.method} ${ep.path} — line ${ep.line}: ${ep.handler || "?"}`);
    }
    belts.push({ fromId: a, toId: b, via });
    stats.couplingBelts++;
  }
  belts.sort((a, b) => (a.fromId < b.fromId ? -1 : a.fromId > b.fromId ? 1 : a.toId < b.toId ? -1 : 1));
  stats.belts = belts.length;

  // --- layout (deterministic; ids are ours, positions from the grid) --------
  const layout = layoutFloor(drafts.map((d) => d.path));
  const buildings: Building[] = drafts
    .map((d) => ({ ...d, x: layout.buildings[d.path]!.x, y: layout.buildings[d.path]!.y, zoneId: layout.buildings[d.path]!.zoneId }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return { buildings, belts, zones: zoneRects(layout), stats };
}

