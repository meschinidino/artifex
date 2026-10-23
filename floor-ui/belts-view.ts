/**
 * Belt derived data + classification (coverage slice 3).
 *
 * Pure: degree maps, zone aggregates, reroute/coalesce/degrade
 * predicates, route and rollup classifiers, tick budgets. `app.ts`
 * owns the cache object, the coalesce timer, and every canvas stroke.
 */
import { bboxOfPts, boxVisible, segmentVisible, type ViewBox } from "./camera.ts";
import type { ZoneRect } from "./layout.ts";
import type { RoutableBuilding, RoutedPath } from "./route.ts";
import type { BeltEdge, Building } from "./wire.ts";

/** Patch bursts re-route at most this often; a catch-up frame follows. */
export const ROUTE_MIN_INTERVAL = 250;
/** Route passes slower than this trip the chevron/tick degrade. */
export const ROUTE_DEGRADE_MS = 50;
/** Degrade clears only below this: no flicker at the boundary. */
export const ROUTE_RECOVER_MS = 35;
/** Item-tick spacing along a live belt (world units). */
export const TICK_SPACING = 64;
/** Item ticks per belt, and total per frame. */
export const TICKS_PER_ROUTE = 3;
export const TICK_CAP = 48;

export type Degrees = {
  byId: Map<string, Building>;
  inDegree: Map<string, number>;
  outDegree: Map<string, number>;
};

/**
 * Fan-in/fan-out over resolved edges; edges touching unknown
 * buildings are skipped (cap-cut or mid-patch phantoms).
 */
export function countDegrees(buildings: Iterable<Building>, belts: Iterable<BeltEdge>): Degrees {
  const byId = new Map<string, Building>();
  for (const b of buildings) byId.set(b.id, b);
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  for (const e of belts) {
    if (!byId.get(e.fromId) || !byId.get(e.toId)) continue;
    inDegree.set(e.toId, (inDegree.get(e.toId) ?? 0) + 1);
    outDegree.set(e.fromId, (outDegree.get(e.fromId) ?? 0) + 1);
  }
  return { byId, inDegree, outDegree };
}

/** Pip count per building id: max of fan-in/fan-out, cap 5. */
export function countPips(inDegree: Map<string, number>, outDegree: Map<string, number>): Map<string, number> {
  const pipCounts = new Map<string, number>();
  for (const [id, n] of inDegree) pipCounts.set(id, Math.min(5, n));
  for (const [id, n] of outDegree) pipCounts.set(id, Math.min(5, Math.max(n, pipCounts.get(id) ?? 0)));
  return pipCounts;
}

export type ZoneAggregate = { a: string; b: string; count: number };

/**
 * Cross-zone pair counts for the far-band rollup. Same-zone pairs
 * never aggregate; pairs are directional (a→b and b→a stay split).
 */
export function aggregateZones(byId: Map<string, Building>, belts: Iterable<BeltEdge>): ZoneAggregate[] {
  const counts = new Map<string, number>();
  for (const e of belts) {
    const from = byId.get(e.fromId);
    const to = byId.get(e.toId);
    if (!from || !to) continue;
    if (from.zoneId === to.zoneId) continue;
    const key = `${from.zoneId}\0${to.zoneId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([key, count]) => {
    const [a, b] = key.split("\0") as [string, string];
    return { a, b, count };
  });
}

/**
 * Reroute guard: version move OR belts-array identity change. The
 * identity leg catches reconnects — a restarted server reuses
 * version numbers with different content.
 */
export function needsReroute(
  cached: { version: number; belts: BeltEdge[] } | undefined,
  version: number,
  belts: BeltEdge[],
): boolean {
  return !cached || cached.version !== version || cached.belts !== belts;
}

/** Patch-burst coalescing: re-route at most every 250 ms. */
export function shouldCoalesce(lastRouteAt: number, nowMs: number): boolean {
  return nowMs - lastRouteAt < ROUTE_MIN_INTERVAL;
}

/**
 * Degrade hysteresis: trip above 50 ms, clear below 35 ms, hold the
 * previous state between (no chevron flicker at the boundary).
 */
export function degradeStep(routeMs: number, wasDegraded: boolean): boolean {
  if (routeMs > ROUTE_DEGRADE_MS) return true;
  if (routeMs < ROUTE_RECOVER_MS) return false;
  return wasDegraded;
}

export type RoutableFloor = { list: RoutableBuilding[]; floorBottom: number };

/**
 * Router input: per-building zone order (unknown zones sort first)
 * plus the floor bottom the bus band hangs below.
 */
export function routableBuildings(
  buildings: Iterable<Building>,
  zones: readonly ZoneRect[],
): RoutableFloor {
  const zoneOrder = new Map(zones.map((z, i) => [z.id, i]));
  const list = [...buildings].map((b) => ({
    id: b.id,
    zoneOrder: zoneOrder.get(b.zoneId) ?? 0,
    x: b.x,
    y: b.y,
    band: b.band,
  }));
  const floorBottom = zones.length > 0 ? Math.max(...zones.map((z) => z.y + z.h)) : 0;
  return { list, floorBottom };
}

export type ClassifiedRoutes = {
  live: RoutedPath[];
  struct: RoutedPath[];
  dimmed: RoutedPath[];
  drawn: number;
  endpoints: [string, string][];
};

/**
 * Mid/near route classifier: unknown endpoints drop first, then the
 * rendered-set gate (skipped for incident routes under a selection,
 * so a selection spotlights its full neighborhood even to
 * unrendered targets), then the view cull, then incident/dimmed by
 * selection, then live/struct by pulse. Drawn counts only incident
 * routes.
 */
export function classifyRoutes(
  routes: readonly RoutedPath[],
  byId: Map<string, Building>,
  visibleIds: Set<string>,
  isolatedId: string | undefined,
  pulsedIds: Set<string>,
  view: ViewBox,
): ClassifiedRoutes {
  const live: RoutedPath[] = [];
  const struct: RoutedPath[] = [];
  const dimmed: RoutedPath[] = [];
  const endpoints: [string, string][] = [];
  let drawn = 0;
  for (const r of routes) {
    const from = byId.get(r.fromId);
    const to = byId.get(r.toId);
    if (!from || !to) continue;
    const selected = isolatedId !== undefined && (r.fromId === isolatedId || r.toId === isolatedId);
    if (!selected && (!visibleIds.has(from.id) || !visibleIds.has(to.id))) continue;
    const bb = bboxOfPts(r.pts);
    if (!boxVisible(bb.x0, bb.y0, bb.x1, bb.y1, view)) continue;
    if (!selected && isolatedId !== undefined) {
      dimmed.push(r);
      continue;
    }
    drawn++;
    endpoints.push([r.fromId, r.toId]);
    (pulsedIds.has(r.fromId) || pulsedIds.has(r.toId) ? live : struct).push(r);
  }
  return { live, struct, dimmed, drawn, endpoints };
}

export type RollupBucket = { min: number; max: number; width: number };

/** Far-band width buckets: thin/mid/wide by pair count. */
export const ROLLUP_BUCKETS: readonly RollupBucket[] = [
  { min: 1, max: 2, width: 1.75 },
  { min: 3, max: 8, width: 4 },
  { min: 9, max: Infinity, width: 6 },
];

export type RollupLane = { width: number; live: boolean; aggs: ZoneAggregate[] };

/**
 * Far-band rollup classifier: each aggregate lands in one width
 * bucket as live (touches a pulsed or selected zone) or steel.
 * Selection narrows to pairs touching its zone; pairs with a
 * missing zone or outside the view drop.
 */
export function classifyAggregates(
  aggregates: readonly ZoneAggregate[],
  zoneById: Map<string, ZoneRect>,
  pulsedZones: Set<string>,
  isolatedZone: string | undefined,
  view: ViewBox,
): RollupLane[] {
  const lanes: RollupLane[] = [];
  for (const { min, max, width } of ROLLUP_BUCKETS) {
    for (const live of [true, false] as const) {
      const aggs: ZoneAggregate[] = [];
      for (const agg of aggregates) {
        if (agg.count < min || agg.count > max) continue;
        if (isolatedZone !== undefined && agg.a !== isolatedZone && agg.b !== isolatedZone) continue;
        const za = zoneById.get(agg.a);
        const zb = zoneById.get(agg.b);
        if (!za || !zb) continue;
        const pairLive =
          pulsedZones.has(agg.a) ||
          pulsedZones.has(agg.b) ||
          (isolatedZone !== undefined && (agg.a === isolatedZone || agg.b === isolatedZone));
        if (pairLive !== live) continue;
        const ax = za.x + za.w / 2;
        const ay = za.y + za.h / 2;
        const bx = zb.x + zb.w / 2;
        const by = zb.y + zb.h / 2;
        if (!segmentVisible(ax, ay, bx, by, view)) continue;
        aggs.push(agg);
      }
      lanes.push({ width, live, aggs });
    }
  }
  return lanes;
}

/**
 * Belt kind for canvas styling (Pass 1): absent kind reads as
 * import — the wire only marks contract belts.
 */
export type BeltKind = "import" | "http" | "topic";

export function beltKindOf(edge: BeltEdge): BeltKind {
  return edge.kind ?? "import";
}

/**
 * Dash pattern per kind in screen-px units (scaled by s at draw);
 * undefined reads solid. Import stays solid, http dashes long
 * (never the ghost's [5, 4]), topic dots. Graphite tones only —
 * the draw path pairs these with live/muted, never a new hue.
 */
export function kindDash(kind: BeltKind): readonly number[] | undefined {
  if (kind === "http") return [11, 5];
  if (kind === "topic") return [2, 4];
  return undefined;
}

/**
 * Mid/near width buckets by citation count (the ROLLUP_BUCKETS
 * pattern, edges fit to measured panel data: single-relationship
 * pairs dominate everywhere, so 2 cites read mid and 3+ read
 * wide). Deliberately NOT via length: uses/marker items inflate
 * via unevenly across languages (every attributed Go belt would
 * read mid for one relationship), while citations count
 * relationships — the throughput the width encodes.
 */
export const BELT_BUCKETS: readonly RollupBucket[] = [
  { min: 0, max: 1, width: 1.5 },
  { min: 2, max: 2, width: 2.5 },
  { min: 3, max: Infinity, width: 4 },
];

/** Stroke width for one belt: its citation-count bucket's width. */
export function beltWidth(citeCount: number): number {
  const bucket = BELT_BUCKETS.find((b) => citeCount >= b.min && citeCount <= b.max);
  return bucket?.width ?? 1.5;
}

/**
 * Symbols one belt provably carries: deduped names in first-seen
 * order plus the unfolded total (the `+n` tail). Built from the
 * `uses …` items and contract prefixes the server ships in via[],
 * plus conservative single-line import shapes — never a guess
 * (Pass 1 step 1; anything unrecognized falls back to counts).
 */
export type CarriedSymbols = { names: string[]; total: number };

/** `uses A, B, +N more` / `uses prefix: A, B` → names + unfolded total. */
export function parseUsesItem(item: string): CarriedSymbols | undefined {
  if (!item.startsWith("uses ")) return undefined;
  let rest = item.slice("uses ".length);
  let extra = 0;
  const tail = /, \+(\d+) more$/.exec(rest);
  if (tail) {
    extra = Number(tail[1]);
    rest = rest.slice(0, tail.index);
  }
  // `uses prefix: A, B` — the qualifier names the container, not a
  // carried symbol.
  const colon = rest.indexOf(": ");
  if (colon !== -1) rest = rest.slice(colon + 2);
  const names = rest
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z_$][\w$]*(?:\.\*)?$/.test(s));
  if (names.length === 0) return undefined;
  return { names, total: names.length + extra };
}

/**
 * Contract prefix: `METHOD /path` for http, the topic for topic
 * (the `via handler` names code, not what flows). Undefined unless
 * the item carries the `— line N` citation shape.
 */
export function parseContractItem(item: string, kind: BeltKind): string | undefined {
  const dash = item.indexOf(" — line ");
  if (dash === -1) return undefined;
  const head = item.slice(0, dash);
  if (kind === "http") return /^[A-Z]+ \/\S*$/.test(head) ? head : undefined;
  if (kind === "topic") {
    const via = head.lastIndexOf(" via ");
    const topic = via === -1 ? head : head.slice(0, via);
    return topic.length > 0 && !topic.includes(" ") ? topic : undefined;
  }
  return undefined;
}

export type ImportLang = "ts" | "py" | "jvm" | "go" | "other";

/** Import language by file extension; unknown extensions read `other`. */
export function langOfPath(path: string): ImportLang {
  if (/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path)) return "ts";
  if (/\.py$/.test(path)) return "py";
  if (/\.(java|kt)$/.test(path)) return "jvm";
  if (/\.go$/.test(path)) return "go";
  return "other";
}

/**
 * Source text after the `line N: ` citation prefix; undefined for
 * bare citations and non-citation items (uses/marker items).
 */
export function citationText(item: string): string | undefined {
  const m = /^line \d+: (.*)$/.exec(item);
  return m ? m[1] : undefined;
}

/**
 * Local names bound by one single-line TS/JS import (or
 * export-from) statement — the server's uses-item convention
 * (locals, `ns.*` for namespaces). Multiline, capped (`…`),
 * commented, side-effect, and star shapes bail to []: the uses
 * item or the counts fallback covers them.
 */
export function parseTsImportLine(text: string): string[] {
  if (text.endsWith("…") || text.includes("/*")) return [];
  const stmt = text.split("//")[0]!;
  const from = /\bfrom\s+["'][^"']*["'][\s;]*$/.exec(stmt);
  if (!from) return [];
  const body = stmt
    .slice(0, from.index)
    .replace(/^\s*(import|export)\s+type\s+/, "$1 ")
    .replace(/^\s*import\s+/, "")
    .replace(/^\s*export\s+/, "");
  if (/[{}]/.test(body) && (body.match(/\{/g) ?? []).length !== 1) return [];
  const open = body.indexOf("{");
  if (open !== -1 && body.indexOf("}", open) === -1) return [];
  if (/^\s*\*\s*$/.test(body)) return [];
  const names: string[] = [];
  const defLead = /^\s*([A-Za-z_$][\w$]*)\s*(,|$)/.exec(body);
  if (defLead) names.push(defLead[1]!);
  const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(body);
  if (ns) names.push(`${ns[1]}.*`);
  const brace = /\{([\s\S]*)\}/.exec(body);
  if (brace) {
    for (const entry of brace[1]!.split(",")) {
      const local = entry
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
    }
  }
  return names;
}

/**
 * Names bound by one single-line Python import: from-imports
 * yield their list, plain imports their dotted paths, `as` forms
 * their locals. Unclosed parens (multiline) and capped lines
 * bail to [].
 */
export function parsePyImportLine(text: string): string[] {
  if (text.endsWith("…")) return [];
  const stmt = text.split("#")[0]!.trim().replace(/;$/, "");
  const from = /^\s*from\s+\S+\s+import\s+(.*)$/.exec(stmt);
  const list = from ? from[1]! : /^\s*import\s+(.*)$/.exec(stmt)?.[1];
  if (list === undefined) return [];
  const trimmed = list.trim();
  if (trimmed.startsWith("(") && !trimmed.endsWith(")")) return [];
  const names: string[] = [];
  for (const entry of trimmed.replace(/^[()]+|[()]+$/g, "").split(",")) {
    const parts = entry.trim().split(/\s+as\s+/);
    const name = (parts.length > 1 ? parts[parts.length - 1]! : parts[0]!).trim();
    if (/^[A-Za-z_][\w.]*$/.test(name)) names.push(name);
  }
  return names;
}

/**
 * Type carried by one explicit JVM import: the last segment
 * (`import static` yields the member). Wildcards and capped lines
 * bail to [].
 */
export function parseJvmImportLine(text: string): string[] {
  if (text.endsWith("…")) return [];
  const m = /^\s*import\s+(?:static\s+)?([\w.]+)\s*;?\s*(?:\/\/.*)?$/.exec(text);
  if (!m) return [];
  // Wildcards never match: `*` is outside the dotted class, so the
  // uses item (or counts) covers them.
  const dotted = m[1]!;
  const last = dotted.slice(dotted.lastIndexOf(".") + 1);
  return /^[A-Za-z_$][\w$]*$/.test(last) ? [last] : [];
}

/**
 * Names carried by one cited import line: TS/JS, Python, and JVM
 * micro-parsers; Go lines are package-only and other languages
 * unrecognized, so both yield [] (the uses item or counts cover
 * them).
 */
export function parseImportCitation(text: string, lang: ImportLang): string[] {
  if (lang === "ts") return parseTsImportLine(text);
  if (lang === "py") return parsePyImportLine(text);
  if (lang === "jvm") return parseJvmImportLine(text);
  return [];
}

/**
 * Symbols one belt carries, from its via items: uses items first,
 * then contract prefixes (http/topic), then cited import lines in
 * the importer's language. Names dedup in first-seen order; the
 * total unfolds every `+N more` tail. Undefined when no item
 * names anything — the caller falls back to counts.
 */
export function extractCarried(edge: BeltEdge, fromPath: string): CarriedSymbols | undefined {
  const via = edge.via;
  if (!via || via.length === 0) return undefined;
  const kind = beltKindOf(edge);
  const lang = langOfPath(fromPath);
  const names: string[] = [];
  let total = 0;
  const take = (found: string[], count: number) => {
    for (const n of found) if (!names.includes(n)) names.push(n);
    total += count;
  };
  for (const item of via) {
    const uses = parseUsesItem(item);
    if (uses) {
      take(uses.names, uses.total);
      continue;
    }
    if (kind !== "import") {
      const contract = parseContractItem(item, kind);
      if (contract !== undefined) take([contract], 1);
      continue;
    }
    const cited = citationText(item);
    if (cited === undefined) continue;
    const citedNames = parseImportCitation(cited, lang);
    take(citedNames, citedNames.length);
  }
  if (names.length === 0) return undefined;
  return { names, total: Math.max(total, names.length) };
}

/**
 * Citation relationships on one belt: via items in a citation
 * shape (`line N…` or `… — line N…`), so uses/marker items never
 * inflate the counts fallback.
 */
export function countCiteItems(edge: BeltEdge): number {
  const via = edge.via;
  if (!via) return 0;
  let n = 0;
  for (const item of via) {
    if (/^line \d+/.test(item) || / — line \d+/.test(item)) n++;
  }
  return n;
}

/** Symbols shown on canvas before the `+n` tail. */
export const BELT_LABEL_CAP = 2;

/**
 * Canvas label for one belt: `A, B +n` from carried symbols, else
 * `×n` once two citations back it. Undefined means unlabeled —
 * never a placeholder.
 */
export function formatBeltLabel(carried: CarriedSymbols | undefined, cites: number): string | undefined {
  if (carried && carried.names.length > 0) {
    const head = carried.names.slice(0, BELT_LABEL_CAP).join(", ");
    const rest = carried.total - BELT_LABEL_CAP;
    return rest > 0 ? `${head} +${rest}` : head;
  }
  return cites >= 2 ? `×${cites}` : undefined;
}

/** In-degree at which an endpoint makes a belt a hub belt. */
export const HUB_IN_DEGREE = 5;

/** True when either endpoint's in-degree reaches the hub bar. */
export function isHubBelt(edge: BeltEdge, inDegree: ReadonlyMap<string, number>): boolean {
  return (inDegree.get(edge.fromId) ?? 0) >= HUB_IN_DEGREE || (inDegree.get(edge.toId) ?? 0) >= HUB_IN_DEGREE;
}

/**
 * Label for one belt in one band: far never labels, mid labels
 * hub belts only, near labels everything it can name or count.
 * Contract belts prefer their rule phrase (PPH1); import belts
 * prefer the cached server phrase (PPH3, absent until asked);
 * everything else reads symbols, then counts.
 */
export function beltLabelFor(
  band: "far" | "mid" | "near",
  edge: BeltEdge,
  fromPath: string,
  inDegree: ReadonlyMap<string, number>,
  serverPhrase?: string,
): string | undefined {
  if (band === "far") return undefined;
  if (band === "mid" && !isHubBelt(edge, inDegree)) return undefined;
  const kind = beltKindOf(edge);
  if (kind !== "import") {
    return (
      phraseForContract(kind, edge.via) ?? formatBeltLabel(extractCarried(edge, fromPath), countCiteItems(edge))
    );
  }
  return serverPhrase ?? formatBeltLabel(extractCarried(edge, fromPath), countCiteItems(edge));
}

/**
 * Hover/selected label for one belt (PPH3): the purpose phrase
 * first, the carried symbols after an em dash as evidence. No
 * band gate — an explicitly pointed-at belt always names itself
 * when it can. Falls back to whichever half exists.
 */
export function beltHoverLabel(edge: BeltEdge, fromPath: string, serverPhrase?: string): string | undefined {
  const kind = beltKindOf(edge);
  const phrase = kind === "import" ? serverPhrase : phraseForContract(kind, edge.via);
  const symbols = formatBeltLabel(extractCarried(edge, fromPath), countCiteItems(edge));
  if (phrase && symbols && symbols !== phrase) return `${phrase} — ${symbols}`;
  return phrase ?? symbols;
}

/** HTTP method → phrase verb. Unlisted methods bail to symbols. */
const HTTP_PHRASE_VERBS: Record<string, string> = {
  GET: "fetches",
  POST: "sends",
  PUT: "updates",
  PATCH: "patches",
  DELETE: "removes",
};

/** Trailing segments that restate the method verb (the noun sits before them). */
const VERB_SEGMENTS = new Set([
  "send",
  "create",
  "update",
  "delete",
  "get",
  "fetch",
  "generate",
  "remove",
  "add",
  "list",
  "find",
  "search",
  "load",
  "save",
  "run",
  "make",
  "build",
  "check",
]);

/** Filler segments skipped while hunting the path noun. */
const PATH_FILLERS = new Set(["api", "rest"]);

/** `order-items` / `orderItems` → `order items`. */
function humanizeSegment(seg: string): string {
  return seg
    .replace(/[_.-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase();
}

/**
 * Noun for one endpoint path: last static segment, skipping
 * `{params}`, `api`/version fillers, and a trailing verb
 * restatement (`POST …/chequera/send` → `chequera`).
 */
function pathNoun(path: string): string | undefined {
  const segs = path
    .split("/")
    .filter((s) => s.length > 0 && !/^\{.*\}$/.test(s) && !/^v\d+$/i.test(s) && !PATH_FILLERS.has(s.toLowerCase()));
  if (segs.length === 0) return undefined;
  let noun = segs[segs.length - 1]!;
  if (segs.length > 1 && VERB_SEGMENTS.has(noun.toLowerCase())) noun = segs[segs.length - 2]!;
  const words = humanizeSegment(noun);
  return words.length > 0 ? words : undefined;
}

/** `GET /api/orders` → `fetches orders`. Undefined on unknown methods or noun-less paths. */
export function phraseForHttpCall(method: string, path: string): string | undefined {
  const verb = HTTP_PHRASE_VERBS[method.toUpperCase()];
  if (!verb) return undefined;
  const noun = pathNoun(path);
  return noun ? `${verb} ${noun}` : undefined;
}

/** `orders` → `publishes orders`. Undefined when nothing human survives. */
export function phraseForTopic(topic: string): string | undefined {
  const words = humanizeSegment(topic);
  return words.length > 0 ? `publishes ${words}` : undefined;
}

/**
 * Rule-derived purpose phrase for one contract belt (PPH1):
 * the first item's phrase plus a `+n` tail. Undefined when no
 * item parses — the caller falls back to symbols.
 */
export function phraseForContract(kind: BeltKind, via: readonly string[] | undefined): string | undefined {
  if (kind === "import" || !via) return undefined;
  const phrases: string[] = [];
  for (const item of via) {
    const contract = parseContractItem(item, kind);
    if (contract === undefined) continue;
    if (kind === "http") {
      const space = contract.indexOf(" ");
      const phrase = phraseForHttpCall(contract.slice(0, space), contract.slice(space + 1));
      if (phrase) phrases.push(phrase);
    } else {
      const phrase = phraseForTopic(contract);
      if (phrase) phrases.push(phrase);
    }
  }
  if (phrases.length === 0) return undefined;
  const rest = phrases.length - 1;
  return rest > 0 ? `${phrases[0]} +${rest}` : phrases[0];
}

/**
 * cyrb53 (non-crypto, pure arithmetic): deterministic across
 * bun and browsers. Content equality only — never security.
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/**
 * Canonical hash over the phrase-relevant belt content (pairs,
 * kinds, via). Client and server share it: phrase staleness is
 * a hash mismatch, no extra wire fields.
 */
export function beltContentHash(belts: readonly BeltEdge[]): string {
  const canon = belts
    .map((e) => [e.fromId, e.toId, e.kind ?? "", (e.via ?? []).join("\n")].join(""))
    .sort()
    .join("");
  return cyrb53(canon).toString(16);
}

/**
 * Phrase-map key for one belt pair. NUL separates the ids (an
 * explicit escape, never a literal byte); ids come from building
 * filenames and never contain it. Server and client share this.
 */
export function phrasePairKey(fromId: string, toId: string): string {
  return `${fromId}\0${toId}`;
}

/**
 * Item-tick budgets per live belt: min(3, len/64) each, 48 total per
 * frame — later belts starve once the cap binds. Positions come from
 * pointAt (Slice 1) at draw time.
 */
export function tickCounts(lens: readonly number[]): number[] {
  const out: number[] = [];
  let items = 0;
  for (const len of lens) {
    const n = Math.min(TICKS_PER_ROUTE, Math.floor(len / TICK_SPACING));
    const take = Math.min(n, TICK_CAP - items);
    out.push(take);
    items += take;
  }
  return out;
}
