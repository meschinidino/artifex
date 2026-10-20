/**
 * Path search over the client's full building set (T4 escape hatch).
 * Pure: ranking and capping are unit-testable without the DOM.
 */
import type { Building } from "./wire.ts";

/** Rows the results listbox ever renders; the total stays truthful. */
export const SEARCH_RESULTS_LIMIT = 50;

export type SearchResults<T extends { path: string } = Building> = {
  /** Ranked matches, capped at SEARCH_RESULTS_LIMIT. */
  shown: T[];
  /** Total matches, including those past the cap. */
  total: number;
};

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Case-insensitive substring match on repo-relative paths. Basename
 * matches rank above path-only matches; ties break by path order,
 * so results are deterministic for a given item set. An empty
 * query matches nothing (no list), never everything. Generic over
 * path-carriers so removed markers stay keyboard-reachable next to
 * machines (the client searches the union).
 */
export function searchBuildings<T extends { path: string }>(
  items: readonly T[],
  query: string,
  limit: number = SEARCH_RESULTS_LIMIT,
): SearchResults<T> {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return { shown: [], total: 0 };
  const ranked: { rank: number; path: string; item: T }[] = [];
  for (const item of items) {
    const path = item.path.toLowerCase();
    if (!path.includes(q)) continue;
    ranked.push({
      rank: basename(path).includes(q) ? 0 : 1,
      path: item.path,
      item,
    });
  }
  ranked.sort((a, b) => a.rank - b.rank || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // A negative limit must show nothing (slice(0, -k) would silently
  // drop tail matches while the total still claims them).
  return { shown: ranked.slice(0, Math.max(0, limit)).map((r) => r.item), total: ranked.length };
}
