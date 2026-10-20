/**
 * Session viewer (run ledger) rendering: pure HTML builders over
 * wire RunRecords. The app owns toggle/selection state; this
 * module only turns records into escaped markup, so it stays
 * unit-testable under bun with no DOM.
 */
import type { RunRecord, RunState, RunUsage } from "./wire.ts";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function runStateLabel(state: RunState): string {
  switch (state) {
    case "running":
      return "Running";
    case "done":
      return "Done";
    case "error":
      return "Error";
    case "stopped":
      return "Stopped";
  }
}

/** List row title: first prompt line, visibly capped. */
export function runTitle(prompt: string): string {
  const first = prompt.split("\n", 1)[0] ?? "";
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

export function formatClock(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function formatElapsed(startedAt: number, endedAt: number | undefined, now: number): string {
  const s = Math.floor(Math.max(0, (endedAt ?? now) - startedAt) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export const RUNS_EMPTY = "No runs yet this boot — dispatch a prompt below.";
export const RUN_DETAIL_EMPTY = "Select a run to inspect it.";
export const RUN_TOKENS_ABSENT = "Not reported by the agent";

/** Compact count: full digits under 1000, one decimal k/M above (`999`, `1k`, `12.3k`). */
export function formatCompact(n: number): string {
  if (n < 1000) return String(n);
  const scaled = n < 1_000_000 ? n / 1000 : n / 1_000_000;
  const suffix = n < 1_000_000 ? "k" : "M";
  const rounded = Math.round(scaled * 10) / 10;
  return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}${suffix}`;
}

/** The Tokens cell: reported directions compactly, or the honest absent state. Never zero-filled. */
export function renderTokensCell(usage: RunUsage | undefined): string {
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (input === undefined && output === undefined) {
    const total = usage?.totalTokens;
    if (total === undefined) return `<dd class="mono muted">${escapeHtml(RUN_TOKENS_ABSENT)}</dd>`;
    return `<dd class="mono" title="${escapeHtml(`${total} total`)}">${escapeHtml(`${formatCompact(total)} total`)}</dd>`;
  }
  const inText = input === undefined ? "in —" : `${formatCompact(input)} in`;
  const outText = output === undefined ? "out —" : `${formatCompact(output)} out`;
  const title = [input === undefined ? undefined : `${input} in`, output === undefined ? undefined : `${output} out`]
    .filter((p) => p !== undefined)
    .join(" · ");
  return `<dd class="mono" title="${escapeHtml(title)}">${escapeHtml(`${inText} · ${outText}`)}</dd>`;
}

/** Newest first; the selected row carries aria-current. Each row shows the run's wall time. */
export function renderRunsList(runs: readonly RunRecord[], selectedId: string | undefined, now: number): string {
  if (runs.length === 0) return `<p class="muted">${escapeHtml(RUNS_EMPTY)}</p>`;
  const rows = [...runs]
    .reverse()
    .map(
      (r) =>
        `<li><button type="button" class="run-row" data-run-id="${escapeHtml(r.id)}" aria-current="${
          r.id === selectedId ? "true" : "false"
        }"><span class="run-dot run-${r.state}" aria-hidden="true"></span>` +
        `<span class="run-title">${escapeHtml(runTitle(r.prompt))}</span>` +
        `<span class="run-time mono">${escapeHtml(formatClock(r.startedAt))}</span>` +
        `<span class="run-elapsed mono">${escapeHtml(formatElapsed(r.startedAt, r.endedAt, now))}</span></button></li>`,
    )
    .join("");
  return `<ol class="runs-list">${rows}</ol>`;
}

export function renderRunDetail(run: RunRecord | undefined, now: number): string {
  if (!run) return `<p class="muted">${escapeHtml(RUN_DETAIL_EMPTY)}</p>`;
  const ended = run.endedAt === undefined ? "—" : escapeHtml(formatClock(run.endedAt));
  const detail = run.detail === undefined
    ? ""
    : `<div><dt>Result</dt><dd>${escapeHtml(run.detail)}</dd></div>`;
  const answer = run.answer === undefined
    ? ""
    : `<h4 class="label">Answer</h4><pre>${escapeHtml(run.answer)}</pre>`;
  return (
    `<div class="run-detail"><dl>` +
    `<div><dt>State</dt><dd>${escapeHtml(runStateLabel(run.state))}</dd></div>` +
    `<div><dt>Started</dt><dd class="mono">${escapeHtml(formatClock(run.startedAt))}</dd></div>` +
    `<div><dt>Ended</dt><dd class="mono">${ended}</dd></div>` +
    `<div><dt>Elapsed</dt><dd class="mono">${escapeHtml(formatElapsed(run.startedAt, run.endedAt, now))}</dd></div>` +
    `<div><dt>Tokens</dt>${renderTokensCell(run.usage)}</div>` +
    detail +
    `</dl><h4 class="label">Prompt</h4><pre>${escapeHtml(run.prompt)}</pre>${answer}</div>`
  );
}
