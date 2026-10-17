/**
 * Floor UI client (T3a, issue #2): Canvas 2D renderer, render-on-demand
 * (zero animation frames while idle), semantic zoom label bands,
 * collapse cap, inspector, minimap, and the ?drive=1 measurement mode.
 */
import { BAND_SIZES, PITCH, type ZoneRect } from "./layout.ts";
import { routeBelts, type RoutedPath } from "./route.ts";
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
      routed: number;
      routeMs: number;
      lanes: number;
      overflow: number;
      degraded: boolean;
      coalesced: number;
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
// Richness exploration (design-shotgun), winner C approved: no flag
// renders C; ?style=a|b kept for comparison, ?style=plain restores
// the pre-exploration look. Belts, lamps, labels, and all status
// language stay identical across variants.
const styleParam = params.get("style");
const styleVariant: "a" | "b" | "c" | null =
  styleParam === "a" || styleParam === "b" || styleParam === "c"
    ? styleParam
    : styleParam === "plain"
      ? null
      : "c";
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

const css = getComputedStyle(document.documentElement);
const color = (name: string) => css.getPropertyValue(name).trim();
function readColors() {
  return {
    floor: color("--floor") || "#20241d",
    surface: color("--surface") || "#2c3128",
    surface2: color("--surface-2") || "#333931",
    surface3: color("--surface-3") || "#3e453b",
    line: color("--line") || "#4a5245",
    well: color("--well") || "#1a1e19",
    text: color("--text") || "#ede8d8",
    muted: color("--muted") || "#a8b09c",
    live: color("--live") || "#46c07a",
    red: color("--red") || "#e5484d",
    amber: color("--amber") || "#e0a437",
  };
}
const COLORS = readColors();
/** Font faces, read once: per-building getPropertyValue costs ~2k
 * DOM calls per frame at the 1,000-block cap. */
const FONT_FALLBACK = {
  label: '"Saira Semi Condensed", "Arial Narrow", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
  display: '"Anton", "Arial Narrow", sans-serif',
};
function readFonts() {
  return {
    label: css.getPropertyValue("--font-label") || FONT_FALLBACK.label,
    mono: css.getPropertyValue("--font-mono") || FONT_FALLBACK.mono,
    display: css.getPropertyValue("--font-display") || FONT_FALLBACK.display,
  };
}
const FONTS = readFonts();
/** The Day toggle swaps the token set under the canvas: re-read. */
function refreshTokens() {
  Object.assign(COLORS, readColors());
  Object.assign(FONTS, readFonts());
}

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
let lastAddressedPrefix = "";
let notice = "";
let rendered = 0;
let drawCount = 0;
window.__frames = { collapsed: [], expanded: [], done: false };
window.__floor = { version: 0, total: 0, rendered: 0, zones: 0, draws: 0, cam: { x: 0, y: 0, scale: 1 } };
window.__belts = { band: "far", belts: 0, aggregates: 0, drawn: 0, isolated: false, endpoints: [], routed: 0, routeMs: 0, lanes: 0, overflow: 0, degraded: false, coalesced: 0 };
window.__search = { query: "", matches: 0, shown: 0, selected: null };

function fitCamera() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (state.zones.length === 0 || w === 0) return;
  const right = Math.max(...state.zones.map((z) => z.x + z.w));
  // Fit-all frames the bus band too (plus its overflow plate when lit).
  const routed = getBeltCache();
  const bottom = Math.max(
    ...state.zones.map((z) => z.y + z.h),
    routed.busBottom + (routed.overflow > 0 ? 48 : 0),
  );
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
// Canvas labels use the loaded faces: repaint once webfonts arrive
// (first paint may use fallback stacks while fonts are in flight).
document.fonts.ready.then(() => requestRender());
// The async font stylesheet can land after fonts.ready resolves;
// keep repainting as late faces arrive, and re-read the stacks.
document.fonts.addEventListener("loadingdone", () => {
  refreshTokens();
  requestRender();
});
window.addEventListener("load", () => {
  refreshTokens();
  requestRender();
});

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

/** Stable string hash for deterministic decoration (window patterns). */
function pathHash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Point at distance d along an orthogonal polyline (clamped). */
function pointAt(pts: [number, number][], d: number): [number, number] {
  let rest = Math.max(0, d);
  for (let i = 1; i < pts.length; i++) {
    const segLen = Math.abs(pts[i]![0] - pts[i - 1]![0]) + Math.abs(pts[i]![1] - pts[i - 1]![1]);
    if (rest <= segLen || segLen === 0) {
      const k = segLen === 0 ? 0 : rest / segLen;
      return [pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * k, pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * k];
    }
    rest -= segLen;
  }
  return pts[pts.length - 1]!;
}


/**
 * Scratch richness variants (design-shotgun, ?style=a|b|c). Status
 * language (lamps, pips, glyphs, labels, ERR, selection) is shared;
 * only the body dressing changes. Skipped in the far band: detail
 * below legibility is noise.
 */
function drawMachineExtras(
  b: Building,
  x: number,
  y: number,
  size: number,
  s: number,
  now: number,
  band: "far" | "mid" | "near",
): void {
  if (styleVariant === null || band === "far") return;
  ctx.save();
  if (styleVariant === "a") {
    // Factorio yard: rivets everywhere, side pipe on M+, feet on L+.
    ctx.fillStyle = COLORS.muted;
    const ri = 3 + 2 * s;
    const rr = Math.max(1, 1.2 * s);
    for (const [rx, ry] of [
      [x + ri, y + ri],
      [x + size - ri, y + ri],
      [x + ri, y + size - ri],
      [x + size - ri, y + size - ri],
    ] as const) {
      ctx.beginPath();
      ctx.arc(rx, ry, rr, 0, Math.PI * 2);
      ctx.fill();
    }
    if (b.band >= 1) {
      ctx.fillStyle = COLORS.line;
      ctx.fillRect(x + size - 7, y + 6, 4, size - 12);
      ctx.fillStyle = COLORS.muted;
      ctx.fillRect(x + size - 8, y + size * 0.3, 6, 3);
      ctx.fillRect(x + size - 8, y + size * 0.62, 6, 3);
    }
    if (b.band >= 2) {
      ctx.fillStyle = COLORS.floor;
      ctx.fillRect(x + 4, y + size - 6, 10, 4);
      ctx.fillRect(x + size - 14, y + size - 6, 10, 4);
    }
    ctx.restore();
    return;
  }
  if (styleVariant === "b") {
    // Skylines district: lit window grids + roof furniture.
    const cols = b.band >= 2 ? 4 : b.band >= 1 ? 3 : 2;
    const rows = b.band >= 2 ? 3 : 2;
    const margin = size * 0.2;
    const gap = size * 0.07;
    const cw = (size - margin * 2 - gap * (cols - 1)) / cols;
    const ch = (size * 0.42 - gap * (rows - 1)) / rows;
    const hash = pathHash(b.path);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const lit = (hash >> ((r * cols + c) % 24)) & 3;
        ctx.fillStyle = lit === 0 ? COLORS.well : COLORS.text;
        ctx.globalAlpha = lit === 0 ? 1 : 0.85;
        ctx.fillRect(margin + x + c * (cw + gap), y + size * 0.24 + r * (ch + gap), cw, ch);
      }
    }
    ctx.globalAlpha = 1;
    if (b.band >= 1) {
      // Antenna mast on the roof.
      ctx.strokeStyle = COLORS.muted;
      ctx.lineWidth = s;
      ctx.beginPath();
      ctx.moveTo(x + size * 0.72, y + 2);
      ctx.lineTo(x + size * 0.72, y - 7);
      ctx.stroke();
      ctx.fillStyle = COLORS.text;
      ctx.fillRect(x + size * 0.72 - s, y - 9 * s, 2 * s, 2 * s);
    }
    if (b.band >= 2) {
      // Rooftop tank.
      ctx.fillStyle = COLORS.surface3;
      ctx.fillRect(x + size * 0.14, y - 8, 14, 8);
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = s;
      ctx.strokeRect(x + size * 0.14, y - 8, 14, 8);
    }
    ctx.restore();
    return;
  }
  // Variant C: endgame life — beacon + smoke on live machines only.
  const pulseStart = pulses.get(b.path);
  if (pulseStart === undefined || reducedMotion || now - pulseStart >= PULSE_MS) {
    ctx.restore();
    return;
  }
  const blink = now % 600 < 300 ? 1 : 0.2;
  ctx.globalAlpha = blink;
  ctx.fillStyle = COLORS.live;
  ctx.beginPath();
  ctx.arc(x + size - 8 * s, y + 8 * s, 2.5 * s, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
  for (let i = 0; i < 3; i++) {
    const age = (now / 900 + i / 3) % 1;
    ctx.globalAlpha = (1 - age) * 0.22;
    ctx.fillStyle = COLORS.muted;
    ctx.beginPath();
    ctx.arc(
      x + size / 2 + Math.sin(age * 5 + i) * 4 * s,
      y - age * 30 * s,
      (3 + age * 5) * s,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Canvas machines (Nightshift Phase 2): square plates, 2px borders,
 * hard offset shadow, 10px status lamps (lit / hollow / red), left
 * connection pips, Saira nameplates per the preview band rules, red
 * ERR tags. Amber appears nowhere here: it is reserved for
 * planned-only ghosts, which need the ghost layer to exist.
 */
function drawBuilding(
  b: Building,
  now: number,
  band: "far" | "mid" | "near",
  maxPips: number,
  alpha = 1,
  // Far-band name priority (large or congested machines stay labeled
  // where the far band hides ordinary names).
  farName = false,
) {
  const size = BAND_SIZES[b.band];
  const inset = (PITCH - size) / 2;
  const x = b.x + inset;
  const y = b.y + inset;
  const s = 1 / camera.scale; // one screen px in world units
  const lw = s;
  const w2 = 2 * s;
  const label = FONTS.label;
  const mono = FONTS.mono;
  ctx.save();
  ctx.globalAlpha = alpha;
  // Hard offset shadow: machines sit ON the pad.
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(x + 4, y + 4, size, size);
  // Body + roof plate.
  ctx.fillStyle = b.binary ? COLORS.surface : COLORS.surface2;
  ctx.fillRect(x, y, size, size);
  if (!b.binary) {
    ctx.fillStyle = COLORS.surface3;
    ctx.fillRect(x + 3, y + 3, size - 6, size - 6);
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = w2;
    ctx.strokeRect(x + 3, y + 3, size - 6, size - 6);
    // Vent slats on M+ machines, a chimney block on L+.
    // (Variant B swaps slats for window grids.)
    if (b.band >= 1 && styleVariant !== "b") {
      ctx.lineWidth = lw;
      ctx.beginPath();
      ctx.moveTo(x + size * 0.32, y + size * 0.38);
      ctx.lineTo(x + size * 0.68, y + size * 0.38);
      ctx.moveTo(x + size * 0.32, y + size * 0.52);
      ctx.lineTo(x + size * 0.68, y + size * 0.52);
      ctx.stroke();
    }
    if (b.band >= 2) {
      ctx.fillStyle = COLORS.floor;
      ctx.fillRect(x + size - 15, y + 6, 8, 8);
      ctx.strokeRect(x + size - 15, y + 6, 8, 8);
    }
    if (size >= 40) drawGlyph(kindOf(b.path), x + size - 14, y + size - 14, 8);
    // File-kind tag, bottom-left on M+ (S machines are too small;
    // their nameplate below carries identity in mid/near).
    if (size >= 40 && band !== "far") {
      const dot = b.path.lastIndexOf(".");
      const ext = (dot === -1 ? "?" : b.path.slice(dot + 1)).toUpperCase().slice(0, 5);
      ctx.fillStyle = COLORS.muted;
      ctx.font = `${9 * s}px ${mono}`;
      ctx.textAlign = "left";
      ctx.fillText(ext, x + 5, y + size - 6);
    }
    // Status lamp, centered near the top: lit = parses, hollow =
    // unparsed, red = parse error.
    ctx.beginPath();
    ctx.arc(x + size / 2, y + 10 * s, 5 * s, 0, Math.PI * 2);
    if (b.parse === "error") {
      ctx.fillStyle = COLORS.red;
      ctx.fill();
    } else if (b.parse === "ok") {
      ctx.fillStyle = COLORS.live;
      ctx.fill();
    } else {
      ctx.fillStyle = COLORS.well;
      ctx.fill();
      ctx.strokeStyle = COLORS.muted;
      ctx.lineWidth = w2;
      ctx.stroke();
    }
    // Connection pips: max of fan-in/fan-out, cap 5, hidden in the
    // far band like the preview. Small machines show what fits.
    if (band !== "far" && maxPips > 0) {
      const fit = Math.max(0, Math.floor((size * camera.scale - 4) / 8));
      const shown = Math.min(maxPips, 5, fit);
      ctx.fillStyle = COLORS.muted;
      for (let i = 0; i < shown; i++) {
        ctx.fillRect(x + 4 * s, y + (4 + i * 8) * s, 4 * s, 4 * s);
      }
    }
    drawMachineExtras(b, x, y, size, s, now, band);
  } else {
    // Binary: hatched + cross-braced crate, no lamp, no pips, no label.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x + 2, y + 2, size - 4, size - 4);
    ctx.clip();
    ctx.globalAlpha = alpha * 0.35;
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = lw;
    ctx.beginPath();
    for (let d = -size; d < size; d += 6 * s) {
      ctx.moveTo(x + d, y + size);
      ctx.lineTo(x + d + size, y);
    }
    ctx.stroke();
    ctx.restore();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = COLORS.line;
    ctx.lineWidth = w2;
    ctx.beginPath();
    ctx.moveTo(x + 2, y + 2);
    ctx.lineTo(x + size - 2, y + size - 2);
    ctx.moveTo(x + size - 2, y + 2);
    ctx.lineTo(x + 2, y + size - 2);
    ctx.stroke();
    // Crates carry no nameplate anywhere, so the kind tag is their
    // only on-floor identity.
    if (size >= 40 && band !== "far") {
      ctx.fillStyle = COLORS.muted;
      ctx.font = `${9 * s}px ${mono}`;
      ctx.textAlign = "left";
      ctx.fillText("BIN", x + 5, y + size - 6);
    }
  }
  if (b.parse === "error") {
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = w2;
    ctx.setLineDash([5 * s, 3 * s]);
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
    ctx.lineWidth = w2;
    ctx.strokeRect(x, y, size, size);
  }
  const pulseStart = pulses.get(b.path);
  if (pulseStart !== undefined && !reducedMotion) {
    const t = (now - pulseStart) / PULSE_MS;
    if (t < 1) {
      ctx.globalAlpha = alpha * (1 - t);
      ctx.strokeStyle = COLORS.live;
      ctx.lineWidth = w2;
      const grow = 3 + t * 5;
      ctx.strokeRect(x - grow, y - grow, size + grow * 2, size + grow * 2);
      ctx.globalAlpha = alpha;
    } else {
      pulses.delete(b.path);
    }
  }
  const selected = b.path === selectedPath;
  if (selected) {
    // Ivory, not green: green is the change ring, and the two must
    // never be confused at a glance.
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = w2;
    ctx.strokeRect(x - 3, y - 3, size + 6, size + 6);
    // SELECTED tag above the machine.
    ctx.font = `600 ${13 * s}px ${label}`;
    const text = "SELECTED";
    const tw = ctx.measureText(text).width;
    const tagH = 18 * s;
    const tagTop = y - 6 * s - tagH;
    ctx.fillStyle = COLORS.text;
    ctx.fillRect(x + size / 2 - tw / 2 - 4 * s, tagTop, tw + 8 * s, tagH);
    ctx.fillStyle = COLORS.floor;
    ctx.textAlign = "center";
    ctx.fillText(text, x + size / 2, tagTop + 14 * s);
  }
  // Nameplates: far hides names except error/selected/priority
  // (large or congested), mid shows all, near adds line counts.
  const showName = !b.binary && (band !== "far" || b.parse === "error" || selected || farName);
  const nameY = y + size + 14 * s;
  if (showName) {
    const name = b.path.slice(b.path.lastIndexOf("/") + 1).toUpperCase();
    ctx.fillStyle = COLORS.muted;
    ctx.font = `600 ${13 * s}px ${label}`;
    ctx.textAlign = "center";
    ctx.fillText(name, x + size / 2, nameY, PITCH - 4);
    if (band === "near") {
      ctx.fillStyle = COLORS.muted;
      ctx.font = `${12 * s}px ${mono}`;
      ctx.fillText(`${b.lines} lines`, x + size / 2, nameY + 14 * s, PITCH - 4);
    }
  }
  if (b.parse === "error") {
    // Red ERR tag under the name (or under the machine where the
    // far band hides the name of a healthy machine — errors always
    // show theirs, so this sits under the name in practice).
    ctx.font = `600 ${13 * s}px ${label}`;
    const text = "ERR";
    const tw = ctx.measureText(text).width;
    const tagH = 18 * s;
    // In the near band the line count sits under the name; the tag
    // clears that row instead of overlapping it.
    const anchor = showName ? nameY + (band === "near" ? 14 * s : 0) : y + size;
    const tagTop = anchor + 6 * s;
    ctx.strokeStyle = COLORS.red;
    ctx.lineWidth = w2;
    ctx.strokeRect(x + size / 2 - tw / 2 - 4 * s, tagTop, tw + 8 * s, tagH);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "center";
    ctx.fillText(text, x + size / 2, tagTop + 14 * s);
  }
  ctx.restore();
}

type Viewport = { x: number; y: number; w: number; h: number };

type BeltCache = {
  version: number;
  belts: BeltEdge[];
  byId: Map<string, Building>;
  inDegree: Map<string, number>;
  /** Pip count per building id: max of fan-in/fan-out, cap 5. */
  pipCounts: Map<string, number>;
  congested: Set<string>;
  zoneById: Map<string, ZoneRect>;
  aggregates: { a: string; b: string; count: number }[];
  /** Orthogonal routes, one per routable edge (route.ts). */
  routes: RoutedPath[];
  /** World y of the deepest bus lane (floor bottom when unlaned). */
  busBottom: number;
  /** Bus lanes in use. */
  lanes: number;
  /** Edges on direct fallback (lane cap or no corridor). */
  overflow: number;
  /** Last route pass duration, ms (perf probe). */
  routeMs: number;
  /** True when the last pass blew the frame budget: chevrons and
   * item ticks are skipped until a cheaper pass lands. */
  degraded: boolean;
};

let beltCache: BeltCache | undefined;
let lastRouteAt = 0;
let coalescedRoutes = 0;
/** Patch bursts re-route at most this often; a catch-up frame follows. */
const ROUTE_MIN_INTERVAL = 250;
/** Route passes slower than this trip the chevron/tick degrade. */
const ROUTE_DEGRADE_MS = 50;
/** Degrade clears only below this: no flicker at the boundary. */
const ROUTE_RECOVER_MS = 35;

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
  // Coalesce patch bursts: serve the last cache while versions keep
  // moving and schedule the catch-up pass (belt/edge ceilings stay
  // with the roadmap P2 scale-ceilings item).
  const nowMs = performance.now();
  if (beltCache && nowMs - lastRouteAt < ROUTE_MIN_INTERVAL) {
    coalescedRoutes++;
    setTimeout(() => requestRender(), ROUTE_MIN_INTERVAL - (nowMs - lastRouteAt));
    return beltCache;
  }
  lastRouteAt = nowMs;
  const byId = new Map<string, Building>();
  for (const b of state.buildings.values()) byId.set(b.id, b);
  const inDegree = new Map<string, number>();
  const outDegree = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const e of state.belts) {
    const from = byId.get(e.fromId);
    const to = byId.get(e.toId);
    if (!from || !to) continue;
    inDegree.set(e.toId, (inDegree.get(e.toId) ?? 0) + 1);
    outDegree.set(e.fromId, (outDegree.get(e.fromId) ?? 0) + 1);
    if (from.zoneId === to.zoneId) continue;
    const key = `${from.zoneId}\0${to.zoneId}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const pipCounts = new Map<string, number>();
  for (const [id, n] of inDegree) pipCounts.set(id, Math.min(5, n));
  for (const [id, n] of outDegree) pipCounts.set(id, Math.min(5, Math.max(n, pipCounts.get(id) ?? 0)));
  const congested = computeCongested(inDegree);
  const zoneById = new Map(state.zones.map((z) => [z.id, z]));
  const aggregates = [...counts].map(([key, count]) => {
    const [a, b] = key.split("\0") as [string, string];
    return { a, b, count };
  });
  const zoneOrder = new Map(state.zones.map((z, i) => [z.id, i]));
  const floorBottom = state.zones.length > 0 ? Math.max(...state.zones.map((z) => z.y + z.h)) : 0;
  const routeStart = performance.now();
  const routed = routeBelts(
    [...state.buildings.values()].map((b) => ({
      id: b.id,
      zoneOrder: zoneOrder.get(b.zoneId) ?? 0,
      x: b.x,
      y: b.y,
      band: b.band,
    })),
    state.belts,
    floorBottom,
  );
  const routeMs = Math.round((performance.now() - routeStart) * 10) / 10;
  beltCache = {
    version: state.version,
    belts: state.belts,
    byId,
    inDegree,
    pipCounts,
    congested,
    zoneById,
    aggregates,
    routes: routed.routes,
    busBottom: routed.busBottom,
    lanes: routed.lanes,
    overflow: routed.overflow,
    routeMs,
    degraded: routeMs > ROUTE_DEGRADE_MS ? true : routeMs < ROUTE_RECOVER_MS ? false : (beltCache?.degraded ?? false),
  };
  return beltCache;
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
 * Zoom-gated belts (orthogonal routing, Nightshift Phase 3), drawn
 * under the machines in the same frame pass. Far shows the zone
 * rollup only; mid and near stroke the version-cached routed paths
 * between rendered buildings (never to machines the block cap cut).
 * A selection isolates its in/out belts. Strokes batch: live flow,
 * steel structure, and dimmed rest cost one stroke each, plus one
 * chevron fill — a thousand belts cost a handful of strokes.
 */
function drawBelts(
  band: "far" | "mid" | "near",
  view: Viewport,
  visibleIds: Set<string>,
  cache: BeltCache,
  isolatedId: string | undefined,
  now: number,
): { aggregates: number; drawn: number; endpoints: [string, string][] } {
  let aggregates = 0;
  let drawn = 0;
  const endpoints: [string, string][] = [];
  const s = 1 / camera.scale;
  if (band === "far") {
    // Orthogonal zone rollup: width buckets keep the count-scaled
    // look, steel for structure, live for pairs touching a recent
    // change or the selection's zone. A selection narrows the
    // rollup to pairs touching its zone.
    const pulsedZones = new Set<string>();
    for (const path of pulses.keys()) {
      const zid = state.buildings.get(path)?.zoneId;
      if (zid !== undefined) pulsedZones.add(zid);
    }
    const isolatedZone = isolatedId !== undefined ? cache.byId.get(isolatedId)?.zoneId : undefined;
    const buckets: { min: number; max: number; width: number }[] = [
      { min: 1, max: 2, width: 1.75 },
      { min: 3, max: 8, width: 4 },
      { min: 9, max: Infinity, width: 6 },
    ];
    for (const { min, max, width } of buckets) {
      for (const live of [true, false] as const) {
        ctx.globalAlpha = live ? 0.5 : 0.3;
        ctx.strokeStyle = live ? COLORS.live : COLORS.muted;
        ctx.lineWidth = width * s;
        ctx.beginPath();
        for (const agg of cache.aggregates) {
          if (agg.count < min || agg.count > max) continue;
          if (isolatedZone !== undefined && agg.a !== isolatedZone && agg.b !== isolatedZone) continue;
          const za = cache.zoneById.get(agg.a);
          const zb = cache.zoneById.get(agg.b);
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
          ctx.moveTo(ax, ay);
          if (Math.abs(ax - bx) > 1 && Math.abs(ay - by) > 1) {
            const mx = (ax + bx) / 2;
            ctx.lineTo(mx, ay);
            ctx.lineTo(mx, by);
          }
          ctx.lineTo(bx, by);
          aggregates++;
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    return { aggregates, drawn, endpoints };
  }
  // Mid and near gate on the rendered set (built once per frame by
  // the caller): in a mega-zone the 1,000-block cap cuts buildings
  // that `expanded` still covers, and belts to unrendered machines
  // would end at empty pad space.
  const pulsedIds = new Set<string>();
  for (const path of pulses.keys()) {
    const id = state.buildings.get(path)?.id;
    if (id !== undefined) pulsedIds.add(id);
  }
  const live: RoutedPath[] = [];
  const struct: RoutedPath[] = [];
  const dimmed: RoutedPath[] = [];
  for (const r of cache.routes) {
    const from = cache.byId.get(r.fromId);
    const to = cache.byId.get(r.toId);
    if (!from || !to || !visibleIds.has(from.id) || !visibleIds.has(to.id)) continue;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [px, py] of r.pts) {
      if (px < x0) x0 = px;
      if (py < y0) y0 = py;
      if (px > x1) x1 = px;
      if (py > y1) y1 = py;
    }
    if (x1 < view.x || x0 > view.x + view.w || y1 < view.y || y0 > view.y + view.h) continue;
    const incident = isolatedId === undefined || r.fromId === isolatedId || r.toId === isolatedId;
    if (!incident) {
      dimmed.push(r);
      continue;
    }
    drawn++;
    endpoints.push([r.fromId, r.toId]);
    (pulsedIds.has(r.fromId) || pulsedIds.has(r.toId) ? live : struct).push(r);
  }
  const trace = (r: RoutedPath): void => {
    ctx.moveTo(r.pts[0]![0], r.pts[0]![1]);
    for (let i = 1; i < r.pts.length; i++) ctx.lineTo(r.pts[i]![0], r.pts[i]![1]);
  };
  // Live flow: dash trains run toward the consumer while the change
  // is fresh (the pulse window already drives frames; idle costs zero).
  if (live.length > 0) {
    ctx.globalAlpha = 0.9;
    ctx.strokeStyle = COLORS.live;
    ctx.lineWidth = 3 * s;
    if (!reducedMotion) {
      ctx.setLineDash([8 * s, 4 * s]);
      ctx.lineDashOffset = -(((now % 1200) / 1200) * 24 * s);
    }
    ctx.beginPath();
    for (const r of live) trace(r);
    ctx.stroke();
    ctx.setLineDash([]);
    // Ivory chevron train on live belts, one batched fill, capped:
    // past a dozen live belts the dashes carry the motion alone.
    // Skipped while degraded: a blown route budget sheds decoration first.
    if (!cache.degraded) {
      ctx.fillStyle = COLORS.text;
      ctx.beginPath();
      for (const r of live.slice(0, 12)) {
        for (const c of r.chev) {
          const dx = Math.cos(c.angle);
          const dy = Math.sin(c.angle);
          ctx.moveTo(c.x + dx * 4 * s, c.y + dy * 4 * s);
          ctx.lineTo(c.x - dx * 4 * s - dy * 5 * s, c.y - dy * 4 * s + dx * 5 * s);
          ctx.lineTo(c.x - dx * 4 * s + dy * 5 * s, c.y - dy * 4 * s - dx * 5 * s);
          ctx.closePath();
        }
      }
      ctx.fill();
    }
    // Variant C: item ticks riding live belts toward the consumer.
    // Live belts exist only inside pulse windows, so idle costs zero.
    if (styleVariant === "c" && !reducedMotion && !cache.degraded) {
      ctx.fillStyle = COLORS.text;
      const spacing = 64;
      const phase = (now * 0.06) % spacing;
      let items = 0;
      for (const r of live) {
        const n = Math.min(3, Math.floor(r.len / spacing));
        for (let k = 0; k < n && items < 48; k++, items++) {
          const [ix, iy] = pointAt(r.pts, k * spacing + phase);
          ctx.fillRect(ix - 2 * s, iy - 2 * s, 4 * s, 4 * s);
        }
        if (items >= 48) break;
      }
    }
  }
  if (struct.length > 0) {
    ctx.globalAlpha = 0.55;
    ctx.strokeStyle = COLORS.muted;
    ctx.lineWidth = 2 * s;
    ctx.beginPath();
    for (const r of struct) trace(r);
    ctx.stroke();
  }
  if (isolatedId !== undefined && dimmed.length > 0) {
    ctx.globalAlpha = 0.06;
    ctx.strokeStyle = COLORS.live;
    ctx.lineWidth = 1.5 * s;
    ctx.beginPath();
    for (const r of dimmed) trace(r);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  return { aggregates, drawn, endpoints };
}

/**
 * Congestion outlines: a double ivory rule on top importers. Amber is
 * reserved for planned-only ghosts (DESIGN.md + nightshift Phase 2),
 * so congestion extends shape instead of hue; the double rule nests
 * outside the single selection outline without touching it.
 */
function drawCongestion(
  view: Viewport,
  cache: BeltCache,
  isolatedId: string | undefined,
  visibleIds: Set<string>,
) {
  if (cache.congested.size === 0) return;
  ctx.strokeStyle = COLORS.text;
  ctx.lineWidth = 2 / camera.scale;
  for (const id of cache.congested) {
    if (isolatedId !== undefined && id !== isolatedId) continue;
    const b = cache.byId.get(id);
    if (!b || !visibleIds.has(b.id)) continue;
    if (b.x + PITCH < view.x || b.x > view.x + view.w || b.y + PITCH < view.y || b.y > view.y + view.h) continue;
    const size = BAND_SIZES[b.band];
    const inset = (PITCH - size) / 2;
    ctx.strokeRect(b.x + inset - 5, b.y + inset - 5, size + 10, size + 10);
    ctx.strokeRect(b.x + inset - 9, b.y + inset - 9, size + 18, size + 18);
  }
}

/** Faint seam grid under everything, culled to view. */
function drawSeams(view: Viewport, lw: number, step: number, alpha: number): void {
  ctx.strokeStyle = COLORS.line;
  ctx.globalAlpha = alpha;
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

/** Alternating slab tint checker, culled to view. */
function drawSlabs(view: Viewport, step: number, alpha: number): void {
  ctx.fillStyle = COLORS.surface;
  ctx.globalAlpha = alpha;
  const x0 = Math.floor(view.x / step);
  const y0 = Math.floor(view.y / step);
  const x1 = Math.ceil((view.x + view.w) / step);
  const y1 = Math.ceil((view.y + view.h) / step);
  for (let gx = x0; gx < x1; gx++) {
    for (let gy = y0; gy < y1; gy++) {
      if ((gx + gy) % 2 === 0) ctx.fillRect(gx * step, gy * step, step, step);
    }
  }
  ctx.globalAlpha = 1;
}

/** X-ordered zones, cached per floor version (zone layout is static). */
let zoneOrderCache: { version: number; zonesRef: ZoneRect[]; zones: ZoneRect[] } | undefined;

/** Scratch ground variants (design-shotgun, ?style=a|b|c). */
function drawGroundVariant(view: Viewport, lw: number): void {
  drawSeams(view, lw, camera.scale < 0.35 ? PITCH * 4 : PITCH, 0.16);
  if (styleVariant === "a") {
    // Concrete slab: tinted checker over the seams.
    drawSlabs(view, PITCH * 2, 0.22);
    return;
  }
  if (styleVariant === "b") {
    // Asphalt + streets in the inter-zone gaps.
    drawSlabs(view, PITCH * 4, 0.28);
    // Identity guard mirrors the belt cache: reconnects reuse version
    // numbers with different content (wire replaces the zones array).
    if (!zoneOrderCache || zoneOrderCache.version !== state.version || zoneOrderCache.zonesRef !== state.zones) {
      zoneOrderCache = { version: state.version, zonesRef: state.zones, zones: [...state.zones].sort((p, q) => p.x - q.x) };
    }
    const ordered = zoneOrderCache.zones;
    const gaps: [number, number][] = [];
    for (let i = 1; i < ordered.length; i++) {
      const gx0 = ordered[i - 1]!.x + ordered[i - 1]!.w;
      const gx1 = ordered[i]!.x;
      if (gx1 - gx0 < 8 || gx1 < view.x || gx0 > view.x + view.w) continue;
      gaps.push([gx0, gx1]);
    }
    ctx.fillStyle = COLORS.well;
    for (const [gx0, gx1] of gaps) ctx.fillRect(gx0, view.y, gx1 - gx0, view.h);
    ctx.strokeStyle = COLORS.muted;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = lw;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    for (const [gx0, gx1] of gaps) {
      const cx = (gx0 + gx1) / 2;
      ctx.moveTo(cx, view.y);
      ctx.lineTo(cx, view.y + view.h);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    return;
  }
  // Variant C: barely-there slab variation; markings live per-zone.
  drawSlabs(view, PITCH * 2, 0.1);
}

/** Big Anton bay sign: navigate by bay signs, not tooltips (DESIGN.md).
 * Hidden while the zone is narrower than ~220 screen px so far-band
 * signs never stack into an unreadable strip; the zone header
 * nameplate carries identity out there. */
function baySign(zone: ZoneRect, px: number): void {
  if (zone.w * camera.scale < 220) return;
  const s = 1 / camera.scale;
  const display = FONTS.display;
  ctx.font = `${px * s}px ${display}`;
  ctx.fillStyle = COLORS.text;
  ctx.globalAlpha = 0.92;
  ctx.textAlign = "left";
  ctx.fillText(zone.name.toUpperCase(), zone.x + 12, zone.y + 56 * s, zone.w - 24);
  ctx.globalAlpha = 1;
}

/** Scratch zone extras (design-shotgun, ?style=a|b|c). */
function drawZoneExtras(zone: ZoneRect, view: Viewport): void {
  if (styleVariant === null) return;
  const s = 1 / camera.scale;
  if (styleVariant === "a") {
    // Hazard ticks along the top edge (ivory/dark, never amber:
    // amber is fenced to abandoned/inferred).
    ctx.fillStyle = COLORS.text;
    ctx.globalAlpha = 0.55;
    const y = zone.y + 3;
    // Clipped to the viewport like the pad seams: a wide
    // partially-visible zone must not pay full-width ticks.
    const step = 16 * s;
    let tx = zone.x + 8;
    if (tx < view.x) tx += Math.ceil((view.x - tx) / step) * step;
    const endTx = Math.min(zone.x + zone.w - 8, view.x + view.w);
    for (; tx < endTx; tx += step) ctx.fillRect(tx, y, 8 * s, 3 * s);
    ctx.globalAlpha = 1;
    baySign(zone, 24);
    return;
  }
  if (styleVariant === "b") {
    // District signage + ivory inner border.
    baySign(zone, 22);
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = COLORS.text;
    ctx.lineWidth = s;
    ctx.strokeRect(zone.x + 4, zone.y + 4, zone.w - 8, zone.h - 8);
    ctx.globalAlpha = 1;
    return;
  }
  // Variant C: bay sign + painted walkway along the pad bottom.
  baySign(zone, 24);
  ctx.strokeStyle = COLORS.line;
  ctx.globalAlpha = 0.6;
  ctx.lineWidth = s;
  ctx.beginPath();
  ctx.moveTo(zone.x + 10, zone.y + zone.h - 16 * s);
  ctx.lineTo(zone.x + zone.w - 10, zone.y + zone.h - 16 * s);
  ctx.moveTo(zone.x + 10, zone.y + zone.h - 10 * s);
  ctx.lineTo(zone.x + zone.w - 10, zone.y + zone.h - 10 * s);
  const c = 12 * s;
  ctx.moveTo(zone.x + 6, zone.y + 6 + c);
  ctx.lineTo(zone.x + 6, zone.y + 6);
  ctx.lineTo(zone.x + 6 + c, zone.y + 6);
  ctx.moveTo(zone.x + zone.w - 6 - c, zone.y + 6);
  ctx.lineTo(zone.x + zone.w - 6, zone.y + 6);
  ctx.lineTo(zone.x + zone.w - 6, zone.y + 6 + c);
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function draw(ts = performance.now()) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = COLORS.floor;
  ctx.fillRect(0, 0, w, h);
  ctx.setTransform(dpr * camera.scale, 0, 0, dpr * camera.scale, dpr * camera.x, dpr * camera.y);

  const view = worldViewport();
  const visible = currentVisible();
  rendered = visible.count;
  const band = zoomBand();
  const mono = FONTS.mono;
  const label = FONTS.label;
  const lw = 1 / camera.scale;

  // Ground treatment (variant-swapped; default = faint plate seams).
  if (styleVariant === null) {
    drawSeams(view, lw, camera.scale < 0.35 ? PITCH * 4 : PITCH, 0.16);
  } else {
    drawGroundVariant(view, lw);
  }

  for (const zone of visible.zones) {
    if (zone.x + zone.w < view.x || zone.x > view.x + view.w || zone.y + zone.h < view.y || zone.y > view.y + view.h) continue;
    const open = expanded.has(zone.id);
    // Concrete production pad with a lit top edge.
    ctx.fillStyle = COLORS.surface;
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
    ctx.font = `600 ${11.5 / camera.scale}px ${label}`;
    const tw = ctx.measureText(plateText).width;
    const plateH = 20 / camera.scale;
    const plateW = tw + 18 / camera.scale;
    ctx.fillStyle = COLORS.amber;
    ctx.fillRect(zone.x + 8, zone.y + 7, 3.5 / camera.scale, plateH);
    ctx.fillStyle = COLORS.surface2;
    ctx.fillRect(zone.x + 8 + 3.5 / camera.scale, zone.y + 7, plateW, plateH);
    ctx.strokeStyle = COLORS.line;
    ctx.strokeRect(zone.x + 8, zone.y + 7, plateW + 3.5 / camera.scale, plateH);
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.fillText(plateText, zone.x + 18 / camera.scale, zone.y + 7 + plateH * 0.72);
    drawZoneExtras(zone, view);
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
  const beltDrawn = drawBelts(band, view, visibleIds, belts, isolatedId, ts);

  for (const b of visible.buildings) {
    if (b.x + PITCH < view.x || b.x > view.x + view.w || b.y + PITCH < view.y || b.y > view.y + view.h) continue;
    drawBuilding(b, ts, band, belts.pipCounts.get(b.id) ?? 0, 1, b.band >= 2 || belts.congested.has(b.id));
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
  // Bus overflow says so honestly (Phase 3): past the lane cap (or
  // with no clear corridor) edges fall back to direct routing, and
  // the floor names the cut instead of hiding it.
  if (belts.overflow > 0 && state.zones.length > 0) {
    const left = Math.min(...state.zones.map((z) => z.x));
    const right = Math.max(...state.zones.map((z) => z.x + z.w));
    const text = `+${belts.overflow} simplified — lane cap`;
    ctx.font = `${12 / camera.scale}px ${mono}`;
    const tw = ctx.measureText(text).width;
    const padX = 8 / camera.scale;
    const plateW = tw + padX * 2;
    const plateH = 20 / camera.scale;
    const px = (left + right) / 2 - plateW / 2;
    const py = belts.busBottom + 12 / camera.scale;
    if (!(px + plateW < view.x || px > view.x + view.w || py + plateH < view.y || py > view.y + view.h)) {
      ctx.fillStyle = COLORS.surface2;
      ctx.fillRect(px, py, plateW, plateH);
      ctx.strokeStyle = COLORS.line;
      ctx.lineWidth = lw;
      ctx.strokeRect(px, py, plateW, plateH);
      ctx.fillStyle = COLORS.muted;
      ctx.textAlign = "left";
      ctx.fillText(text, px + padX, py + plateH * 0.72);
    }
  }
  for (const [path, f] of fading) {
    const t = (ts - f.start) / FADE_MS;
    if (t >= 1 || reducedMotion) {
      fading.delete(path);
      continue;
    }
    drawBuilding(f.building, ts, band, belts.pipCounts.get(f.building.id) ?? 0, 1 - t);
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
    routed: belts.routes.length,
    routeMs: belts.routeMs,
    lanes: belts.lanes,
    overflow: belts.overflow,
    degraded: belts.degraded,
    coalesced: coalescedRoutes,
  };
}

function drawMinimap(view: { x: number; y: number; w: number; h: number }) {
  const { width, height } = minimap;
  mctx.setTransform(1, 0, 0, 1, 0, 0);
  mctx.fillStyle = COLORS.surface;
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
  mctx.strokeStyle = COLORS.live;
  mctx.strokeRect(view.x * s, view.y * s, view.w * s, view.h * s);
}

let lastZoomLabel = "";
function updateStatus() {
  $("status-count").textContent = `${rendered} of ${state.total} machines`;
  $("status-watcher").textContent = `watcher: ${state.watcher}`;
  $("status-notice").textContent = notice;
  $("status-version").textContent = state.version > 0 ? `v${state.version}` : "";
  $("last-change").textContent = lastChange ? `last change: ${lastChange.text} · ${ago(lastChange.ts)}` : "";
  // The zoom readout lives in the minimap plate; guard the write so
  // idle frames (pulses, drive mode) don't churn the DOM each draw.
  const zl = `${Math.round(camera.scale * 100)}%`;
  if (zl !== lastZoomLabel) {
    lastZoomLabel = zl;
    $("zoomLabel").textContent = zl;
  }
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

const promptInput = $("prompt") as HTMLInputElement;

function selectBuilding(path: string | undefined) {
  selectedPath = path;
  window.__search = { ...window.__search, selected: path ?? null };
  const b = path ? state.buildings.get(path) : undefined;
  showInspector(b);
  requestPreview(b);
  // Address the dispatch console at the selection (preview behavior);
  // sending still needs a ghost session and says so out loud.
  if (b) {
    // Address the dispatch console only when it holds no composed
    // text: clicking machines to inspect must never clobber a prompt.
    // Tracks the last auto-written address (paths may contain spaces).
    const prefix = `@${b.path} `;
    if (!promptInput.value || promptInput.value === lastAddressedPrefix) {
      promptInput.value = prefix;
      lastAddressedPrefix = prefix;
    }
  }
  requestRender();
}

/** Center the camera on a machine, keeping the current scale. */
function centerOn(b: Building) {
  camera.x = canvas.clientWidth / 2 - (b.x + PITCH / 2) * camera.scale;
  camera.y = canvas.clientHeight / 2 - (b.y + PITCH / 2) * camera.scale;
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
  centerOn(b);
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
// --- chrome (Nightshift Phase 1: port of the reviewed preview) ---------
// Worker chip, Follow, inspector drawer + handle, legend sheet,
// minimap zoom, dispatch stub, Day toggle, one-sheet-at-a-time
// exclusivity on phones, Escape cascades. Same values, breakpoints,
// and aria patterns as the preview; the canvas keeps its own camera.
const floorMain = $("floor-main");
let followOn = false;
let followTarget: string | undefined;

function jumpToRecent() {
  const newest = newestBuilding();
  if (newest) centerOn(newest);
}

$("workerBtn").addEventListener("click", jumpToRecent);
$("followBtn").addEventListener("click", (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  followOn = btn.getAttribute("aria-pressed") !== "true";
  btn.setAttribute("aria-pressed", String(followOn));
  if (followOn) jumpToRecent();
});

$("drawerHandle").addEventListener("click", () => $("inspBtn").click());
$("inspBtn").addEventListener("click", (e) => {
  const mobile = window.matchMedia("(max-width:900px)").matches;
  const open = mobile ? floorMain.classList.toggle("show-insp") : !floorMain.classList.toggle("no-insp");
  (e.currentTarget as HTMLButtonElement).setAttribute("aria-expanded", String(open));
  ($("drawerHandle") as HTMLButtonElement).setAttribute("aria-expanded", String(open));
  if (open && mobile) {
    // one sheet at a time: opening the overlay drawer dismisses
    // legend + map (session-only)
    $("legend").style.display = "none";
    $("dockBtn").setAttribute("aria-expanded", "false");
    document.querySelector(".minimap")!.classList.add("collapsed");
    $("mmCollapse").setAttribute("aria-expanded", "false");
  }
});

const store = {
  get(k: string): string | null {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k: string, v: string) {
    try {
      localStorage.setItem(k, v);
    } catch {
      // private mode: session-only
    }
  },
};

$("legendClose").addEventListener("click", () => {
  $("legend").style.display = "none";
  $("dockBtn").setAttribute("aria-expanded", "false");
  $("dockBtn").focus();
  store.set("artifex-legend", "hidden");
});
$("dockBtn").addEventListener("click", (e) => {
  const legend = $("legend");
  const hidden =
    legend.style.display === "none" ||
    (legend.style.display === "" && getComputedStyle(legend).display === "none");
  legend.style.display = hidden ? "block" : "none";
  (e.currentTarget as HTMLButtonElement).setAttribute("aria-expanded", String(hidden));
  store.set("artifex-legend", hidden ? "shown" : "hidden");
  if (hidden && narrowStrip()) {
    // one sheet at a time on phones: opening the legend collapses
    // the minimap
    document.querySelector(".minimap")!.classList.add("collapsed");
    $("mmCollapse").setAttribute("aria-expanded", "false");
  }
});

$("mmCollapse").addEventListener("click", (e) => {
  const collapsed = document.querySelector(".minimap")!.classList.toggle("collapsed");
  (e.currentTarget as HTMLButtonElement).setAttribute("aria-expanded", String(!collapsed));
  if (!collapsed && narrowStrip()) {
    // one sheet at a time on phones: expanding the map dismisses
    // the legend (session-only)
    $("legend").style.display = "none";
    $("dockBtn").setAttribute("aria-expanded", "false");
  }
});

function stepZoom(factor: number) {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  // Zoom around the viewport center (same clamp as wheel zoom).
  const wx = (w / 2 - camera.x) / camera.scale;
  const wy = (h / 2 - camera.y) / camera.scale;
  const next = Math.min(4, Math.max(0.05, camera.scale * factor));
  camera.x = w / 2 - wx * next;
  camera.y = h / 2 - wy * next;
  camera.scale = next;
  requestRender();
}
$("zoomIn").addEventListener("click", () => stepZoom(1.25));
$("zoomOut").addEventListener("click", () => stepZoom(1 / 1.25));
$("zoomLabel").addEventListener("click", () => {
  fitCamera();
  requestRender();
});

// Dispatch without a ghost layer: SEND is never a silent no-op.
function dispatchStub() {
  notice = "Dispatch needs an agent session — no agent connected.";
  requestRender();
}
$("dispatchSend").addEventListener("click", dispatchStub);
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") dispatchStub();
});

// Theme (dark normative; toggle previews Dayshift).
const themeBtn = $("themeBtn") as HTMLButtonElement;
const narrowStrip = () => window.matchMedia("(max-width:640px)").matches;
function setThemeLabel() {
  themeBtn.textContent =
    document.documentElement.dataset.theme === "light" ? "Night" : narrowStrip() ? "Day" : "Day (preview)";
}
themeBtn.addEventListener("click", () => {
  const el = document.documentElement;
  el.dataset.theme = el.dataset.theme === "dark" ? "light" : "dark";
  setThemeLabel();
  refreshTokens();
  requestRender();
});

function syncInsp() {
  const narrow900 = window.matchMedia("(max-width:900px)").matches;
  const narrow640 = window.matchMedia("(max-width:640px)").matches;
  if (narrow640 || !narrow900) floorMain.classList.remove("show-insp");
  const open = narrow900 ? floorMain.classList.contains("show-insp") : !floorMain.classList.contains("no-insp");
  $("inspBtn").setAttribute("aria-expanded", String(open));
  $("drawerHandle").setAttribute("aria-expanded", String(open));
}
window.matchMedia("(max-width:640px)").addEventListener("change", () => {
  setThemeLabel();
  const narrow = narrowStrip();
  if (narrow) {
    followOn = false;
    $("followBtn").setAttribute("aria-pressed", "false");
  }
  syncInsp();
  if (!narrow) return;
  const legendOpen = getComputedStyle($("legend")).display !== "none";
  const mapOpen = !document.querySelector(".minimap")!.classList.contains("collapsed");
  if (legendOpen && mapOpen) {
    document.querySelector(".minimap")!.classList.add("collapsed");
    $("mmCollapse").setAttribute("aria-expanded", "false");
  }
});
window.matchMedia("(max-width:900px)").addEventListener("change", () => syncInsp());
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  // Inputs own Escape (search closes its list); sheets only when the
  // focus isn't in an editable control.
  const target = e.target as Element | null;
  if (target?.closest?.("input, textarea, select, [contenteditable=\"true\"]")) return;
  const narrow900 = window.matchMedia("(max-width:900px)").matches;
  const narrow640 = window.matchMedia("(max-width:640px)").matches;
  if (narrow900 && floorMain.classList.contains("show-insp")) {
    $("inspBtn").click();
    $("inspBtn").focus();
    return;
  }
  if (!narrow640) return;
  // one sheet at a time: dismiss the topmost phone sheet, legend
  // before map
  if (getComputedStyle($("legend")).display !== "none") {
    $("legendClose").click();
    return;
  }
  if (!document.querySelector(".minimap")!.classList.contains("collapsed")) {
    $("mmCollapse").click();
  }
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
      // Worker chip shows the watch state until ghost sessions exist:
      // watching, with no agent — never a fake worker.
      $("conn-state").textContent = "watch · no agent";
      $("workerBtn").classList.remove("disconnected");
      break;
    case "snapshot": {
      applySnapshot(state, msg);
      // The building map is empty until the first snapshot: searching
      // earlier would report "no matches" for files that exist.
      if (searchInput.disabled) {
        searchInput.disabled = false;
        searchInput.removeAttribute("title");
      }
      $("repo-name").textContent = state.repo;
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
      followTarget = undefined;
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
        followTarget = r.to;
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
        followTarget = b.path;
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
      // Follow tracks real file changes (deletes clear the target:
      // the building is gone, so there's nothing to center on).
      if (followOn && followTarget) {
        const target = state.buildings.get(followTarget);
        if (target) centerOn(target);
      }
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
    $("conn-state").textContent = "reconnecting…";
    $("workerBtn").classList.add("disconnected");
    if (event.code === 4001) {
      // Server restarted with a fresh token: reload once to pick it
      // up, but never loop if auth keeps failing.
      const last = Number(sessionStorage.getItem("artifex-auth-reload") ?? 0);
      if (Date.now() - last > 10_000) {
        sessionStorage.setItem("artifex-auth-reload", String(Date.now()));
        location.reload();
      } else {
        $("conn-state").textContent = "auth failed — reload";
      }
      return;
    }
    setTimeout(connect, 1000);
  };
}

// Chrome init (preview port): legend persistence, narrow/phone
// defaults, inspector state sync.
$("legend").style.display = store.get("artifex-legend") === "hidden" ? "none" : "block";
$("dockBtn").setAttribute("aria-expanded", String(getComputedStyle($("legend")).display !== "none"));
setThemeLabel();
if (narrowStrip()) {
  followOn = false;
  $("followBtn").setAttribute("aria-pressed", "false");
  document.querySelector(".minimap")!.classList.add("collapsed");
  $("mmCollapse").setAttribute("aria-expanded", "false");
}
syncInsp();

resizeCanvas();
connect();

