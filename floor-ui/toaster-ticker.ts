/**
 * Toaster ticker (T3/DT6): append-only readout entries derived from
 * proof records. Entries are never dropped: a superseded or aged
 * entry is kept and marked STALE (D5). Unproven items read as
 * trying, never as fact (narration rule, P2); factual entries carry
 * their proof id so the claim stays linked to its E2E proof.
 *
 * Pure: no DOM. `app.ts` renders the returned entries into the top
 * strip readout and the panel list.
 */
import type { ToasterProof } from "../server/toaster-proof.ts";
import { escapeHtml } from "./runs.ts";

export type TickerState = "trying" | "proven" | "failed";

export type TickerEntry = {
  /** Stable per proof + beat, so re-renders never duplicate. */
  id: string;
  text: string;
  state: TickerState;
  /** Kept, never dropped: superseded or older than the age cap. */
  stale: boolean;
  /** Linked E2E proof id for factual (proven/failed) entries. */
  proofId?: string;
  /** ISO timestamp the beat happened (proof run time). */
  at: string;
};

/** The one proof id format: schema + run instant. */
export function proofId(p: ToasterProof): string {
  return `${p.schema}:${p.ranAt}`;
}

/** CAE is factual only as 14 digits on an aprobado proof. */
export function caeProven(p: ToasterProof): boolean {
  return p.resultado === "A" && /^\d{14}$/.test(p.cae);
}

/**
 * Entries for all proofs, oldest proof first, beats in run order.
 * An entry is stale when a newer proof supersedes it or when it is
 * older than `maxAgeMs` (when a cap is given); stale entries stay.
 */
export function tickerEntries(
  proofs: readonly ToasterProof[],
  now: number,
  maxAgeMs?: number,
): TickerEntry[] {
  if (proofs.length === 0) {
    return [
      {
        id: "toaster:empty",
        text: "No invoice yet — ask below to file the first one.",
        state: "trying",
        stale: false,
        at: new Date(now).toISOString(),
      },
    ];
  }
  const sorted = [...proofs].sort((a, b) => a.ranAt.localeCompare(b.ranAt));
  const latestId = proofId(sorted[sorted.length - 1]!);
  const entries: TickerEntry[] = [];
  for (const p of sorted) {
    const id = proofId(p);
    const age = now - Date.parse(p.ranAt);
    const stale = id !== latestId || (maxAgeMs !== undefined && age > maxAgeMs);
    if (p.stub) {
      entries.push({
        id: `${id}:stub`,
        text: "Simulated run — no call was made to ARCA.",
        state: "trying",
        stale,
        proofId: id,
        at: p.ranAt,
      });
      continue;
    }
    entries.push({
      id: `${id}:sent`,
      text: `Invoice sent to ARCA homologación (factura C, $${p.voucher.impTotal}).`,
      state: "proven",
      stale,
      proofId: id,
      at: p.ranAt,
    });
    if (caeProven(p)) {
      entries.push({
        id: `${id}:cae`,
        text: `CAE ${p.cae} received — invoice approved.`,
        state: "proven",
        stale,
        proofId: id,
        at: p.ranAt,
      });
    } else if (p.resultado === "R") {
      entries.push({
        id: `${id}:rejected`,
        text: "ARCA rejected the invoice — see the panel for what to fix.",
        state: "failed",
        stale,
        proofId: id,
        at: p.ranAt,
      });
    } else if (p.errors.length > 0) {
      entries.push({
        id: `${id}:fault`,
        text: "The invoice did not reach ARCA — see the panel for the next step.",
        state: "failed",
        stale,
        proofId: id,
        at: p.ranAt,
      });
    } else {
      entries.push({
        id: `${id}:pending`,
        text: "Waiting for ARCA to answer…",
        state: "trying",
        stale,
        proofId: id,
        at: p.ranAt,
      });
    }
  }
  return entries;
}

/** Latest entry text for the 56px strip readout (never a marquee). */
export function tickerReadout(entries: readonly TickerEntry[]): string {
  const last = entries[entries.length - 1];
  if (!last) return "";
  return last.stale ? `${last.text} (STALE)` : last.text;
}

/** Panel list markup: one line per entry, state word always present. */
export function renderTicker(entries: readonly TickerEntry[]): string {
  const rows = entries
    .map(
      (e) =>
        `<li class="ticker-row ticker-${e.state}${e.stale ? " ticker-stale" : ""}">` +
        `<span class="ticker-state label">${escapeHtml(e.state)}${e.stale ? " · STALE" : ""}</span>` +
        `<span class="ticker-text">${escapeHtml(e.text)}</span></li>`,
    )
    .join("");
  return `<ol class="ticker-list">${rows}</ol>`;
}
