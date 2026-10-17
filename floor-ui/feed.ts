/**
 * Patch-feed decisions (coverage slice 4).
 *
 * Pure decision layer over one patch: change text, follow target,
 * selection retargeting, pulse/fade map updates, inspector refresh
 * flags. The pulse/fade maps and the clock arrive explicitly (no
 * hidden singletons, no Date.now — `app.ts` stamps lastChange).
 * `app.ts` applies DOM/canvas effects from the returned plan.
 */
import { isCountsOnlyChange, type Building, type PatchMessage } from "./wire.ts";

/** Pulse/fade maps are capped: draw drains them, and draw stops hidden. */
export const FEED_CAP = 20;

export type FadeEntry = { building: Building; start: number };

/** Evict the oldest entry past the cap (ties keep insertion order). */
export function evictOldest<K, V>(entries: Map<K, V>, startOf: (v: V) => number, cap: number): void {
  if (entries.size > cap) {
    const oldest = [...entries.entries()].sort((a, c) => startOf(a[1]) - startOf(c[1]))[0]!;
    entries.delete(oldest[0]);
  }
}

export type PatchPlan = {
  /** Last-change line, or undefined when the patch names nothing. */
  changeText: string | undefined;
  /** Follow target, or undefined (deletes clear: the target is gone). */
  followTarget: string | undefined;
  /** Selection after rename retargeting (chains follow). */
  selectedPath: string | undefined;
  /** Inspector refresh for the selected building, when affected. */
  refreshed: Building | undefined;
  /** Preview re-request for a changed selected building. */
  previewSoon: Building | undefined;
  /** True when the selected building was upserted this patch. */
  showedSelected: boolean;
  /** Belts-only patch: refresh counts without refetching preview. */
  beltsRefresh: boolean;
};

type PatchInput = Pick<PatchMessage, "remove" | "rename" | "upsert" | "belts">;

/**
 * Decide one patch against pre-patch buildings. Precedence is
 * remove → rename → upsert, last writer wins inside each phase;
 * renames retarget the selection and carry pulse timestamps;
 * counts-only upserts refresh without pulsing.
 */
export function planPatch(
  msg: PatchInput,
  preByPath: Map<string, Building>,
  pulses: Map<string, number>,
  fading: Map<string, FadeEntry>,
  selectedPath: string | undefined,
  animate: boolean,
  now: number,
): PatchPlan {
  const byId = new Map([...preByPath.values()].map((b) => [b.id, b]));
  let changeText: string | undefined;
  let followTarget: string | undefined;
  let selected = selectedPath;

  for (const id of msg.remove) {
    const b = byId.get(id);
    if (b) {
      if (animate) {
        fading.set(b.path, { building: b, start: now });
        evictOldest(fading, (f) => f.start, FEED_CAP);
      }
      changeText = `${b.path} deleted`;
    }
  }
  for (const r of msg.rename) {
    if (selected === r.from) selected = r.to;
    changeText = `${r.from} → ${r.to}`;
    followTarget = r.to;
    const p = pulses.get(r.from);
    if (p !== undefined) {
      pulses.delete(r.from);
      pulses.set(r.to, p);
    }
  }

  let refreshed: Building | undefined;
  let previewSoon: Building | undefined;
  let showedSelected = false;
  for (const b of msg.upsert) {
    // A counts-only upsert (belt refresh on an untouched file) is
    // not a change: no pulse, no last-change line, no preview
    // re-request — but the selected inspector still refreshes.
    if (isCountsOnlyChange(preByPath.get(b.path), b)) {
      if (b.path === selected) {
        refreshed = b;
        showedSelected = true;
      }
      continue;
    }
    changeText = b.path;
    followTarget = b.path;
    pulses.set(b.path, now);
    evictOldest(pulses, (s) => s, FEED_CAP);
    if (b.path === selected) {
      refreshed = b;
      showedSelected = true;
      previewSoon = b;
    }
  }

  // A belts-only patch changes the selected file's in/out counts
  // without upserting it: refresh the inspector rows (the
  // same-building guard keeps the preview, so this never refetches).
  const beltsRefresh = msg.belts !== undefined && selected !== undefined && !showedSelected;

  return { changeText, followTarget, selectedPath: selected, refreshed, previewSoon, showedSelected, beltsRefresh };
}
