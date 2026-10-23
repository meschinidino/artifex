/**
 * Toaster panel view (T3; DT1–DT11): the human behavior view over
 * frozen `toaster-gate-1` proof records. Four stage machines —
 * ASK → BUILD → FILE → PROVE — with Saira nameplates (never the
 * code floor's file machines; the legend says so), one proof lamp
 * per stage, the airlock gate, and the nutrition-label plate.
 *
 * Rules pinned by the design review:
 * - Lamps: proven = filled square + check + PROVEN; trying =
 *   hollow dashed + TRYING; failed = red + X + FAILED. Color is
 *   never alone: shape + word always ride along. Amber is
 *   inferred-only and never used here.
 * - Machines say what exists, lights say proven, the ticker says
 *   what is happening now (one-job rule). Unproven reads trying,
 *   never as fact; factual rows carry their proof id.
 * - Unproven stages render ghost (dashed) and solidify when
 *   proven — the one authored beat, instant under reduced motion.
 * - Errors persist with plain-words copy + a next step until
 *   dismissed or superseded by a newer proof (proof-id keyed).
 * - Replay wears persistent RECORDED PROOF chrome, never live.
 *
 * Pure: no DOM. `app.ts` owns toggle/dismiss state and injects
 * the markup this module builds.
 */
import type { ToasterProof } from "../server/toaster-proof.ts";
import { airlockFor, renderAirlock } from "./toaster-airlock.ts";
import { caeProven, proofId, renderTicker, tickerEntries, type TickerEntry } from "./toaster-ticker.ts";
import { escapeHtml } from "./runs.ts";

export type StageId = "ask" | "build" | "file" | "prove";
export type LampState = "proven" | "trying" | "failed";

export type StageView = {
  id: StageId;
  /** Saira nameplate word. */
  nameplate: string;
  /** What this stage is, in plain words. */
  title: string;
  lamp: LampState;
  /** Ghost until proven; solid after (the authored beat). */
  solid: boolean;
  /** One-line readout under the nameplate. */
  detail: string;
  /** Linked E2E proof id when the readout states a fact. */
  proofId?: string;
};

export type ToasterError = {
  kind: "unreachable" | "bad-cert" | "rejected" | "timeout" | "unknown";
  title: string;
  body: string;
  next: string;
  proofId: string;
};

export type LabelBand = { title: string; rows: { k: string; v: string }[] };

export type ToasterPanel = {
  stages: StageView[];
  provenCount: number;
  totalStages: number;
  /** Strip aggregate, e.g. "2 of 4 proven". */
  aggregateText: string;
  /** True when proofs are an archived replay, never a live run. */
  recorded: boolean;
  /** True when the latest proof never touched ARCA. */
  stub: boolean;
  ticker: TickerEntry[];
  error?: ToasterError;
  latest?: ToasterProof;
};

/** One plain-words gloss per jargon term (DT7). */
export const GLOSSES: Record<string, string> = {
  CAE: "ARCA's approval code for one invoice",
  monotributo: "Argentina's simplified small-taxpayer regime",
  homologación: "ARCA's test environment — no real filing happens here",
  "factura C": "the invoice type monotributo sellers issue",
};

export const STAGE_DEFS: { id: StageId; nameplate: string; title: string }[] = [
  { id: "ask", nameplate: "ASK", title: "You asked for an invoice" },
  { id: "build", nameplate: "BUILD", title: "The invoice was built" },
  { id: "file", nameplate: "FILE", title: "Sent to ARCA for approval" },
  { id: "prove", nameplate: "PROVE", title: "ARCA approved it (CAE)" },
];

export const EMPTY_BAY_COPY =
  "This bay is empty. Ask for an invoice below and watch each machine rise as it is proven.";

/** Classify a proof's failure into the R6 taxonomy + copy. */
export function classifyError(p: ToasterProof): ToasterError | undefined {
  const id = proofId(p);
  if (p.resultado === "R") {
    const why = [...p.obs, ...p.errors].map((n) => n.msg).filter(Boolean).join(" ");
    return {
      kind: "rejected",
      title: "ARCA rejected this invoice",
      body: why ? `ARCA said: ${why}` : "ARCA answered but did not approve the invoice data.",
      next: "Fix the invoice data shown below, then file again.",
      proofId: id,
    };
  }
  if (p.errors.length === 0) return undefined;
  const msg = p.errors.map((e) => e.msg ?? "").join(" ");
  if (/timeout|timed out|etimedout/i.test(msg)) {
    return {
      kind: "timeout",
      title: "ARCA took too long to answer",
      body: "The request was sent, but no answer came back in time.",
      next: "Wait a moment, then file again. Nothing was approved yet.",
      proofId: id,
    };
  }
  if (/notauthorized|cert|firma|signature|token|auth/i.test(msg)) {
    return {
      kind: "bad-cert",
      title: "ARCA does not accept this certificate yet",
      body: "The test certificate is not authorized for invoicing in the test environment.",
      next: "Authorize the invoicing service for this certificate in ARCA's test portal, then file again.",
      proofId: id,
    };
  }
  if (/fetch|network|econn|enotfound|socket|unreachable/i.test(msg)) {
    return {
      kind: "unreachable",
      title: "ARCA's test environment cannot be reached",
      body: "No answer came back from ARCA at all.",
      next: "Check the connection, then file again.",
      proofId: id,
    };
  }
  return {
    kind: "unknown",
    title: "The invoice did not go through",
    body: msg || "Something failed before ARCA could approve the invoice.",
    next: "Read the detail below, then file again.",
    proofId: id,
  };
}

function stagesFor(latest: ToasterProof | undefined): StageView[] {
  const base = (i: number, lamp: LampState, detail: string, proofId?: string): StageView => ({
    ...STAGE_DEFS[i]!,
    lamp,
    solid: lamp === "proven",
    detail,
    proofId,
  });
  if (!latest) return STAGE_DEFS.map((_, i) => base(i, "trying", "Waiting to start."));
  const id = proofId(latest);
  if (latest.stub) {
    return [
      base(0, "proven", "An invoice was requested (simulated).", id),
      base(1, "proven", "Invoice data prepared (simulated).", id),
      base(2, "trying", "Simulated — nothing was sent to ARCA."),
      base(3, "trying", "No CAE: this run never touched ARCA."),
    ];
  }
  const err = classifyError(latest);
  const ask = base(0, "proven", `Factura C · $${latest.voucher.impTotal} · sales point ${latest.voucher.ptoVta}.`, id);
  const build = base(1, "proven", `Invoice #${latest.voucher.cbteDesde} ready to send.`, id);
  let file: StageView;
  let prove: StageView;
  if (err && latest.resultado === "") {
    file = base(2, "failed", err.title);
    prove = base(3, "failed", "No approval was received.");
  } else if (latest.resultado === "R") {
    file = base(2, "proven", "ARCA answered.", id);
    prove = base(3, "failed", "ARCA did not approve this invoice.");
  } else if (caeProven(latest)) {
    file = base(2, "proven", "ARCA answered.", id);
    prove = base(3, "proven", `CAE ${latest.cae} · vence ${latest.caeFchVto}.`, id);
  } else {
    file = base(2, "trying", "Waiting for ARCA to answer…");
    prove = base(3, "trying", "Waiting for the CAE…");
  }
  return [ask, build, file, prove];
}

/** Build the whole panel model from the proof list (latest wins). */
export function buildToasterPanel(
  proofs: readonly ToasterProof[],
  opts: { recorded: boolean; now: number; tickerMaxAgeMs?: number },
): ToasterPanel {
  const sorted = [...proofs].sort((a, b) => a.ranAt.localeCompare(b.ranAt));
  const latest = sorted[sorted.length - 1];
  const stages = stagesFor(latest);
  const provenCount = stages.filter((s) => s.lamp === "proven").length;
  return {
    stages,
    provenCount,
    totalStages: stages.length,
    aggregateText: `${provenCount} of ${stages.length} proven`,
    recorded: opts.recorded,
    stub: latest?.stub ?? false,
    ticker: tickerEntries(sorted, opts.now, opts.tickerMaxAgeMs),
    error: latest && !latest.stub ? classifyError(latest) : undefined,
    latest,
  };
}

/** Nutrition-label bands (DT6): IN / OUT / PROVED / CHANGED. */
export function labelBands(p: ToasterProof): LabelBand[] {
  return [
    {
      title: "IN",
      rows: [
        { k: "Invoice", v: `Factura C (monotributo) · $${p.voucher.impTotal} ${p.voucher.monId}` },
        { k: "Sales point", v: String(p.voucher.ptoVta) },
        { k: "Sender CUIT", v: `${p.cuitMasked} · MASKED` },
      ],
    },
    {
      title: "OUT",
      rows: [
        { k: "CAE", v: p.cae || "—" },
        { k: "CAE valid until", v: p.caeFchVto || "—" },
        { k: "Result", v: p.resultado === "A" ? "Approved" : p.resultado === "R" ? "Rejected" : "—" },
      ],
    },
    {
      title: "PROVED",
      rows: [
        { k: "Proof", v: `${p.schema} · ${p.stub ? "simulated" : "live test"}` },
        { k: "Environment", v: "homologación (test only)" },
        { k: "Ran at", v: p.ranAt },
        { k: "ARCA answer time", v: `${p.latencyMs.status + p.latencyMs.voucher} ms` },
      ],
    },
    {
      title: "CHANGED",
      rows: [
        { k: "Invoice number", v: p.voucher.cbteDesde > 0 ? `#${p.voucher.cbteDesde}` : "—" },
        { k: "Total filed", v: `$${p.voucher.impTotal} ${p.voucher.monId}` },
      ],
    },
  ];
}

const LAMP_GLYPH: Record<LampState, string> = { proven: "✓", trying: "…", failed: "✕" };

/** One stage machine: plate + roof bar + square lamp + nameplate. */
export function renderStage(s: StageView): string {
  return (
    `<button type="button" class="stage-machine${s.solid ? " solid" : " ghost"}" data-stage="${s.id}" ` +
    `aria-label="${escapeHtml(`${s.nameplate}: ${s.lamp}`)}">` +
    `<span class="stage-roof" aria-hidden="true"></span>` +
    `<span class="stage-lamp lamp-${s.lamp}" aria-hidden="true">${LAMP_GLYPH[s.lamp]}</span>` +
    `<span class="stage-nameplate label">${escapeHtml(s.nameplate)}</span>` +
    `<span class="stage-lampword label">${escapeHtml(s.lamp.toUpperCase())}</span>` +
    `<span class="stage-title">${escapeHtml(s.title)}</span>` +
    `<span class="stage-detail mono">${escapeHtml(s.detail)}</span></button>`
  );
}

/** Click-through: the exact proving input and output (narration rule). */
export function renderProofDetail(p: ToasterProof): string {
  const input =
    `Factura C · punto de venta ${p.voucher.ptoVta} · total $${p.voucher.impTotal} ${p.voucher.monId} · ` +
    `emisor ${p.cuitMasked} (masked)`;
  const output = caeProven(p)
    ? `CAE ${p.cae} · vence ${p.caeFchVto} · comprobante #${p.voucher.cbteDesde} · resultado A (aprobado)`
    : p.resultado === "R"
      ? "Resultado R (rechazado) — sin CAE."
      : "Sin CAE todavía.";
  return (
    `<div class="proof-detail"><h4 class="label">Proving input</h4><pre class="mono">${escapeHtml(input)}</pre>` +
    `<h4 class="label">Proving output</h4><pre class="mono">${escapeHtml(output)}</pre>` +
    `<p class="muted mono">proof ${escapeHtml(proofId(p))} · ${p.stub ? "simulated" : "homologación"}</p></div>`
  );
}

/**
 * The floor bay (T3b): the four stage machines on the floor itself,
 * always visible — the panel is detail-on-click, not the show.
 * The packet rides the belts only when a proof exists; under
 * reduced motion CSS freezes it (instant state, static dashes).
 */
export function renderStageBay(panel: ToasterPanel): string {
  const invite = !panel.latest
    ? `<p class="bay-invite">${escapeHtml(EMPTY_BAY_COPY)}</p>`
    : panel.recorded
      ? `<p class="bay-invite label">Recorded proof · not live</p>`
      : "";
  const belt = panel.latest
    ? `<span class="stage-belt" aria-hidden="true"><span class="packet"></span></span>`
    : `<span class="stage-belt" aria-hidden="true"></span>`;
  const machines = panel.stages.map((s) => renderStage(s)).join(belt);
  const gate = panel.latest && caeProven(panel.latest)
    ? `<div class="bay-gate proven"><span class="label">Airlock → ARCA</span><span class="mono">CAE ${escapeHtml(panel.latest.cae)}</span></div>`
    : `<div class="bay-gate"><span class="label">Airlock → ARCA</span><span class="mono">nothing crossed yet</span></div>`;
  return `${invite}<div class="stage-row bay-row">${machines}<span class="stage-belt" aria-hidden="true"></span>${gate}</div>`;
}

/** The full panel markup. `dismissed` holds proof ids whose error was closed. */
export function renderToasterPanel(panel: ToasterPanel, dismissed: ReadonlySet<string>): string {
  const banner = panel.recorded
    ? `<p class="recorded-banner label">Recorded proof · ${escapeHtml(panel.latest?.ranAt ?? "")} · not live</p>`
    : panel.stub
      ? `<p class="recorded-banner label">Simulated proof · no ARCA call was made</p>`
      : "";
  const empty = !panel.latest
    ? `<p class="toaster-empty">${escapeHtml(EMPTY_BAY_COPY)}</p>`
    : "";
  const machines = panel.stages.map(renderStage).join(`<span class="stage-belt" aria-hidden="true"></span>`);
  const err =
    panel.error && !dismissed.has(panel.error.proofId)
      ? `<section class="toaster-error" aria-label="What went wrong">` +
        `<h4 class="label">Failed · ${escapeHtml(panel.error.title)}</h4>` +
        `<p>${escapeHtml(panel.error.body)}</p><p><strong>Next:</strong> ${escapeHtml(panel.error.next)}</p>` +
        `<button type="button" class="btn btn-compact" data-dismiss-error="${escapeHtml(panel.error.proofId)}">Dismiss</button></section>`
      : "";
  const label = panel.latest
    ? `<section class="nutrition-label" aria-label="Behavior label"><h4 class="label">Label · what this system does</h4>` +
      labelBands(panel.latest)
        .map(
          (b) =>
            `<div class="label-band"><h5 class="label">${escapeHtml(b.title)}</h5><dl>` +
            b.rows.map((r) => `<div><dt>${escapeHtml(r.k)}</dt><dd class="mono">${escapeHtml(r.v)}</dd></div>`).join("") +
            `</dl></div>`,
        )
        .join("") +
      `</section>`
    : "";
  const glosses = Object.entries(GLOSSES)
    .map(([k, v]) => `<div><dt class="mono">${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd></div>`)
    .join("");
  return (
    `${banner}${empty}<div class="stage-row">${machines}</div>` +
    `<p class="proof-aggregate mono" aria-live="polite">${escapeHtml(panel.aggregateText)}</p>` +
    `${err}${renderAirlock(airlockFor(panel.latest))}${label}` +
    `<section aria-label="Words used here"><h4 class="label">Words used here</h4><dl class="gloss-list">${glosses}</dl></section>` +
    `<section aria-label="Ticker"><h4 class="label">Ticker · what is happening now</h4>${renderTicker(panel.ticker)}</section>` +
    `<div id="toasterDetail"></div>`
  );
}
