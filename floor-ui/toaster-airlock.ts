/**
 * Toaster airlock (T3/DT6): the machine-boundary display. One plain
 * sentence says what crosses, where to, and that nothing else does;
 * secrets appear only as solid mask blocks labeled MASKED; the
 * counter names how many items crossed (0 until a proof exists).
 *
 * Pure: no DOM, and no secret material is ever an input — the proof
 * record carries only the masked CUIT, so this module cannot leak
 * what it never receives.
 */
import type { ToasterProof } from "../server/toaster-proof.ts";
import { escapeHtml } from "./runs.ts";

export type AirlockView = {
  /** The one plain sentence (Instrument Sans register, D8). */
  sentence: string;
  destination: string;
  /** Items that crossed the boundary (invoices filed). */
  itemsCrossed: number;
  /** Mask blocks: label + already-masked value, never raw secrets. */
  masked: { label: string; value: string }[];
};

export function airlockFor(proof: ToasterProof | undefined): AirlockView {
  const masked = [
    { label: "Certificate and key", value: "stay on this machine" },
  ];
  if (!proof || proof.stub) {
    return {
      sentence: proof
        ? "Simulated run — nothing left this machine."
        : "Nothing has crossed yet. When an invoice is filed, it goes to ARCA homologación, nothing else.",
      destination: "ARCA homologación",
      itemsCrossed: 0,
      masked: proof
        ? [{ label: "Sender CUIT", value: proof.cuitMasked }, ...masked]
        : masked,
    };
  }
  return {
    sentence: "Sending this invoice data to ARCA homologación, nothing else.",
    destination: "ARCA homologación",
    itemsCrossed: 1,
    masked: [{ label: "Sender CUIT", value: proof.cuitMasked }, ...masked],
  };
}

/** Bay-door gate markup: hazard-striped border, sentence, counter. */
export function renderAirlock(view: AirlockView): string {
  const blocks = view.masked
    .map(
      (m) =>
        `<div class="airlock-mask"><dt>${escapeHtml(m.label)}</dt>` +
        `<dd><span class="mask-block" aria-label="masked">${escapeHtml(m.value)}</span> ` +
        `<span class="label">Masked</span></dd></div>`,
    )
    .join("");
  return (
    `<section class="airlock" aria-label="Airlock">` +
    `<h4 class="label">Airlock · to ${escapeHtml(view.destination)}</h4>` +
    `<p class="airlock-sentence">${escapeHtml(view.sentence)}</p>` +
    `<dl class="airlock-masks">${blocks}</dl>` +
    `<p class="airlock-count mono">${view.itemsCrossed} item${view.itemsCrossed === 1 ? "" : "s"} crossed</p>` +
    `</section>`
  );
}
