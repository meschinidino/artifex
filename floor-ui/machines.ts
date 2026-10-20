/**
 * Machine-identity + machine-readout math (coverage slice 1).
 *
 * Pure: no DOM, canvas, network, or module state. `app.ts` imports and
 * calls these; the draw code only formats what they decide. Tests pin
 * the exact strings and counts production renders.
 */
import { MAX_PARSE_BYTES } from "../parser/protocol.ts";
import type { Band } from "./layout.ts";
import type { AgentNote, BeltEdge, Building, RemovedMark } from "./wire.ts";

export type BuildingKind = "test" | "doc" | "config" | "code";

export function kindOf(path: string): BuildingKind {
  if (/(\.test\.|\.spec\.|(^|\/)tests?\/|(^|\/)__tests?__\/|(^|\/)test_[^/]*$|_test\.)/.test(path)) return "test";
  if (/\.(md|mdx|txt|rst|adoc)$/.test(path)) return "doc";
  if (/\.(json|jsonc|toml|ya?ml|ini|cfg|lock)$/.test(path) || /(^|\/)\.(env|gitignore|editorconfig)/.test(path)) {
    return "config";
  }
  return "code";
}

/** Stable string hash for deterministic decoration (window patterns). */
export function pathHash(str: string): number {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Point at distance d along an orthogonal polyline (clamped).
 * Empty input is a contract violation: tick/chevron callers always
 * route ≥2 points, so an empty polyline means a broken route.
 */
export function pointAt(pts: [number, number][], d: number): [number, number] {
  if (pts.length === 0) throw new RangeError("pointAt: need at least one point");
  let rest = Math.max(0, d);
  for (let i = 1; i < pts.length; i++) {
    const segLen = Math.abs(pts[i]![0] - pts[i - 1]![0]) + Math.abs(pts[i]![1] - pts[i - 1]![1]);
    // Zero-length segments carry no distance: skip them. (The pre-move
    // code stopped at the first zero segment and misplaced the point;
    // skipping is identical on all routes without zero segments.)
    if (segLen === 0) continue;
    if (rest <= segLen) {
      const k = rest / segLen;
      return [pts[i - 1]![0] + (pts[i]![0] - pts[i - 1]![0]) * k, pts[i - 1]![1] + (pts[i]![1] - pts[i - 1]![1]) * k];
    }
    rest -= segLen;
  }
  return pts[pts.length - 1]!;
}

/** Human relative time for the last-change readout. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}

/** Newest building by mtime (ties keep the first); none when empty. */
export function newestBuilding(buildings: Iterable<Building>): Building | undefined {
  let newest: Building | undefined;
  for (const b of buildings) {
    if (!newest || b.mtimeMs > newest.mtimeMs) newest = b;
  }
  return newest;
}

export type ZoomBandName = "far" | "mid" | "near";

/**
 * Connection pips shown on a machine: max of fan-in/fan-out, cap 5,
 * hidden in the far band; small machines show what fits.
 */
export function pipShown(size: number, scale: number, maxPips: number, band: ZoomBandName): number {
  if (band === "far" || maxPips <= 0) return 0;
  const fit = Math.max(0, Math.floor((size * scale - 4) / 8));
  return Math.min(maxPips, 5, fit);
}

export type NameplateInput = {
  binary: boolean;
  band: ZoomBandName;
  parse: Building["parse"];
  selected: boolean;
  farName: boolean;
};

/**
 * Nameplates: far hides names except error/selected/priority (large
 * or congested), mid shows all, near adds line counts.
 */
export function showName({ binary, band, parse, selected, farName }: NameplateInput): boolean {
  return !binary && (band !== "far" || parse === "error" || selected || farName);
}

/** Uppercase basename for the nameplate. */
export function shortName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1).toUpperCase();
}

/** Far-band name priority: large or congested machines stay labeled. */
export function farNamePriority(band: Band, congested: boolean): boolean {
  return band >= 2 || congested;
}

export const BAND_NAMES = ["S (<100 lines)", "M (100–499)", "L (500–1999)", "XL (≥2000)"] as const;

export type InspectorRows = {
  lines: string;
  bytes: string;
  band: string;
  parse: string;
  belts: string;
  unresolved: string;
  footprint: string;
  errorHidden: boolean;
  errorText: string;
  noteHidden: boolean;
  noteText: string;
};

/**
 * Inspector `Footprint` row (FR14): the wire verdict when the path
 * is footed, `clean` when the label has fresh status and the path
 * is unfooted, `unknown` otherwise (never a fake clean).
 */
export function footprintRow(foot: Building["foot"], known: boolean): string {
  if (foot === "added") return "added (new vs HEAD)";
  if (foot === "modified") return "modified (differs from HEAD)";
  return known ? "clean" : "unknown (git status unavailable)";
}

/**
 * Whether a path's label has fresh git status. `""` in the
 * available set means the single repo root (every path governed);
 * otherwise the label is the first path segment (federated floors
 * prefix every building path with its district label).
 */
export function footKnown(path: string, footAvailable: readonly string[]): boolean {
  if (footAvailable.includes("")) return true;
  const slash = path.indexOf("/");
  const label = slash === -1 ? path : path.slice(0, slash);
  return footAvailable.includes(label);
}

/** At most this many removed markers draw; the rest stay counted. */
export const REMOVED_DRAW_CAP = 200;

/**
 * Path-ordered draw set for removed markers (FR9): the first
 * REMOVED_DRAW_CAP draw, the overflow count rides the strip
 * counts — visible and truthful, never silent.
 */
export function selectRemovedDrawn(marks: readonly RemovedMark[]): { drawn: RemovedMark[]; overflow: number } {
  const ordered = [...marks].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { drawn: ordered.slice(0, REMOVED_DRAW_CAP), overflow: Math.max(0, ordered.length - REMOVED_DRAW_CAP) };
}

/** Top-strip footprint counts: `+A ~M -R`, overflow named (FR11). */
export function formatFootCounts(added: number, modified: number, removed: number, overflow = 0): string {
  const base = `+${added} ~${modified} -${removed}`;
  return overflow > 0 ? `${base} (+${overflow} more unplotted)` : base;
}

export type FootTagInput = {
  /** Machine body top in world units. */
  y: number;
  /** Machine body size in world units. */
  size: number;
  /** Whether the Saira nameplate row draws (false on crates). */
  nameVisible: boolean;
  band: ZoomBandName;
  /** Whether the red ERR tag draws above the footprint tag. */
  hasErr: boolean;
  /** One screen px in world units (1 / camera.scale). */
  s: number;
};

/**
 * Footprint tag top (NEW/MOD): ERR-tag geometry stacked below the
 * ERR tag when both show, clearing the nameplate and the near-band
 * line-count row exactly like ERR does. Mirrors the drawBuilding
 * ERR anchor — the two must move together.
 */
export function footTagTop({ y, size, nameVisible, band, hasErr, s }: FootTagInput): number {
  const nameY = y + size + 14 * s;
  const anchor = nameVisible ? nameY + (band === "near" ? 14 * s : 0) : y + size;
  const errBottom = hasErr ? anchor + 6 * s + 18 * s : anchor;
  return errBottom + 6 * s;
}

export type ConnectionSection = { title: string; lines: string[] };

/**
 * Declaration suffix for one table row: `declared in <path>:<line>`
 * (first declarer, `+N more` when several; cross-repo declarers
 * keep their `repo:` prefix) or the literal `undeclared` marker.
 * Pure strings — the DOM layer stamps them with textContent only.
 */
export function declaredLabel(repo: string, declaredBy: readonly { repo: string; path: string; line: number }[] | undefined): string {
  if (!declaredBy || declaredBy.length === 0) return "undeclared";
  const first = declaredBy[0]!;
  const head = first.repo === repo ? `${first.path}:${first.line}` : `${first.repo}:${first.path}:${first.line}`;
  const more = declaredBy.length > 1 ? ` +${declaredBy.length - 1} more` : "";
  return `declared in ${head}${more}`;
}

/**
 * Inspector connection sections: what this file serves, calls,
 * and which tables each side reaches. Pure strings — the DOM
 * layer only stamps them out. Empty sections are omitted, except
 * unresolved dynamics, which stay visible as a count.
 */
export function connectionSections(b: Building): ConnectionSection[] {
  const conn = b.conn;
  if (!conn) return [];
  const sections: ConnectionSection[] = [];
  const head: string[] = [];
  if (conn.service) head.push(`Service: ${conn.service}${conn.repo ? ` (${conn.repo})` : ""}`);
  else if (conn.repo) head.push(`Repo: ${conn.repo}`);
  if (conn.kinds.length > 0) head.push(`Kind: ${conn.kinds.join(", ")}`);
  if (head.length > 0) sections.push({ title: "Connections", lines: head });
  if (conn.endpoints.length > 0) {
    const lines: string[] = [];
    for (const ep of conn.endpoints) {
      lines.push(`${ep.method} ${ep.path}  → ${ep.handler || "?"} (line ${ep.line})`);
      if (ep.tables.length > 0) {
        lines.push(`    tables: ${ep.tables.map((t) => `${t.table} (${t.access}${t.derived === "implicit-name" ? ", implicit name" : ""}, ${declaredLabel(conn.repo, t.declaredBy)})`).join(", ")}`);
      } else {
        lines.push("    tables: none proven");
      }
      for (const c of ep.callers) lines.push(`    ← ${c.path} ${c.caller} (${c.via})`);
    }
    sections.push({ title: `Endpoints (${conn.endpoints.length})`, lines });
  }
  if (conn.tables.length > 0) {
    sections.push({
      title: `Tables used (${conn.tables.length})`,
      lines: conn.tables.map((t) => `${t.table} — ${t.access} via ${t.via}${t.derived === "implicit-name" ? " (implicit name)" : ""} · ${t.through} · ${declaredLabel(conn.repo, t.declaredBy)}`),
    });
  }
  if (conn.calls.length > 0) {
    sections.push({
      title: `Calls out (${conn.calls.length})`,
      lines: conn.calls.map((c) => {
        const dest = c.matchedPath ? `→ ${c.matchedPath}` : c.targetService ? `→ ${c.targetService} (not in indexed repos)` : "→ unresolved";
        return `${c.method} ${c.path} (${c.via}${c.caller ? `, ${c.caller}` : ""}) ${dest}`;
      }),
    });
  }
  if (conn.topics.length > 0) {
    sections.push({
      title: `Topics (${conn.topics.length})`,
      lines: conn.topics.map((t) => `${t.topic} — ${t.direction}${t.handler ? ` (${t.handler})` : ""}${t.peers.length > 0 ? ` · peers: ${t.peers.join(", ")}` : ""}`),
    });
  }
  if (conn.unresolvedNotes > 0) {
    sections.push({ title: "Unresolved", lines: [`${conn.unresolvedNotes} dynamic connection(s) not guessed (templates/placeholders)`] });
  }
  return sections;
}

/**
 * Inspector Why section (T5, D17 order): agent why-notes for the
 * selected building, oldest first. Pure strings — the DOM layer
 * stamps them with textContent only. Undefined when there is
 * nothing to show (the section stays hidden).
 */
export function whyNoteSection(notes: readonly AgentNote[], now: number): ConnectionSection | undefined {
  if (notes.length === 0) return undefined;
  const lines: string[] = [];
  for (const n of notes) {
    if (lines.length > 0) lines.push("");
    lines.push(`${n.agentId ?? "agent"} · ${ago(n.ts, now)}`);
    lines.push(n.note);
  }
  return { title: notes.length === 1 ? "Why" : `Why (${notes.length})`, lines };
}

/**
 * Inspector readout for one building: exact strings the DOM shows.
 * Belt counts scan the edge list for incidents of this building's id.
 * `known` tells whether the building's label has fresh git status;
 * it defaults to false (unknown unless proven known — never fake clean).
 */
export function inspectorRows(b: Building, belts: Iterable<BeltEdge>, known = false): InspectorRows {
  let beltIn = 0;
  let beltOut = 0;
  for (const e of belts) {
    if (e.toId === b.id) beltIn++;
    if (e.fromId === b.id) beltOut++;
  }
  return {
    lines: b.binary ? "— (binary)" : String(b.lines),
    bytes: String(b.bytes),
    band: BAND_NAMES[b.band],
    parse: b.binary ? "binary file, no preview" : b.parse,
    belts: `${beltIn} / ${beltOut}`,
    unresolved: String(b.unresolvedCount),
    footprint: footprintRow(b.foot, known),
    errorHidden: !b.parseError,
    errorText: b.parseError ?? "",
    noteHidden: b.parse !== "unparsed" || b.binary,
    noteText:
      b.parse === "unparsed" && !b.binary
        ? b.bytes > MAX_PARSE_BYTES
          ? "Too large to parse (>1 MiB); rendered solid."
          : "Not parsed (parser unavailable); rendered solid."
        : "",
  };
}

/**
 * Same-building preview guard: refreshing metadata for the building
 * already shown must not blank its preview; only a different
 * selection (or the first) hides stale content.
 */
export function previewStale(inspectorPath: string | undefined, path: string): boolean {
  return inspectorPath !== path;
}

/** Search-result headline: exact listbox header copy. */
export function searchHeadline(total: number, shown: number): string {
  if (total === 0) return "no matches";
  if (shown < total) return `${shown} of ${total} matches`;
  if (total === 1) return "1 match";
  return `${total} matches`;
}

export type PromptAddress = { value: string; lastPrefix: string };

/**
 * Address the dispatch console at the selection — but only when it
 * holds no composed text. Clicking machines to inspect must never
 * clobber a prompt; the last auto-written prefix tracks re-addressing
 * (paths may contain spaces, so prefix matching is exact).
 */
export function nextAddress(current: string, lastPrefix: string, path: string): PromptAddress {
  const prefix = `@${path} `;
  if (!current || current === lastPrefix) return { value: prefix, lastPrefix: prefix };
  return { value: current, lastPrefix };
}
