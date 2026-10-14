/**
 * Floor UI client (T3a, issue #2): Canvas 2D renderer, render-on-demand
 * (zero animation frames while idle), semantic zoom label bands,
 * collapse cap, inspector, minimap, and the ?drive=1 measurement mode.
 */
import { BAND_SIZES, PITCH, type ZoneRect } from "./layout.ts";
import { searchBuildings } from "./search.ts";
import { computeVisible } from "./visible.ts";
import { MAX_PARSE_BYTES } from "../parser/protocol.ts";
import {
  WIRE_VERSION,
  applyPatch,
  applySnapshot,
  computeCongested,
  createClientState,
  isCountsOnlyChange,
  type BeltEdge,
  type Building,
  type ClientMessage,
  type ServerMessage,
} from "./wire.ts";

declare global {
  interface Window {
    __ARTIFEX_TOKEN__: string;
    __frames: { collapsed: number[]; expanded: number[]; done: boolean };
    __floor: {
      version: number;
      total: number;
      rendered: number;
      zones: number;
      draws: number;
      cam: { x: number; y: number; scale: number };
    };
    __belts: {
      band: string;
      belts: number;
      aggregates: number;
      drawn: number;
      isolated: boolean;
      endpoints: [string, string][];
    };
    __search: {
      query: string;
      matches: number;
      shown: number;
      selected: string | null;
    };
  }
}

const PULSE_MS = 1_400;
const FADE_MS = 300;
const params = new URLSearchParams(location.search);
const driveMode = params.get("drive") === "1";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const css = getComputedStyle(document.documentElement);
const color = (name: string) => css.getPropertyValue(name).trim();
const COLORS = {
  surface0: color("--surface-0") || "#14171c",
  surface1: color("--surface-1") || "#1b1f26",
  surface2: color("--surface-2") || "#232936",
  line: color("--line") || "#3a4150",
  text: color("--text-primary") || "#dde4ee",
  muted: color("--text-muted") || "#93a0b4",
  accent: color("--accent") || "#5ec8b4",
  error: color("--error") || "#e0605a",
  hazard: color("--hazard") || "#c9a227",
  roof: color("--surface-3") || "#2e3747",
};

const canvas = document.getElementById("floor") as HTMLCanvasElement;
const ctx = canvas.getContext("2d")!;
const minimap = document.getElementById("minimap") as HTMLCanvasElement;
const mctx = minimap.getContext("2d")!;
const $ = (id: string) => document.getElementById(id)!;

const state = createClientState();
const camera = { x: 0, y: 0, scale: 1 };
let fitted = false;
const expanded = new Set<string>();
const pulses = new Map<string, number>(); // path -> start ts
const fading = new Map<string, { building: Building; start: number }>();
let selectedPath: string | undefined;
let notice = "";
let rendered = 0;
let drawCount = 0;
window.__frames = { collapsed: [], expanded: [], done: false };
window.__floor = { version: 0, total: 0, rendered: 0, zones: 0, draws: 0, cam: { x: 0, y: 0, scale: 1 } };
window.__belts = { band: "far", belts: 0, aggregates: 0, drawn: 0, isolated: false, endpoints: [] };
window.__search = { query: "", matches: 0, shown: 0, selected: null };

function fitCamera() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (state.zones.length === 0 || w === 0) return;
  const right = Math.max(...state.zones.map((z) => z.x + z.w));
  const bottom = Math.max(...state.zones.map((z) => z.y + z.h));
  camera.scale = Math.min(1, w / (right + 24), h / (bottom + 24));
  camera.x = 0;
  camera.y = 0;
  fitted = true;
}

let lastChange: { text: string; ts: number } | undefined;

function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

function newestBuilding(): Building | undefined {
  let newest: Building | undefined;
  for (const b of state.buildings.values()) {
    if (!newest || b.mtimeMs > newest.mtimeMs) newest = b;
  }
  return newest;
}

/**
 * First-run landing: close on the pad with the most recent file
 * change, that pad expanded (design D8). Fit-all stays for drive mode.
 */
function landOnRecent() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (state.zones.length === 0 || w === 0) return;
  const newest = newestBuilding();
  const zone = state.zones.find((z) => z.id === newest?.zoneId) ?? state.zones[0]!;
  expanded.add(zone.id);
  if (newest) lastChange = { text: newest.path, ts: newest.mtimeMs };
  camera.scale = Math.min(1, Math.max(0.3, Math.min(w / (zone.w + 220), h / (zone.h + 220))));
  camera.x = w / 2 - (zone.x + zone.w / 2) * camera.scale;
  camera.y = Math.min(24, h / 2 - (zone.y + zone.h / 2) * camera.scale) + 12;
  fitted = true;
}

function resizeCanvas() {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  requestRender();
}
new ResizeObserver(resizeCanvas).observe(canvas);

// --- render scheduling: on demand only -------------------------------
let rafId: number | undefined;
function animating(now: number): boolean {
  if (driveActive) return true;
  if (reducedMotion) return false;
  for (const start of pulses.values()) if (now - start < PULSE_MS) return true;
  for (const f of fading.values()) if (now - f.start < FADE_MS) return true;
  return false;
}
function requestRender() {
  if (rafId !== undefined) return;
  rafId = requestAnimationFrame((ts) => {
    rafId = undefined;
    draw(ts);
    if (animating(ts)) requestRender();
  });
}

function worldViewport() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  return {
    x: -camera.x / camera.scale,
    y: -camera.y / camera.scale,
    w: w / camera.scale,
    h: h / camera.scale,
  };
}

/** Render set from live client state (cap lives in visible.ts). */
function currentVisible() {
  return computeVisible({
    zones: state.zones,
    buildings: [...state.buildings.values()],
    expanded,
    selectedPath,
  });
}

function zoomBand(): "far" | "mid" | "near" {
  if (camera.scale < 0.5) return "far";
  if (camera.scale <= 1.25) return "mid";
  return "near";
}

type BuildingKind = "test" | "doc" | "config" | "code";

function kindOf(path: string): BuildingKind {
  if (/(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)test_[^/]*$|_test\.)/.test(path)) return "test";
  if (/\.(md|mdx|txt|rst|adoc)$/.test(path)) return "doc";
  if (/\.(json|jsonc|toml|ya?ml|ini|cfg|lock)$/.test(path) || /(^|\/)\.(env|gitignore|editorconfig)/.test(path)) return "config";
  return "code";
}

/** Tiny geometric kind glyph in the machine's bottom-right corner. */
function drawGlyph(kind: BuildingKind, x: number, y: number, s: number) {
  if (kind === "code") return;
  ctx.strokeStyle = COLORS.muted;
  ctx.lineWidth = 1.2 / camera.scale;
  ctx.beginPath();
  if (kind === "test") {
    // flask: small triangle with a neck
    ctx.moveTo(x + s * 0.4, y);
    ctx.lineTo(x + s * 0.6, y);
    ctx.lineTo(x + s, y + s);
    ctx.lineTo(x, y + s);
    ctx.closePath();
  } else if (kind === "doc") {
    ctx.moveTo(x, y + s * 0.25);
    ctx.lineTo(x + s, y + s * 0.25);
    ctx.moveTo(x, y + s * 0.6);
    ctx.lineTo(x + s * 0.7, y + s * 0.6);
  } else {
    // config: square with a center dot
    ctx.rect(x, y, s, s);
    ctx.moveTo(x + s * 0.5 + 1, y + s * 0.5);
    ctx.arc(x + s * 0.5, y + s * 0.5, Math.max(1, s * 0.14), 0, Math.PI * 2);
  }
  ctx.stroke();
}

function drawBuilding(b: Building, now: number, band: "far" | "mid" | "near", alpha = 1) {
  const size = BAND_SIZES[b.band];
  const inset = (PITCH - size) / 2;
  const x = b.x + inset;
  const y = b.y + inset;
  const lw = 1 / camera.scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Drop shadow: machines sit ON the pad.
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(x + 3, y + 4, size, size);
  // Body + beveled roof plate.
  ctx.fillStyle = b.binary ? COLORS.surface1 : COLORS.surface2;
  ctx.fillRect(x, y, size, size);
  if (!b.binary) {
    ctx.fillStyle = COLORS.roof;
    ctx.fillRect(x + 3, y + 3, size - 6, size - 6);
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = lw;
    ctx.strokeRect(x + 3, y + 3, size - 6, size - 6);
    // Vent slats on M+ machines, a chimney block on L+.
    if (b.band >= 1) {
      ctx.beginPath();
      ctx.moveTo(x + size * 0.32, y + size * 0.38);
      ctx.lineTo(x + size * 0.68, y + size * 0.38);
      ctx.moveTo(x + size * 0.32, y + size * 0.52);
      ctx.lineTo(x + size * 0.68, y + size * 0.52);
      ctx.stroke();
    }
    if (b.band >= 2) {
      ctx.fillStyle = COLORS.surface0;
      ctx.fillRect(x + size - 15, y + 6, 8, 8);
      ctx.strokeRect(x + size - 15, y + 6, 8, 8);
    }
    if (size >= 40) drawGlyph(kindOf(b.path), x + size - 14, y + size - 14, 8);
    // Status lamp: teal = parses, red = parse error, dim = unparsed.
    ctx.fillStyle = b.parse === "error" ? COLORS.error : b.parse === "ok" ? COLORS.accent : COLORS.muted;
    ctx.beginPath();
    ctx.arc(x + 8, y + 8, Math.max(2.4, 2.4 / camera.scale), 0, Math.PI * 2);
    ctx.fill();
  } else {
    // Binary: cross-braced crate, no lamp, no label.
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 2);
    ctx.lineTo(x + size - 2, y + size - 2);
    ctx.moveTo(x + size - 2, y + 2);
    ctx.lineTo(x + 2, y + size - 2);
    ctx.stroke();
  }
  if (b.parse === "error") {
    ctx.strokeStyle = COLORS.error;
    ctx.lineWidth = 1.5 / camera.scale;
    ctx.setLineDash([5 / camera.scale, 3 / camera.scale]);
    ctx.strokeRect(x, y, size, size);
    ctx.setLineDash([]);
    // crack
    ctx.beginPath();
    ctx.moveTo(x + size * 0.15, y + 2);
    ctx.lineTo(x + size * 0.45, y + size * 0.4);
    ctx.lineTo(x + size * 0.3, y + size * 0.62);
    ctx.lineTo(x + size * 0.6, y + size - 2);
    ctx.stroke();
  } else {
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = 1 / camera.scale;
    ctx.strokeRect(x, y, size, size);
  }
  const pulseStart = pulses.get(b.path);
  if (pulseStart !== undefined && !reducedMotion) {
    const t = (now - pulseStart) / PULSE_MS;
    if (t < 1) {
      ctx.globalAlpha = alpha * (1 - t);
      ctx.strokeStyle = COLORS.accent;
      ctx.lineWidth = 2 / camera.scale;
      const grow = 3 + t * 5;
      ctx.strokeRect(x - grow, y - grow, size + grow * 2, size + grow * 2);
      ctx.globalAlpha = alpha;
    } else {
      pulses.delete(b.path);
    }
  }
  if (b.path === selectedPath) {
    ctx.strokeStyle = COLORS.accent;
    ctx.lineWidth = 2 / camera.scale;
    ctx.strokeRect(x - 3, y - 3, size + 6, size + 6);
  }
  const showLabel =
    !b.binary &&
    (band === "near" || (band === "mid" && (b.band >= 2 || pulses.has(b.path))));
  if (showLabel) {
    const name = b.path.slice(b.path.lastIndexOf("/") + 1);
    ctx.fillStyle = COLORS.muted;
    ctx.font = `${11 / camera.scale}px ${css.getPropertyValue("--font-mono")}`;
    ctx.textAlign = "center";
    ctx.fillText(name, x + size / 2, y + size + 14 / camera.scale, PITCH - 4);
  }
  ctx.restore();
}

type Viewport = { x: number; y: number; w: number; h: number };

type BeltCache = {
  version: number;
  belts: BeltEdge[];
  byId: Map<string, Building>;
  inDegree: Map<string, number>;
  congested: Set<string>;
  zoneById: Map<string, ZoneRect>;
  aggregates: { a: string; b: string; count: number }[];
};

let beltCache: BeltCache | undefined;

/**
 * Belt derived data, recomputed only when the floor version moves
 * (snapshot or patch — never per frame). The frame pass only culls
 * and strokes from this cache.
 */
function getBeltCache(): BeltCache {
  // The belts-array identity guards reconnects: a restarted server
  // reuses version numbers with different content, and a version
  // key alone would serve the stale cache.
  if (beltCache && beltCache.version === state.version && beltCache.belts === state.belts) return beltCache;
  const byId = new Map<string, Building>();
  for (const b of state.buildings.values()) byId.set(b.id, b);
  const inDegree = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const e of state.belts) {
    const from = byId.get(e.fromId);
    const to = byId.get(e.toId);
    if (!from || !to) continue;
    inDegree.set(e.toId, (inDegree.get(e.toId) ?? 0) + 1);
    if (from.zoneId === to.zoneId) continue;
    const key = `${from.zoneId}\0${to.zoneId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const congested = computeCongested(inDegree);
  const zoneById = new Map(state.zones.map((z) => [z.id, z]));
  const aggregates = [...counts].map(([key, count]) => {
    const [a, b] = key.split("\0") as [string, string];
    return { a, b, count };
  });
  beltCache = { version: state.version, belts: state.belts, byId, inDegree, congested, zoneById, aggregates };
  return beltCache;
}

function machineCenter(b: Building): { x: number; y: number } {
  return { x: b.x + PITCH / 2, y: b.y + PITCH / 2 };
}

function segmentVisible(ax: number, ay: number, bx: number, by: number, view: Viewport): boolean {
  return !(
    Math.max(ax, bx) < view.x ||
    Math.min(ax, bx) > view.x + view.w ||
    Math.max(ay, by) < view.y ||
    Math.min(ay, by) > view.y + view.h
  );
}

/**
 * Zoom-gated belts (T3b, issue #3), drawn under the machines in the
 * same frame pass. Far shows zone-to-zone rollup only; mid and
 * near show building belts between rendered buildings (never to
 * machines the block cap cut). A selection isolates its in/out belts.
 * Strokes batch: one path per width bucket or alpha class, so a
 * thousand belts cost a handful of strokes, not a thousand.
 */
function drawBelts(
  band: "far" | "mid" | "near",
  view: Viewport,
  visibleIds: Set<string>,
  cache: BeltCache,
  isolatedId: string | undefined,
): { aggregates: number; drawn: number; endpoints: [string, string][] } {
  let aggregates = 0;
  let drawn = 0;
  const endpoints: [string, string][] = [];
  ctx.strokeStyle = COLORS.accent;
  if (band === "far") {
    // Width buckets keep the count-scaled look with 3 strokes. A
    // selection narrows the rollup to pairs touching its zone.
    const isolatedZone = isolatedId !== undefined ? cache.byId.get(isolatedId)?.zoneId : undefined;
    const buckets: { min: number; max: number; width: number }[] = [
      { min: 1, max: 2, width: 1.75 },
      { min: 3, max: 8, width: 4 },
      { min: 9, max: Infinity, width: 6 },
    ];
    for (const { min, max, width } of buckets) {
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = width / camera.scale;
      ctx.beginPath();
      for (const agg of cache.aggregates) {
        if (agg.count < min || agg.count > max) continue;
        if (isolatedZone !== undefined && agg.a !== isolatedZone && agg.b !== isolatedZone) continue;
        const za = cache.zoneById.get(agg.a);
        const zb = cache.zoneById.get(agg.b);
        if (!za || !zb) continue;
        const ax = za.x + za.w / 2;
        const ay = za.y + za.h / 2;
        const bx = zb.x + zb.w / 2;
        const by = zb.y + zb.h / 2;
        if (!segmentVisible(ax, ay, bx, by, view)) continue;
        ctx.moveTo(ax, ay);
        ctx.lineTo(bx, by);
        aggregates++;
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    return { aggregates, drawn, endpoints };
  }
  // Mid and near both gate on the rendered set (built once per
  // frame by the caller): in a mega-zone the 1,000-block cap cuts
  // buildings that `expanded` still covers, and belts to unrendered
  // machines would end at empty pad space.
  const endpointOk = (b: Building): boolean => visibleIds.has(b.id);
  ctx.lineWidth = 1.5 / camera.scale;
  // Two passes, two strokes: incident belts, then dimmed rest.
  for (const pass of [true, false] as const) {
    if (pass === false && isolatedId === undefined) break;
    ctx.globalAlpha = pass ? 0.4 : 0.06;
    ctx.beginPath();
    for (const e of state.belts) {
      const from = cache.byId.get(e.fromId);
      const to = cache.byId.get(e.toId);
      if (!from || !to || !endpointOk(from) || !endpointOk(to)) continue;
      const incident = isolatedId === undefined || e.fromId === isolatedId || e.toId === isolatedId;
      if (incident !== pass) continue;
      const a = machineCenter(from);
      const c = machineCenter(to);
      if (!segmentVisible(a.x, a.y, c.x, c.y, view)) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      if (incident) {
        drawn++;
        endpoints.push([e.fromId, e.toId]);
      }
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return { aggregates, drawn, endpoints };
}

/** Congestion outlines: one hazard treatment on top importers. */
function drawCongestion(
  view: Viewport,
  cache: BeltCache,
  isolatedId: string | undefined,
  visibleIds: Set<string>,
) {
  if (cache.congested.size === 0) return;
  ctx.strokeStyle = COLORS.hazard;
  ctx.lineWidth = 2 / camera.scale;
  for (const id of cache.congested) {
    if (isolatedId !== undefined && id !== isolatedId) continue;
    const b = cache.byId.get(id);
    if (!b || !visibleIds.has(b.id)) continue;
    if (b.x + PITCH < view.x || b.x > view.x + view.w || b.y + PITCH < view.y || b.y > view.y + view.h) continue;
    const size = BAND_SIZES[b.band];
    const inset = (PITCH - size) / 2;
    ctx.strokeRect(b.x + inset - 3, b.y + inset - 3, size + 6, size + 6);
  }
}

function draw(ts = performance.now()) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.surface0;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale, dpr * camera.x, dpr * camera.y);

  const view = worldViewport();
  const visible = currentVisible();
  rendered = visible.count;
  const band = zoomBand();
  const mono = css.getPropertyValue("--font-mono");
  const lw = 1 / camera.scale;

  // Plated factory floor: faint seams under everything, culled to view.
  {
    const step = camera.scale < 0.35 ? PITCH * 4 : PITCH;
    ctx.strokeStyle = COLORS.line;
    ctx.globalAlpha = 0.16;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let gx = Math.floor(view.x / step) * step; gx < view.x + view.w; gx += step) {
      ctx.moveTo(gx, view.y);
      ctx.lineTo(gx, view.y + view.h);
    }
    for (let gy = Math.floor(view.y / step) * step; gy < view.y + view.h; gy += step) {
      ctx.moveTo(view.x, gy);
      ctx.lineTo(view.x + view.w, gy);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  for (const zone of visible.zones) {
    if (zone.x + zone.w < view.x || zone.x > view.x + view.w || zone.y + zone.h < view.y || zone.y > view.y + view.h) continue;
    const open = expanded.has(zone.id);
    // Concrete production pad with a lit top edge.
    ctx.fillStyle = COLORS.surface1;
    ctx.fillRect(zone.x, zone.y, zone.w, zone.h);
    ctx.fillStyle = COLORS.surface2;
    ctx.fillRect(zone.x, zone.y, zone.w, 2 / camera.scale + 1);
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = lw;
    ctx.strokeRect(zone.x, zone.y, zone.w, zone.h);
    // Slot seams inside the pad, clipped to the viewport so a huge
    // pad cannot turn seam drawing into an unbounded loop.
    ctx.save();
    ctx.globalAlpha = 0.3;
    ctx.beginPath();
    const seamTop = Math.max(zone.y + 40, view.y);
    const seamBottom = Math.min(zone.y + zone.h - 8, view.y + view.h);
    const seamLeft = Math.max(zone.x + 10, view.x);
    const seamRight = Math.min(zone.x + zone.w - 10, view.x + view.w);
    const firstGx = zone.x + 12 + PITCH;
    const startGx = firstGx < view.x ? firstGx + Math.ceil((view.x - firstGx) / PITCH) * PITCH : firstGx;
    for (let gx = startGx; gx < Math.min(zone.x + zone.w - 12, view.x + view.w); gx += PITCH) {
      ctx.moveTo(gx, seamTop);
      ctx.lineTo(gx, seamBottom);
    }
    const firstGy = zone.y + 40 + PITCH;
    const startGy = firstGy < view.y ? firstGy + Math.ceil((view.y - firstGy) / PITCH) * PITCH : firstGy;
    for (let gy = startGy; gy < Math.min(zone.y + zone.h - 8, view.y + view.h); gy += PITCH) {
      ctx.moveTo(seamLeft, gy);
      ctx.lineTo(seamRight, gy);
    }
    ctx.stroke();
    ctx.restore();
    // Stenciled nameplate: hazard tab + plate + NAME · count.
    const plateText = `${open ? "▾" : "▸"} ${zone.name.toUpperCase()} · ${zone.fileCount}`;
    ctx.font = `600 ${11.5 / camera.scale}px ${mono}`;
    const tw = ctx.measureText(plateText).width;
    const plateH = 20 / camera.scale;
    const plateW = tw + 18 / camera.scale;
    ctx.fillStyle = COLORS.hazard;
    ctx.fillRect(zone.x + 8, zone.y + 7, 3.5 / camera.scale, plateH);
    ctx.fillStyle = COLORS.surface2;
    ctx.fillRect(zone.x + 8 + 3.5 / camera.scale, zone.y + 7, plateW, plateH);
    ctx.strokeStyle = COLORS.line;
    ctx.strokeRect(zone.x + 8, zone.y + 7, plateW + 3.5 / camera.scale, plateH);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.fillText(plateText, zone.x + 18 / camera.scale, zone.y + 7 + plateH * 0.72);
    if (!open) {
      ctx.fillStyle = COLORS.muted;
      ctx.font = `${12 / camera.scale}px ${mono}`;
      ctx.textAlign = "center";
      ctx.fillText(`${zone.fileCount} machines — click pad to expand`, zone.x + zone.w / 2, zone.y + zone.h / 2 + 20, zone.w - 24);
    }
  }

  const belts = getBeltCache();
  const isolatedId = selectedPath ? state.buildings.get(selectedPath)?.id : undefined;
  const visibleIds = new Set(visible.buildings.map((b) => b.id));
  const beltDrawn = drawBelts(band, view, visibleIds, belts, isolatedId);

  for (const b of visible.buildings) {
    if (b.x + PITCH < view.x || b.x > view.x + view.w || b.y + PITCH < view.y || b.y > view.y + view.h) continue;
    drawBuilding(b, ts, band);
  }
  // Capped pads say so honestly (T4): the cut hides real machines,
  // and search is the way to reach them. Drawn after the machines
  // on a plate, so the bottom rows never cover the hint.
  for (const [zoneId, hidden] of visible.hiddenByZone) {
    const zone = visible.zones.find((z) => z.id === zoneId);
    if (!zone) continue;
    const text = `+${hidden} hidden — search to find`;
    ctx.font = `${12 / camera.scale}px ${mono}`;
    const tw = ctx.measureText(text).width;
    const padX = 8 / camera.scale;
    const plateW = tw + padX * 2;
    const plateH = 20 / camera.scale;
    const px = zone.x + zone.w / 2 - plateW / 2;
    const py = zone.y + zone.h - plateH - 8 / camera.scale;
    if (px + plateW < view.x || px > view.x + view.w || py + plateH < view.y || py > view.y + view.h) continue;
    ctx.fillStyle = COLORS.surface2;
    ctx.fillRect(px, py, plateW, plateH);
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = lw;
    ctx.strokeRect(px, py, plateW, plateH);
    ctx.fillStyle = COLORS.muted;
    ctx.textAlign = "left";
    ctx.fillText(text, px + padX, py + plateH * 0.72);
  }
  for (const [path, f] of fading) {
    const t = (ts - f.start) / FADE_MS;
    if (t >= 1 || reducedMotion) {
      fading.delete(path);
      continue;
    }
    drawBuilding(f.building, ts, band, 1 - t);
  }
  drawCongestion(view, belts, isolatedId, visibleIds);

  drawMinimap(view);
  updateStatus();
  drawCount += 1;
  window.__floor = {
    version: state.version,
    total: state.total,
    rendered,
    zones: state.zones.length,
    draws: drawCount,
    cam: { x: camera.x, y: camera.y, scale: camera.scale },
  };
  window.__belts = {
    band,
    belts: state.belts.length,
    aggregates: beltDrawn.aggregates,
    drawn: beltDrawn.drawn,
    isolated: isolatedId !== undefined,
    endpoints: beltDrawn.endpoints,
  };
}

function drawMinimap(view: { x: number; y: number; w: number; h: number }) {
  const { width, height } = minimap;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.fillStyle = COLORS.surface1;
  mctx.fillRect(0, 0, width, height);
  if (state.zones.length === 0) return;
  const right = Math.max(...state.zones.map((z) => z.x + z.w));
  const bottom = Math.max(...state.zones.map((z) => z.y + z.h));
  const s = Math.min(width / right, height / bottom);
  mctx.strokeStyle = COLORS.line;
  mctx.fillStyle = COLORS.surface2;
  for (const z of state.zones) {
    mctx.fillRect(z.x * s, z.y * s, Math.max(2, z.w * s), Math.max(2, z.h * s));
    mctx.strokeRect(z.x * s, z.y * s, Math.max(2, z.w * s), Math.max(2, z.h * s));
  }
  mctx.strokeStyle = COLORS.accent;
  mctx.strokeRect(view.x * s, view.y * s, view.w * s, view.h * s);
}

function updateStatus() {
  $("status-count").textContent = `${rendered} of ${state.total} machines`;
  $("status-watcher").textContent = `watcher: ${state.watcher}`;
  $("status-notice").textContent = notice;
  $("status-version").textContent = state.version > 0 ? `v${state.version}` : "";
  $("last-change").textContent = lastChange ? `last change: ${lastChange.text} · ${ago(lastChange.ts)}` : "";
}
// The canvas is render-on-demand, but the relative timestamp must
// still age while idle; refresh status text only (no draw).
setInterval(updateStatus, 30_000);

// --- inspector ---------------------------------------------------------
const BAND_NAMES = ["S (<100 lines)", "M (100–499)", "L (500–1999)", "XL (≥2000)"];

let inspectorPath: string | undefined;

function showInspector(b: Building | undefined) {
  $("inspector-empty").hidden = b !== undefined;
  $("inspector-body").hidden = b === undefined;
  if (!b) {
    inspectorPath = undefined;
    return;
  }
  const sameBuilding = inspectorPath === b.path;
  inspectorPath = b.path;
  $("insp-path").textContent = b.path;
  $("insp-lines").textContent = b.binary ? "— (binary)" : String(b.lines);
  $("insp-bytes").textContent = String(b.bytes);
  $("insp-band").textContent = BAND_NAMES[b.band]!;
  $("insp-parse").textContent = b.binary ? "binary file, no preview" : b.parse;
  let beltIn = 0;
  let beltOut = 0;
  for (const e of state.belts) {
    if (e.toId === b.id) beltIn++;
    if (e.fromId === b.id) beltOut++;
  }
  $("insp-belts").textContent = `${beltIn} / ${beltOut}`;
  $("insp-unresolved").textContent = String(b.unresolvedCount);
  const err = $("insp-error");
  err.hidden = !b.parseError;
  err.textContent = b.parseError ?? "";
  const note = $("insp-note");
  note.hidden = b.parse !== "unparsed" || b.binary;
  note.textContent =
    b.parse === "unparsed" && !b.binary
      ? b.bytes > MAX_PARSE_BYTES
        ? "Too large to parse (>1 MiB); rendered solid."
        : "Not parsed (parser unavailable); rendered solid."
      : "";
  // Refreshing metadata for the same building must not blank its
  // preview; only a different selection hides stale content.
  if (!sameBuilding) ($("insp-content") as HTMLPreElement).hidden = true;
}

function requestPreview(b: Building | undefined) {
  if (b && !b.binary) sendMessage({ v: WIRE_VERSION, type: "open-file", path: b.path });
}

// Trailing-edge coalescing for patch-driven preview refreshes:
// editing the selected file re-requests at most once per 300 ms.
// Selection changes use requestPreview directly (immediate).
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let previewQueued: Building | undefined;
function requestPreviewSoon(b: Building | undefined) {
  previewQueued = b;
  if (previewTimer !== undefined) return;
  previewTimer = setTimeout(() => {
    previewTimer = undefined;
    const queued = previewQueued;
    previewQueued = undefined;
    requestPreview(queued);
  }, 300);
}

function selectBuilding(path: string | undefined) {
  selectedPath = path;
  window.__search = { ...window.__search, selected: path ?? null };
  const b = path ? state.buildings.get(path) : undefined;
  showInspector(b);
  requestPreview(b);
  requestRender();
}

// --- search (T4 escape hatch: every machine reachable by path) -----
const searchInput = $("search") as HTMLInputElement;
const searchResults = $("search-results") as HTMLOListElement;
let searchActive = -1;

function closeSearchList() {
  searchResults.hidden = true;
  searchResults.replaceChildren();
  searchActive = -1;
  searchInput.setAttribute("aria-expanded", "false");
  searchInput.removeAttribute("aria-activedescendant");
  window.__search = { query: searchInput.value, matches: 0, shown: 0, selected: selectedPath ?? null };
}

function renderSearchList() {
  const query = searchInput.value;
  if (query.trim().length === 0) {
    closeSearchList();
    return;
  }
  const { shown, total } = searchBuildings([...state.buildings.values()], query);
  if (searchActive >= shown.length) searchActive = shown.length - 1;
  searchResults.replaceChildren();
  searchResults.hidden = false;
  searchInput.setAttribute("aria-expanded", "true");
  if (searchActive >= 0) searchInput.setAttribute("aria-activedescendant", `search-opt-${searchActive}`);
  else searchInput.removeAttribute("aria-activedescendant");
  const head = document.createElement("li");
  head.className = "search-count";
  head.setAttribute("role", "presentation");
  head.textContent =
    total === 0
      ? "no matches"
      : shown.length < total
        ? `${shown.length} of ${total} matches`
        : total === 1
          ? "1 match"
          : `${total} matches`;
  searchResults.append(head);
  shown.forEach((b, i) => {
    const li = document.createElement("li");
    li.id = `search-opt-${i}`;
    li.setAttribute("role", "option");
    li.setAttribute("aria-selected", String(i === searchActive));
    if (i === searchActive) li.classList.add("active");
    li.textContent = b.path;
    li.addEventListener("pointerdown", (e) => {
      // pointerdown, not click: the input's blur closes the list
      // before click would fire.
      e.preventDefault();
      jumpTo(b.path);
    });
    searchResults.append(li);
  });
  window.__search = { query, matches: total, shown: shown.length, selected: selectedPath ?? null };
}

/** Expand the zone, center the machine at a legible scale, select it. */
function jumpTo(path: string) {
  const b = state.buildings.get(path);
  if (!b) return;
  expanded.add(b.zoneId);
  camera.scale = Math.min(4, Math.max(camera.scale, 1.5));
  camera.x = canvas.clientWidth / 2 - (b.x + PITCH / 2) * camera.scale;
  camera.y = canvas.clientHeight / 2 - (b.y + PITCH / 2) * camera.scale;
  searchInput.value = "";
  closeSearchList();
  selectBuilding(path);
}

searchInput.addEventListener("input", () => {
  searchActive = -1;
  renderSearchList();
});
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    const { shown } = searchBuildings([...state.buildings.values()], searchInput.value);
    if (shown.length === 0) return;
    searchActive =
      e.key === "ArrowDown"
        ? (searchActive + 1) % shown.length
        : (searchActive - 1 + shown.length) % shown.length;
    renderSearchList();
  } else if (e.key === "Enter") {
    const { shown } = searchBuildings([...state.buildings.values()], searchInput.value);
    const target = shown[searchActive] ?? shown[0];
    if (target) jumpTo(target.path);
  } else if (e.key === "Escape") {
    closeSearchList();
  }
});
searchInput.addEventListener("blur", () => closeSearchList());

/** A snapshot or patch can change the match set under an open list. */
function refreshSearch() {
  if (!searchResults.hidden) renderSearchList();
}

// --- interaction -------------------------------------------------------
function toWorld(clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect();
  const sx = clientX - rect.left;
  const sy = clientY - rect.top;
  return { x: (sx - camera.x) / camera.scale, y: (sy - camera.y) / camera.scale, sx, sy };
}

let drag: { startX: number; startY: number; camX: number; camY: number; moved: boolean } | undefined;

canvas.addEventListener("pointerdown", (e) => {
  notice = "";
  drag = { startX: e.clientX, startY: e.clientY, camX: camera.x, camY: camera.y, moved: false };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.startX;
  const dy = e.clientY - drag.startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
  if (drag.moved) {
    camera.x = drag.camX + dx;
    camera.y = drag.camY + dy;
    requestRender();
  }
});
canvas.addEventListener("pointerup", (e) => {
  canvas.classList.remove("dragging");
  const wasDrag = drag?.moved;
  drag = undefined;
  if (wasDrag) return;
  const p = toWorld(e.clientX, e.clientY);
  const visible = currentVisible();
  for (const b of visible.buildings) {
    const size = BAND_SIZES[b.band];
    const inset = (PITCH - size) / 2;
    if (p.x >= b.x + inset && p.x <= b.x + inset + size && p.y >= b.y + inset && p.y <= b.y + inset + size) {
      selectBuilding(b.path);
      return;
    }
  }
  for (const zone of visible.zones) {
    if (p.x >= zone.x && p.x <= zone.x + zone.w && p.y >= zone.y && p.y <= zone.y + zone.h) {
      if (expanded.has(zone.id)) expanded.delete(zone.id);
      else expanded.add(zone.id);
      requestRender();
      return;
    }
  }
  selectBuilding(undefined);
});
canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  notice = "";
  const p = toWorld(e.clientX, e.clientY);
  const factor = Math.exp(-e.deltaY * 0.0015);
  const next = Math.min(4, Math.max(0.05, camera.scale * factor));
  camera.x = p.sx - p.x * next;
  camera.y = p.sy - p.y * next;
  camera.scale = next;
  requestRender();
}, { passive: false });

$("expand-all").addEventListener("click", () => {
  for (const z of state.zones) expanded.add(z.id);
  requestRender();
});
$("collapse-all").addEventListener("click", () => {
  expanded.clear();
  requestRender();
});
$("relayout").addEventListener("click", () => {
  sendMessage({ v: WIRE_VERSION, type: "relayout" });
});
$("legend-toggle").addEventListener("click", () => {
  const legend = $("legend");
  const open = legend.hidden;
  legend.hidden = !open;
  ($("legend-toggle") as HTMLButtonElement).setAttribute("aria-expanded", String(open));
});

// --- drive mode (?drive=1): fixed camera path, frame times ------------
let driveActive = false;

function startDrive() {
  if (!driveMode || driveActive || state.zones.length === 0) return;
  driveActive = true;
  fitCamera();
  const right = Math.max(...state.zones.map((z) => z.x + z.w));
  const largest = [...state.zones].sort((a, b) => b.fileCount - a.fileCount)[0]!;
  const center = { x: largest.x + largest.w / 2, y: largest.y + largest.h / 2 };
  const baseScale = Math.max(camera.scale, 0.6);
  const vw = canvas.clientWidth;
  const vh = canvas.clientHeight;
  const runs: ("collapsed" | "expanded")[] = ["collapsed", "expanded"];
  let runIndex = 0;
  let runStart: number | undefined;
  let last: number | undefined;

  const step = (ts: number) => {
    if (!driveActive) return;
    runStart ??= ts;
    last ??= ts;
    const frames = window.__frames[runs[runIndex]!];
    if (ts > last) frames.push(ts - last);
    last = ts;
    const t = (ts - runStart) / 1000; // seconds into this 10 s run
    if (t < 2) {
      camera.scale = baseScale;
      camera.x = 0;
      camera.y = 0;
    } else if (t < 6) {
      const k = (t - 2) / 4;
      camera.scale = baseScale;
      camera.x = k * Math.min(0, vw - right * baseScale);
      camera.y = 0;
    } else if (t < 10) {
      const cycle = ((t - 6) % 2) / 2; // 0..1 twice
      const tri = cycle < 0.5 ? cycle * 2 : 2 - cycle * 2;
      camera.scale = 0.25 + tri * (2 - 0.25);
      camera.x = vw / 2 - center.x * camera.scale;
      camera.y = vh / 2 - center.y * camera.scale;
    } else {
      runIndex++;
      runStart = undefined;
      last = undefined;
      if (runIndex >= runs.length) {
        driveActive = false;
        window.__frames.done = true;
        fitCamera();
        requestRender();
        return;
      }
      for (const z of state.zones) expanded.add(z.id);
    }
    // Draw through the single render loop (one draw per frame).
    requestRender();
    requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

// --- websocket -----------------------------------------------------------
let ws: WebSocket | undefined;

function sendMessage(msg: ClientMessage) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "auth-ok":
      $("conn-state").textContent = "live · no agent connected — watching files";
      break;
    case "snapshot": {
      applySnapshot(state, msg);
      // The building map is empty until the first snapshot: searching
      // earlier would report "no matches" for files that exist.
      if (searchInput.disabled) {
        searchInput.disabled = false;
        searchInput.removeAttribute("title");
      }
      $("repo-name").textContent = `artifex · ${state.repo}`;
      if (!fitted && !driveMode) landOnRecent();
      if (selectedPath) {
        const selected = state.buildings.get(selectedPath);
        showInspector(selected);
        requestPreview(selected);
      }
      refreshSearch();
      requestRender();
      startDrive();
      break;
    }
    case "patch": {
      const now = performance.now();
      const byId = new Map([...state.buildings.values()].map((b) => [b.id, b]));
      let changeText: string | undefined;
      for (const id of msg.remove) {
        const b = byId.get(id);
        if (b) {
          if (!reducedMotion) {
            fading.set(b.path, { building: b, start: now });
            // Capped like pulses: draw drains this map, and draw
            // stops while the tab is hidden.
            if (fading.size > 20) {
              const oldest = [...fading.entries()].sort((a, c) => a[1].start - c[1].start)[0]!;
              fading.delete(oldest[0]);
            }
          }
          changeText = `${b.path} deleted`;
        }
      }
      for (const r of msg.rename) {
        if (selectedPath === r.from) selectedPath = r.to;
        changeText = `${r.from} → ${r.to}`;
        const p = pulses.get(r.from);
        if (p !== undefined) {
          pulses.delete(r.from);
          pulses.set(r.to, p);
        }
      }
      const prevByPath = new Map(state.buildings);
      const result = applyPatch(state, msg);
      if (result === "gap") {
        sendMessage({ v: WIRE_VERSION, type: "resync" });
        break;
      }
      let showedSelected = false;
      for (const b of msg.upsert) {
        // A counts-only upsert (belt refresh on an untouched file)
        // is not a change: no pulse, no last-change line, and no
        // preview re-request for identical content.
        if (isCountsOnlyChange(prevByPath.get(b.path), b)) {
          if (b.path === selectedPath) {
            showInspector(b);
            showedSelected = true;
          }
          continue;
        }
        changeText = b.path;
        pulses.set(b.path, now);
        if (pulses.size > 20) {
          const oldest = [...pulses.entries()].sort((a, c) => a[1] - c[1])[0]!;
          pulses.delete(oldest[0]);
        }
        if (b.path === selectedPath) {
          showInspector(b);
          showedSelected = true;
          requestPreviewSoon(b);
        }
      }
      // A belts-only patch changes the selected file's in/out counts
      // without upserting it: refresh the inspector rows (the
      // sameBuilding guard keeps the preview, so this never refetches).
      if (msg.belts !== undefined && selectedPath !== undefined && !showedSelected) {
        const sel = state.buildings.get(selectedPath);
        if (sel) showInspector(sel);
      }
      if (changeText) lastChange = { text: changeText, ts: Date.now() };
      if (selectedPath && !state.buildings.has(selectedPath)) showInspector(undefined);
      refreshSearch();
      requestRender();
      break;
    }
    case "file-content": {
      if (msg.path !== selectedPath) break;
      const pre = $("insp-content") as HTMLPreElement;
      pre.textContent = msg.content;
      pre.hidden = false;
      const note = $("insp-note");
      const notes = [
        msg.masked ? "Secret-looking values are masked." : "",
        msg.truncated ? "Preview truncated at 256 KB." : "",
      ].filter(Boolean);
      note.hidden = notes.length === 0;
      note.textContent = notes.join(" ");
      break;
    }
    case "notice":
      notice = msg.text;
      requestRender();
      break;
    case "error":
      notice = msg.message;
      requestRender();
      break;
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onopen = () => {
    sendMessage({ v: WIRE_VERSION, type: "auth", token: window.__ARTIFEX_TOKEN__ });
  };
  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      if (msg && msg.v === WIRE_VERSION) handleServerMessage(msg);
    } catch {
      // ignore malformed frames; server is the only sender
    }
  };
  ws.onclose = (event) => {
    $("conn-state").textContent = "disconnected";
    if (event.code === 4001) {
      // Server restarted with a fresh token: reload once to pick it
      // up, but never loop if auth keeps failing.
      const last = Number(sessionStorage.getItem("artifex-auth-reload") ?? 0);
      if (Date.now() - last > 10_000) {
        sessionStorage.setItem("artifex-auth-reload", String(Date.now()));
        location.reload();
      } else {
        $("conn-state").textContent = "disconnected — auth failed; reload the page";
      }
      return;
    }
    setTimeout(connect, 1000);
  };
}

resizeCanvas();
connect();

