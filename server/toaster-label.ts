/**
 * Toaster nutrition label (T6/D1=B): the shareable behavior card,
 * rendered from one frozen proof record as a standalone HTML file
 * (inline styles, no external requests) so it films as a close-up
 * and shares as a single file. Bands come from the panel's one
 * label definition (floor-ui/toaster-view) — the export can never
 * drift from what the panel showed.
 */
import type { ToasterProof } from "./toaster-proof.ts";
import { labelBands } from "../floor-ui/toaster-view.ts";
import { escapeHtml } from "../floor-ui/runs.ts";

/** Standalone label document for one proof record. */
export function renderToasterLabel(p: ToasterProof): string {
  const honesty = p.stub
    ? "Simulated proof — no ARCA call was made."
    : `Recorded proof from ARCA homologación (test environment) · ran at ${p.ranAt} · not a live filing.`;
  const bands = labelBands(p)
    .map(
      (b) =>
        `<section><h2>${escapeHtml(b.title)}</h2><dl>` +
        b.rows
          .map((r) => `<div><dt>${escapeHtml(r.k)}</dt><dd>${escapeHtml(r.v)}</dd></div>`)
          .join("") +
        `</dl></section>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<title>Artifex label · factura C $${p.voucher.impTotal}</title>
<style>
body{background:#20241d;color:#ede8d8;font-family:"Instrument Sans",system-ui,sans-serif;margin:0;padding:32px}
main{max-width:640px;margin:0 auto;background:#2c3128;border:2px solid #141712;box-shadow:4px 4px 0 rgba(0,0,0,.45);padding:24px}
h1{font-family:"Anton","Arial Narrow",sans-serif;letter-spacing:.02em;font-size:28px;margin:0 0 4px}
h2{font-family:"Saira Semi Condensed","Arial Narrow",sans-serif;text-transform:uppercase;letter-spacing:.14em;font-size:15px;color:#a8b09c;margin:20px 0 6px}
p{line-height:1.55} dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;margin:0}
dt{color:#a8b09c;font-size:13px} dd{margin:0;font-family:"JetBrains Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.honesty{background:#1a1e19;border:2px solid #141712;padding:10px 12px}
</style></head>
<body><main>
<h1>ARTIFEX · WHAT THIS SYSTEM DOES</h1>
<p class="honesty">${escapeHtml(honesty)}</p>
${bands}
<h2>WORDS USED HERE</h2>
<p>CAE: ARCA's approval code for one invoice. Monotributo: Argentina's simplified small-taxpayer regime. Homologación: ARCA's test environment — no real filing happens here.</p>
<p>Proof: ${escapeHtml(p.schema)} · sender ${escapeHtml(p.cuitMasked)} (masked) · generated from the frozen gate record.</p>
</main></body></html>
`;
}
