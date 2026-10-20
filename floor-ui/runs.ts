/**
 * Session viewer (run ledger) rendering: pure HTML builders over
 * wire RunRecords. The app owns toggle/selection state; this
 * module only turns records into escaped markup, so it stays
 * unit-testable under bun with no DOM.
 */
import { maskContent } from "../watcher/mask.ts";
import { MAX_LESSON_CHARS, MAX_LESSONS_PER_RUN, WRITEBACK_SECTION_HEADER } from "./wire.ts";
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

export function renderRunDetail(run: RunRecord | undefined, now: number, lessons?: LessonsView): string {
  if (!run) return `<p class="muted">${escapeHtml(RUN_DETAIL_EMPTY)}</p>`;
  const ended = run.endedAt === undefined ? "—" : escapeHtml(formatClock(run.endedAt));
  const detail = run.detail === undefined
    ? ""
    : `<div><dt>Result</dt><dd>${escapeHtml(run.detail)}</dd></div>`;
  const answer = run.answer === undefined
    ? ""
    : `<h4 class="label">Answer</h4><pre>${escapeHtml(run.answer)}</pre>`;
  const lessonsHtml = lessons === undefined ? "" : renderLessonsSection(run, lessons, now);
  return (
    `<div class="run-detail"><dl>` +
    `<div><dt>State</dt><dd>${escapeHtml(runStateLabel(run.state))}</dd></div>` +
    `<div><dt>Started</dt><dd class="mono">${escapeHtml(formatClock(run.startedAt))}</dd></div>` +
    `<div><dt>Ended</dt><dd class="mono">${ended}</dd></div>` +
    `<div><dt>Elapsed</dt><dd class="mono">${escapeHtml(formatElapsed(run.startedAt, run.endedAt, now))}</dd></div>` +
    `<div><dt>Tokens</dt>${renderTokensCell(run.usage)}</div>` +
    detail +
    `</dl><h4 class="label">Prompt</h4><pre>${escapeHtml(run.prompt)}</pre>${answer}${lessonsHtml}</div>`
  );
}

/** Plain-text twin of renderTokensCell for the Lessons facts line. */
export function tokensSummary(usage: RunUsage | undefined): string {
  const input = usage?.inputTokens;
  const output = usage?.outputTokens;
  if (input === undefined && output === undefined) {
    const total = usage?.totalTokens;
    return total === undefined ? RUN_TOKENS_ABSENT : `${formatCompact(total)} total`;
  }
  const inText = input === undefined ? "in —" : `${formatCompact(input)} in`;
  const outText = output === undefined ? "out —" : `${formatCompact(output)} out`;
  return `${inText} · ${outText}`;
}

/**
 * Every line separator a lesson can smuggle: LF, CRLF/CR, and the
 * Unicode line/paragraph separators (rendered as breaks, so an
 * entry line must never contain them). Split first, cap after —
 * counting pre-split elements lets one lesson bypass the cap and
 * inject raw lines.
 */
export function splitLessonText(text: string): string[] {
  return text.split(/\r\n|[\r\n\u2028\u2029]/);
}

/**
 * Split a lesson draft into non-empty trimmed lines. One line in,
 * one line out: embedded separators cannot survive, so a lesson can
 * never break out of its single list-item line.
 */
export function parseLessonLines(draft: string): string[] {
  return splitLessonText(draft).map((line) => line.trim()).filter((line) => line.length > 0);
}

/**
 * Mask then visibly cap lesson lines — the exact text that lands in
 * the file. Masking runs over the joined text (one masker pass, like
 * every other masked surface) and preserves the line count, so the
 * preview and the server share this one function: WYSIWYG by
 * construction.
 */
export function prepareLessonLines(lines: readonly string[]): string[] {
  const masked = splitLessonText(maskContent(lines.join("\n")).content);
  return masked.map((line) => line.length > MAX_LESSON_CHARS ? `${line.slice(0, MAX_LESSON_CHARS - 1)}…` : line);
}

/** Server-local entry date, `YYYY-MM-DD`. */
export function formatEntryDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * One lesson entry line. State is the terminal wire word (`done` /
 * `error` / `stopped`), elapsed follows the detail view's
 * formatElapsed rules exactly.
 */
export function buildLessonEntry(
  run: Pick<RunRecord, "id" | "startedAt" | "endedAt" | "state">,
  lesson: string,
  date: string,
): string {
  const end = run.endedAt ?? run.startedAt;
  return `- ${date} run ${run.id.slice(0, 8)} (${run.state}, ${formatElapsed(run.startedAt, end, end)}): ${lesson}`;
}

/**
 * The exact markdown block the preview shows and the server
 * appends: one entry line per lesson, each newline-terminated,
 * plus the fenced header (after a blank line, as it lands in a
 * normally-terminated file) only when the target lacks it. Empty
 * drafts preview as empty: there is nothing to record.
 */
export function buildLessonsPreview(
  run: Pick<RunRecord, "id" | "startedAt" | "endedAt" | "state">,
  lessons: readonly string[],
  hasSection: boolean,
  now: number,
): string {
  if (lessons.length === 0) return "";
  const date = formatEntryDate(now);
  const entries = prepareLessonLines(lessons).map((lesson) => buildLessonEntry(run, lesson, date));
  const head = hasSection ? "" : `\n${WRITEBACK_SECTION_HEADER}\n`;
  return `${head}${entries.map((entry) => `${entry}\n`).join("")}`;
}

export function lessonCountText(n: number): string {
  return `${n} lesson line${n === 1 ? "" : "s"} · at most ${MAX_LESSONS_PER_RUN} per run`;
}

/** Lessons section view state: draft, per-boot recorded mark, ack text. */
export type LessonsView = {
  draft: string;
  recordedAt?: number;
  hasSection: boolean;
  resultText?: string;
};

export const LESSON_PLACEHOLDER =
  "One lesson per line: what wasted context, what to do differently next time. Secrets are masked, lines capped at 280 chars.";
/** Total draft bound from the line caps (5 × 280 plus newlines, rounded). */
export const LESSON_DRAFT_MAXLENGTH = 1500;

/**
 * Lessons section for terminal runs; running runs get nothing. The
 * textarea starts empty on every selection — the floor never
 * generates, templates, or prefills lesson text.
 */
export function renderLessonsSection(run: RunRecord, view: LessonsView, now: number): string {
  if (run.state === "running") return "";
  const lines = parseLessonLines(view.draft);
  const preview = buildLessonsPreview(run, lines, view.hasSection, now);
  const recorded = view.recordedAt !== undefined;
  const disabledAttr = recorded || lines.length === 0 ? " disabled" : "";
  const recordedHtml = recorded
    ? `<p class="lesson-result">Recorded ${escapeHtml(formatClock(view.recordedAt!))}</p>`
    : "";
  const resultHtml = view.resultText === undefined
    ? ""
    : `<p class="lesson-result" aria-live="polite">${escapeHtml(view.resultText)}</p>`;
  return (
    `<section class="lessons" aria-label="Lessons"><h4 class="label">Lessons</h4>` +
    `<p class="lessons-facts mono muted">${escapeHtml(runStateLabel(run.state))} · ` +
    `${escapeHtml(formatElapsed(run.startedAt, run.endedAt, now))} · ${escapeHtml(tokensSummary(run.usage))}</p>` +
    `<p class="muted lessons-target">Records to AGENTS.md at the repo root.</p>` +
    `<label class="label" for="lessonInput">Your lessons</label>` +
    `<textarea id="lessonInput" class="lesson-input mono" rows="4" maxlength="${LESSON_DRAFT_MAXLENGTH}" ` +
    `placeholder="${escapeHtml(LESSON_PLACEHOLDER)}"${recorded ? " disabled" : ""}>${escapeHtml(view.draft)}</textarea>` +
    `<p class="muted mono" id="lessonCount">${escapeHtml(lessonCountText(lines.length))}</p>` +
    `<pre class="lesson-preview mono" id="lessonPreview">${escapeHtml(preview)}</pre>` +
    `<button type="button" class="btn" id="lessonRecord"${disabledAttr}>Record to AGENTS.md</button>` +
    `${recordedHtml}${resultHtml}</section>`
  );
}

/**
 * Fold a `writeback-result` ack into the per-boot client memory:
 * every attempt's text replaces the last; only success marks the
 * run recorded. Pure so the ack semantics stay unit-testable — the
 * app owns the maps, the draft, and the re-render.
 */
export function applyWritebackResult(
  recorded: Map<string, number>,
  results: Map<string, string>,
  msg: { runId: string; ok: boolean; text: string },
  now: number,
): void {
  results.set(msg.runId, msg.text);
  if (msg.ok) recorded.set(msg.runId, now);
}
