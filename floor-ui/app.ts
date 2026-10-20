/**
 * Floor UI client (T3a, issue #2): Canvas 2D renderer, render-on-demand
 * (zero animation frames while idle), semantic zoom label bands,
 * collapse cap, inspector, minimap, and the ?drive=1 measurement mode.
 */
import { BAND_SIZES, PITCH, type ZoneRect } from "./layout.ts";
import {
  bboxOfPts,
  boxVisible,
  centerOnBuilding,
  clampZoom,
  computeLanding,
  fitCameraState,
  jumpScale,
  minimapScale,
  segmentVisible,
  toWorldPoint,
  wheelFactor,
  worldViewport,
  zoomAround,
  zoomBand,
} from "./camera.ts";
import {
  ROUTE_MIN_INTERVAL,
  TICK_SPACING,
  aggregateZones,
  classifyAggregates,
  classifyRoutes,
  countDegrees,
  countPips,
  degradeStep,
  needsReroute,
  routableBuildings,
  shouldCoalesce,
  tickCounts,
} from "./belts-view.ts";
import { planPatch } from "./feed.ts";
import {
  ago,
  connectionSections,
  farNamePriority,
  inspectorRows,
  kindOf,
  newestBuilding,
  nextAddress,
  pathHash,
  pipShown,
  pointAt,
  previewStale,
  searchHeadline,
  shortName,
  showName,
  whyNoteSection,
  type BuildingKind,
} from "./machines.ts";
import { routeBelts, type RoutedPath } from "./route.ts";
import { renderRunDetail, renderRunsList } from "./runs.ts";
import { searchBuildings } from "./search.ts";
import { computeVisible } from "./visible.ts";
import {
  WIRE_VERSION,
  applyPatch,
  applySnapshot,
  computeCongested,
  createClientState,
  type BeltEdge,
  type Building,
  type ClientMessage,
  type GhostBuilding,
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
      ghosts: number;
      agent: string;
      runs: number;
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
    __trace: {
      path: string | null;
      markdown: string;
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
window.__floor = { version: 0, total: 0, rendered: 0, zones: 0, draws: 0, ghosts: 0, agent: "idle", runs: 0, cam: { x: 0, y: 0, scale: 1 } };
window.__belts = { band: "far", belts: 0, aggregates: 0, drawn: 0, isolated: false, endpoints: [], routed: 0, routeMs: 0, lanes: 0, overflow: 0, degraded: false, coalesced: 0 };
window.__search = { query: "", matches: 0, shown: 0, selected: null };
window.__trace = { path: null, markdown: "" };

function fitCamera() {
  // Fit-all frames the bus band too (plus its overflow plate when lit).
  const routed = getBeltCache();
  const c = fitCameraState(canvas.clientWidth, canvas.clientHeight, state.zones, routed.busBottom, routed.overflow);
  if (!c) return;
  camera.scale = c.scale;
  camera.x = c.x;
  camera.y = c.y;
  fitted = true;
}

let lastChange: { text: string; ts: number } | undefined;

// ago + newestBuilding live in machines.ts (coverage slice 1).

/**
 * First-run landing: close on the pad with the most recent file
 * change, that pad expanded (design D8). Fit-all stays for drive mode.
 */
function landOnRecent() {
  const c = computeLanding(state.zones, state.buildings.values(), canvas.clientWidth, canvas.clientHeight);
  if (!c) return;
  expanded.add(c.zoneId);
  if (c.lastChange) lastChange = c.lastChange;
  camera.scale = c.scale;
  camera.x = c.x;
  camera.y = c.y;
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

// worldViewport lives in camera.ts (coverage slice 2).

/** Render set from live client state (cap lives in visible.ts). */
function currentVisible() {
  return computeVisible({
    zones: state.zones,
    buildings: [...state.buildings.values()],
    expanded,
    selectedPath,
  });
}

// zoomBand lives in camera.ts (coverage slice 2).

// BuildingKind + kindOf live in machines.ts (coverage slice 1).

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

// pathHash + pointAt live in machines.ts (coverage slice 1).


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
 * Ghost layer (DESIGN.md): a planned ghost is a dashed amber
 * outline, flat by rule — no roof plate, no shadow, no lamp. Fill
 * carries provenance (translucent = intended, not yet real);
 * outline carries health (dashed = abandoned once the plan is
 * dropped). A ghost naming an existing building draws only the
 * dashed outline around it: the machine is real, the intent is
 * what is ghostly.
 */
function drawGhost(g: GhostBuilding) {
  const s = 1 / camera.scale;
  const building = state.buildings.get(g.path);
  const size = building ? BAND_SIZES[building.band] : BAND_SIZES[1];
  const inset = (PITCH - size) / 2;
  const x = (building ? building.x : g.x) + inset;
  const y = (building ? building.y : g.y) + inset;
  ctx.save();
  if (g.state === "abandoned") ctx.globalAlpha = 0.55;
  if (!building && g.state === "planned") {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = COLORS.surface2;
    ctx.fillRect(x, y, size, size);
    ctx.globalAlpha = 1;
  }
  ctx.strokeStyle = COLORS.amber;
  ctx.lineWidth = 1.5 * s;
  ctx.setLineDash([5 * s, 4 * s]);
  ctx.strokeRect(x - 2.5 * s, y - 2.5 * s, size + 5 * s, size + 5 * s);
  ctx.setLineDash([]);
  if (!building) {
    // Same nameplate placement as machines: Saira label under box.
    ctx.font = `600 ${10.5 / camera.scale}px ${FONTS.label}`;
    ctx.textAlign = "center";
    ctx.fillStyle = COLORS.text;
    const name = g.path.split("/").pop() ?? g.path;
    ctx.fillText(name, x + size / 2, y + size + 13 / camera.scale, PITCH - 4);
    ctx.font = `${9.5 / camera.scale}px ${FONTS.mono}`;
    ctx.fillStyle = COLORS.amber;
    ctx.fillText(g.state === "abandoned" ? "abandoned" : "planned", x + size / 2, y + size + 24 / camera.scale, PITCH - 4);
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
    const shown = pipShown(size, camera.scale, maxPips, band);
    ctx.fillStyle = COLORS.muted;
    for (let i = 0; i < shown; i++) {
      ctx.fillRect(x + 4 * s, y + (4 + i * 8) * s, 4 * s, 4 * s);
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
  const nameVisible = showName({ binary: b.binary, band, parse: b.parse, selected, farName });
  const nameY = y + size + 14 * s;
  if (nameVisible) {
    const name = shortName(b.path);
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
    const anchor = nameVisible ? nameY + (band === "near" ? 14 * s : 0) : y + size;
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
// ROUTE_* live in belts-view.ts (coverage slice 3).

/**
 * Belt derived data, recomputed only when the floor version moves
 * (snapshot or patch — never per frame). The frame pass only culls
 * and strokes from this cache.
 */
function getBeltCache(): BeltCache {
  // The belts-array identity guards reconnects: a restarted server
  // reuses version numbers with different content, and a version
  // key alone would serve the stale cache.
  if (beltCache && !needsReroute(beltCache, state.version, state.belts)) return beltCache;
  // Coalesce patch bursts: serve the last cache while versions keep
  // moving and schedule the catch-up pass (belt/edge ceilings stay
  // with the roadmap P2 scale-ceilings item).
  const nowMs = performance.now();
  if (beltCache && shouldCoalesce(lastRouteAt, nowMs)) {
    coalescedRoutes++;
    setTimeout(() => requestRender(), ROUTE_MIN_INTERVAL - (nowMs - lastRouteAt));
    return beltCache;
  }
  lastRouteAt = nowMs;
  const { byId, inDegree, outDegree } = countDegrees(state.buildings.values(), state.belts);
  const pipCounts = countPips(inDegree, outDegree);
  const congested = computeCongested(inDegree);
  const zoneById = new Map(state.zones.map((z) => [z.id, z]));
  const aggregates = aggregateZones(byId, state.belts);
  const routable = routableBuildings(state.buildings.values(), state.zones);
  const routeStart = performance.now();
  const routed = routeBelts(routable.list, state.belts, routable.floorBottom);
  const routeMs = Math.round((performance.now() - routeStart) * 10) / 10;
  const wasDegraded = beltCache?.degraded ?? false;
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
    degraded: degradeStep(routeMs, wasDegraded),
  };
  return beltCache;
}

// segmentVisible lives in camera.ts (coverage slice 2).

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
    for (const lane of classifyAggregates(cache.aggregates, cache.zoneById, pulsedZones, isolatedZone, view)) {
      ctx.globalAlpha = lane.live ? 0.5 : 0.3;
      ctx.strokeStyle = lane.live ? COLORS.live : COLORS.muted;
      ctx.lineWidth = lane.width * s;
      ctx.beginPath();
      for (const agg of lane.aggs) {
        // Both zones exist: the classifier drops pairs with a missing zone.
        const za = cache.zoneById.get(agg.a)!;
        const zb = cache.zoneById.get(agg.b)!;
        const ax = za.x + za.w / 2;
        const ay = za.y + za.h / 2;
        const bx = zb.x + zb.w / 2;
        const by = zb.y + zb.h / 2;
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
  const cls = classifyRoutes(cache.routes, cache.byId, visibleIds, isolatedId, pulsedIds, view);
  const { live, struct, dimmed } = cls;
  drawn = cls.drawn;
  endpoints.push(...cls.endpoints);
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
      const spacing = TICK_SPACING;
      const phase = (now * 0.06) % spacing;
      const counts = tickCounts(live.map((r) => r.len));
      live.forEach((r, i) => {
        for (let k = 0; k < counts[i]!; k++) {
          const [ix, iy] = pointAt(r.pts, k * spacing + phase);
          ctx.fillRect(ix - 2 * s, iy - 2 * s, 4 * s, 4 * s);
        }
      });
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
    if (!boxVisible(b.x, b.y, b.x + PITCH, b.y + PITCH, view)) continue;
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

  const view = worldViewport(camera, canvas.clientWidth, canvas.clientHeight);
  const visible = currentVisible();
  rendered = visible.count;
  // Ghost counts per zone for collapsed-pad captions (D20).
  const ghostCounts = new Map<string, number>();
  for (const g of state.ghosts.values()) ghostCounts.set(g.zoneId, (ghostCounts.get(g.zoneId) ?? 0) + 1);
  const band = zoomBand(camera.scale);
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
      const ghostCount = ghostCounts.get(zone.id) ?? 0;
      ctx.fillText(
        `${zone.fileCount} machines${ghostCount > 0 ? ` · ${ghostCount} planned` : ""} — click pad to expand`,
        zone.x + zone.w / 2,
        zone.y + zone.h / 2 + 20,
        zone.w - 24,
      );
    }
  }

  const belts = getBeltCache();
  const isolatedId = selectedPath ? state.buildings.get(selectedPath)?.id : undefined;
  const visibleIds = new Set(visible.buildings.map((b) => b.id));
  const beltDrawn = drawBelts(band, view, visibleIds, belts, isolatedId, ts);

  for (const b of visible.buildings) {
    if (!boxVisible(b.x, b.y, b.x + PITCH, b.y + PITCH, view)) continue;
    drawBuilding(b, ts, band, belts.pipCounts.get(b.id) ?? 0, 1, farNamePriority(b.band, belts.congested.has(b.id)));
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
  // Ghosts draw after machines (outlines on top) but only in
  // expanded, rendered zones: collapsed pads report their ghost
  // count in the caption instead (D20 — never an invisible ghost).
  if (state.ghosts.size > 0) {
    const visibleZoneIds = new Set(visible.zones.map((z) => z.id));
    for (const g of state.ghosts.values()) {
      if (!visibleZoneIds.has(g.zoneId) || !expanded.has(g.zoneId)) continue;
      if (!boxVisible(g.x, g.y, g.x + PITCH, g.y + PITCH, view)) continue;
      drawGhost(g);
    }
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
    ghosts: state.ghosts.size,
    agent: state.agent.state,
    runs: state.runs.length,
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
  const s = minimapScale(width, height, right, bottom);
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
  $("last-change").textContent = lastChange ? `last change: ${lastChange.text} · ${ago(lastChange.ts, Date.now())}` : "";
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
// BAND_NAMES lives in machines.ts (coverage slice 1).

let inspectorPath: string | undefined;

function showInspector(b: Building | undefined) {
  $("inspector-empty").hidden = b !== undefined;
  $("inspector-body").hidden = b === undefined;
  if (!b) {
    inspectorPath = undefined;
    resetTraceUi();
    return;
  }
  const stale = previewStale(inspectorPath, b.path);
  inspectorPath = b.path;
  const rows = inspectorRows(b, state.belts);
  $("insp-path").textContent = b.path;
  $("insp-lines").textContent = rows.lines;
  $("insp-bytes").textContent = rows.bytes;
  $("insp-band").textContent = rows.band;
  $("insp-parse").textContent = rows.parse;
  $("insp-belts").textContent = rows.belts;
  $("insp-unresolved").textContent = rows.unresolved;
  const err = $("insp-error");
  err.hidden = rows.errorHidden;
  err.textContent = rows.errorText;
  const note = $("insp-note");
  note.hidden = rows.noteHidden;
  note.textContent = rows.noteText;
  // Why section (T5, D17 order: first section): agent why-notes for
  // the selection, stamped with textContent only — note text never
  // becomes markup. Hidden when the building has no notes.
  const why = whyNoteSection(
    state.notes.filter((n) => n.path === b.path),
    Date.now(),
  );
  $("insp-why").hidden = why === undefined;
  if (why) {
    $("insp-why-title").textContent = why.title;
    $("insp-why-lines").textContent = why.lines.join("\n");
  }
  // Connection sections: stamped from pure strings in machines.ts.
  // textContent only — file-derived paths/tables never become markup.
  const connHost = $("insp-connections");
  connHost.replaceChildren();
  for (const section of connectionSections(b)) {
    const box = document.createElement("section");
    box.className = "conn-section";
    const title = document.createElement("h3");
    title.className = "label conn-title";
    title.textContent = section.title;
    box.append(title);
    const pre = document.createElement("pre");
    pre.className = "conn-lines mono";
    pre.textContent = section.lines.join("\n");
    box.append(pre);
    connHost.append(box);
  }
  // Refreshing metadata for the same building must not blank its
  // preview; only a different selection hides stale content.
  if (stale) {
    ($("insp-content") as HTMLPreElement).hidden = true;
    resetTraceUi();
  }
}

// --- structural trace export --------------------------------------------
let tracePending: string | undefined;

/** Idle trace UI: button armed, fallback hidden, nothing in flight. */
function resetTraceUi() {
  tracePending = undefined;
  ($("copyTrace") as HTMLButtonElement).disabled = false;
  $("trace-fallback").hidden = true;
}

function requestTrace() {
  const path = selectedPath;
  if (!path) return;
  resetTraceUi();
  tracePending = path;
  ($("copyTrace") as HTMLButtonElement).disabled = true;
  if (!sendMessage({ v: WIRE_VERSION, type: "export-trace", path })) {
    // The socket is down: the request went nowhere and no response
    // will ever arrive to re-enable the button, so re-arm now
    // instead of stranding it disabled.
    resetTraceUi();
    notice = "Not connected — trace not sent";
    requestRender();
  }
}

/**
 * Manual-copy fallback: the clipboard write failed (or the API is
 * missing, insecure context), so the markdown lands in a readonly
 * inspector <pre> instead — never a silent no-op. Pre-selected so a
 * keypress delivers it; the Select-all button keeps it reachable.
 */
function openTraceFallback(markdown: string) {
  const pre = $("trace-text") as HTMLPreElement;
  pre.textContent = markdown;
  $("trace-fallback").hidden = false;
  try {
    getSelection()?.selectAllChildren(pre);
  } catch {
    // Selection is best-effort; the text stays readable regardless.
  }
  ($("trace-select") as HTMLButtonElement).focus();
  notice = "Clipboard unavailable — copy from below";
  requestRender();
}

function handleTraceMessage(path: string, markdown: string) {
  // A response for a no-longer-selected path is dropped silently
  // (the preview-stale precedent): no clipboard, no notice.
  if (path !== selectedPath) return;
  window.__trace = { path, markdown };
  tracePending = undefined;
  ($("copyTrace") as HTMLButtonElement).disabled = false;
  let written: Promise<void> | undefined;
  try {
    written = navigator.clipboard?.writeText(markdown);
  } catch {
    written = undefined;
  }
  if (!written) {
    openTraceFallback(markdown);
    return;
  }
  written.then(
    () => {
      if (path !== selectedPath) return;
      notice = `Trace copied: ${path}`;
      requestRender();
    },
    () => {
      if (path !== selectedPath) return;
      openTraceFallback(markdown);
    },
  );
}

$("copyTrace").addEventListener("click", requestTrace);
$("trace-select").addEventListener("click", () => {
  const pre = $("trace-text") as HTMLPreElement;
  try {
    getSelection()?.selectAllChildren(pre);
  } catch {
    // Best-effort; the text stays readable regardless.
  }
  pre.focus();
});

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
    const next = nextAddress(promptInput.value, lastAddressedPrefix, b.path);
    promptInput.value = next.value;
    lastAddressedPrefix = next.lastPrefix;
  }
  requestRender();
}

/** Center the camera on a machine, keeping the current scale. */
function centerOn(b: Building) {
  const c = centerOnBuilding(camera, canvas.clientWidth, canvas.clientHeight, b.x, b.y);
  camera.x = c.x;
  camera.y = c.y;
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
  head.textContent = searchHeadline(total, shown.length);
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
  camera.scale = jumpScale(camera.scale);
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
// toWorld lives in camera.ts as toWorldPoint (coverage slice 2).

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
  const rect = canvas.getBoundingClientRect();
  const p = toWorldPoint(camera, rect.left, rect.top, e.clientX, e.clientY);
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
  const rect = canvas.getBoundingClientRect();
  const p = toWorldPoint(camera, rect.left, rect.top, e.clientX, e.clientY);
  const next = clampZoom(camera.scale * wheelFactor(e.deltaY));
  const c = zoomAround(camera, p.sx, p.sy, p.x, p.y, next);
  camera.x = c.x;
  camera.y = c.y;
  camera.scale = c.scale;
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
// Follow targets are per-patch (see planPatch in feed.ts).

function jumpToRecent() {
  const newest = newestBuilding(state.buildings.values());
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
  const p = toWorldPoint(camera, 0, 0, w / 2, h / 2);
  const c = zoomAround(camera, p.sx, p.sy, p.x, p.y, clampZoom(camera.scale * factor));
  camera.x = c.x;
  camera.y = c.y;
  camera.scale = c.scale;
  requestRender();
}
$("zoomIn").addEventListener("click", () => stepZoom(1.25));
$("zoomOut").addEventListener("click", () => stepZoom(1 / 1.25));
$("zoomLabel").addEventListener("click", () => {
  fitCamera();
  requestRender();
});

// Dispatch (ghost layer): SEND starts the connected agent on the
// typed prompt; while it works the button becomes Stop. Never a
// silent no-op — every refusal says why out loud.
function refreshAgentChrome() {
  const a = state.agent;
  const label = a.agentId || "agent";
  $("conn-state").textContent =
    a.state === "working"
      ? `${label} · working${a.step ? ` — ${a.step.slice(0, 80)}` : ""}`
      : a.state === "done"
        ? `${label} · done`
        : a.state === "error"
          ? `${label} · error — ${a.detail ?? ""}`
          : `${label} · idle`;
  ($("dispatchSend") as HTMLButtonElement).textContent = a.state === "working" ? "Stop" : "Send";
}

function dispatchOrStop(viaEnter: boolean) {
  if (state.agent.state === "working") {
    if (viaEnter) {
      notice = "The agent is working — use Stop to interrupt it.";
      requestRender();
      return;
    }
    sendMessage({ v: WIRE_VERSION, type: "stop-agent" });
    notice = "Stopping the agent…";
    requestRender();
    return;
  }
  const text = promptInput.value.trim();
  if (text.length === 0) {
    notice = "Type a prompt first.";
    requestRender();
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    notice = "Dispatch needs a connection — reconnecting…";
    requestRender();
    return;
  }
  sendMessage({ v: WIRE_VERSION, type: "dispatch", text });
  promptInput.value = "";
  notice = "";
  requestRender();
}
$("dispatchSend").addEventListener("click", () => dispatchOrStop(false));
promptInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") dispatchOrStop(true);
});

// Runs panel (session viewer): the per-boot run ledger as a
// work-order list, newest first. Selection shows the full prompt,
// times, and terminal result — never a chat transcript.
let runsSelected: string | undefined;
function renderRunsPanel() {
  const panel = $("runsPanel");
  if (panel.hidden !== false) return;
  if (runsSelected !== undefined && !state.runs.some((r) => r.id === runsSelected)) {
    runsSelected = undefined;
  }
  $("runsList").innerHTML = renderRunsList(state.runs, runsSelected, Date.now());
  const selected = state.runs.find((r) => r.id === runsSelected);
  $("runDetail").innerHTML = renderRunDetail(selected, Date.now());
}
function setRunsOpen(open: boolean) {
  $("runsPanel").hidden = !open;
  $("runsBtn").setAttribute("aria-expanded", String(open));
  if (open) renderRunsPanel();
}
$("runsBtn").addEventListener("click", () => setRunsOpen($("runsPanel").hidden !== false));
$("runsClose").addEventListener("click", () => {
  setRunsOpen(false);
  ($("runsBtn") as HTMLButtonElement).focus();
});
$("runsList").addEventListener("click", (e) => {
  const row = (e.target as Element | null)?.closest?.("[data-run-id]");
  const id = row?.getAttribute("data-run-id") ?? undefined;
  if (id === undefined) return;
  runsSelected = id;
  renderRunsPanel();
});
// A running run's elapsed clock ticks while the panel is open;
// terminal ledgers re-render on patches alone.
setInterval(() => {
  if (!$("runsPanel").hidden && state.runs.some((r) => r.state === "running")) renderRunsPanel();
}, 1000);

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
  if ($("runsPanel").hidden === false) {
    setRunsOpen(false);
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

function sendMessage(msg: ClientMessage): boolean {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

function handleServerMessage(msg: ServerMessage) {
  switch (msg.type) {
    case "auth-ok":
      // The snapshot right after this sets the real worker chip.
      $("workerBtn").classList.remove("disconnected");
      // A fresh socket means any in-flight trace request died with
      // the old one: re-arm instead of stranding the button.
      resetTraceUi();
      break;
    case "snapshot": {
      applySnapshot(state, msg);
      refreshAgentChrome();
      renderRunsPanel();
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
      const plan = planPatch(
        msg,
        new Map(state.buildings),
        pulses,
        fading,
        selectedPath,
        !reducedMotion,
        now,
      );
      selectedPath = plan.selectedPath;
      const result = applyPatch(state, msg);
      if (result === "gap") {
        sendMessage({ v: WIRE_VERSION, type: "resync" });
        break;
      }
      if (msg.agent !== undefined) refreshAgentChrome();
      if (msg.runs !== undefined) renderRunsPanel();
      if (plan.refreshed) showInspector(plan.refreshed);
      if (plan.previewSoon) requestPreviewSoon(plan.previewSoon);
      // A belts-only patch changes the selected file's in/out counts
      // without upserting it: refresh the inspector rows (the
      // sameBuilding guard keeps the preview, so this never refetches).
      if (plan.beltsRefresh && selectedPath !== undefined) {
        const sel = state.buildings.get(selectedPath);
        if (sel) showInspector(sel);
      }
      // A notes-carrying patch adds Why content for the selection
      // without touching its building: refresh the inspector rows
      // (the sameBuilding guard keeps the preview, no refetch).
      if (msg.notes !== undefined && selectedPath !== undefined) {
        const sel = state.buildings.get(selectedPath);
        if (sel) showInspector(sel);
      }
      if (plan.changeText) lastChange = { text: plan.changeText, ts: Date.now() };
      // Follow tracks real file changes (deletes clear the target:
      // the building is gone, so there's nothing to center on).
      if (followOn && plan.followTarget) {
        const target = state.buildings.get(plan.followTarget);
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
    case "trace":
      handleTraceMessage(msg.path, msg.markdown);
      break;
    case "notice":
      notice = msg.text;
      requestRender();
      break;
    case "error":
      notice = msg.message;
      // Errors carry no request identity: any error while a trace
      // is in flight re-arms the button (worst case it re-arms
      // early on an open-file error; the trace response still lands
      // via its path match). The notice above names unknown paths.
      if (tracePending !== undefined) {
        tracePending = undefined;
        ($("copyTrace") as HTMLButtonElement).disabled = false;
      }
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
    // The pending trace response (if any) will never arrive on a
    // dead socket: re-arm the button for the reconnect.
    resetTraceUi();
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

