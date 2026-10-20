/**
 * Session viewer rendering: escaped markup over wire RunRecords.
 * Pure builders, no DOM — the app wires toggle and selection.
 */
import { describe, expect, test } from "bun:test";
import {
  applyWritebackResult,
  buildLessonEntry,
  buildLessonsPreview,
  escapeHtml,
  formatClock,
  formatCompact,
  formatElapsed,
  formatEntryDate,
  lessonCountText,
  parseLessonLines,
  prepareLessonLines,
  renderLessonsSection,
  renderRunDetail,
  renderRunsList,
  renderTokensCell,
  runStateLabel,
  runTitle,
  RUNS_EMPTY,
  RUN_TOKENS_ABSENT,
  tokensSummary,
  type LessonsView,
} from "./runs.ts";
import { MAX_LESSON_CHARS, MAX_LESSONS_PER_RUN, WRITEBACK_SECTION_HEADER } from "./wire.ts";
import type { RunRecord } from "./wire.ts";

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "plan-1",
  sessionId: "sess-1",
  prompt: "do the thing",
  startedAt: 1_760_000_000_000,
  state: "running",
  ...over,
});

describe("runs render", () => {
  // Value: protects=prompt HTML injection in the viewer (prompts
  // are human-typed, rows use innerHTML); fails_when=escaping is
  // dropped from any interpolated field.
  test("escapes prompt, id, and detail everywhere", () => {
    const evil = run({
      id: 'a"><img src=x>',
      prompt: "<script>alert(1)</script>",
      state: "error",
      detail: 'exit 1: <b>"quoted"</b> & done',
    });
    const list = renderRunsList([evil], undefined, evil.startedAt + 1000);
    expect(list).not.toContain("<script>");
    expect(list).toContain("&lt;script&gt;");
    expect(list).not.toContain('a"><img');
    const detail = renderRunDetail(evil, evil.startedAt + 1000);
    expect(detail).toContain("&lt;script&gt;");
    expect(detail).toContain("&lt;b&gt;&quot;quoted&quot;&lt;/b&gt; &amp; done");
    expect(escapeHtml("&<>\"")).toBe("&amp;&lt;&gt;&quot;");
  });

  // Value: protects=the honest empty ledger (per-boot scope is
  // stated, never a fake history); fails_when=the empty copy
  // claims restarts keep runs.
  test("empty ledger states the per-boot scope", () => {
    expect(renderRunsList([], undefined, Date.now())).toContain(escapeHtml(RUNS_EMPTY));
    expect(RUNS_EMPTY).toContain("this boot");
  });

  // Value: protects=list order + selection marking (newest work
  // order on top, current row exposed to assistive tech);
  // fails_when=order flips or aria-current is lost.
  test("lists newest first with the selected row marked", () => {
    const a = run({ id: "a", prompt: "first" });
    const b = run({ id: "b", prompt: "second", state: "done", endedAt: a.startedAt + 1000 });
    const html = renderRunsList([a, b], "a", a.startedAt + 2000);
    expect(html.indexOf("second")).toBeLessThan(html.indexOf("first"));
    expect(html).toContain('data-run-id="a" aria-current="true"');
    expect(html).toContain('data-run-id="b" aria-current="false"');
    expect(runStateLabel("running")).toBe("Running");
    expect(runStateLabel("done")).toBe("Done");
    expect(runStateLabel("error")).toBe("Error");
    expect(runStateLabel("stopped")).toBe("Stopped");
  });

  // Value: protects=row titles on multiline prompts (one capped
  // line, never a wall of text); fails_when=newlines leak into
  // rows or long prompts push layout.
  test("row titles use the capped first line", () => {
    expect(runTitle("one\ntwo\nthree")).toBe("one");
    const long = `x${"y".repeat(200)}`;
    const title = runTitle(long);
    expect(title.length).toBe(80);
    expect(title.endsWith("…")).toBe(true);
  });

  // Value: protects=detail truth (times, live elapsed, terminal
  // result); fails_when=ended shows a time for running runs or
  // the result detail is dropped.
  test("detail shows times, elapsed, and result", () => {
    const t0 = 1_760_000_000_000;
    const running = run({ startedAt: t0 });
    const live = renderRunDetail(running, t0 + 65_000);
    expect(live).toContain("Running");
    expect(live).toContain("1m 5s");
    expect(live).toContain("—");
    const done = run({ state: "done", startedAt: t0, endedAt: t0 + 3_700_000, detail: undefined });
    const dd = renderRunDetail(done, t0 + 3_700_000);
    expect(dd).toContain("1h 1m");
    expect(dd).not.toContain("Result");
    expect(formatElapsed(t0, t0 + 5_000, t0 + 5_000)).toBe("5s");
    expect(formatClock(t0)).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  // Value: protects=detail placeholder with no selection;
  // fails_when=an empty panel renders a broken half-detail.
  test("no selection renders the placeholder", () => {
    expect(renderRunDetail(undefined, Date.now())).toContain("Select a run");
  });

  // Value: protects=the answer section (present and escaped when
  // the run spoke, absent otherwise — never a phantom header);
  // fails_when=answers render raw or the header shows with no
  // answer behind it.
  test("detail shows the escaped answer only when present", () => {
    const t0 = 1_760_000_000_000;
    const silent = renderRunDetail(run({ startedAt: t0 }), t0);
    expect(silent).not.toContain("Answer");
    const speaking = renderRunDetail(run({ startedAt: t0, answer: "It says <b>hi</b> & bye" }), t0);
    expect(speaking).toContain("Answer");
    expect(speaking).toContain("It says &lt;b&gt;hi&lt;/b&gt; &amp; bye");
  });

  // Value: protects=per-row wall time (every work order shows its
  // cost at a glance; running rows read against now, ended rows
  // against their end); fails_when=a row drops its elapsed figure
  // or a finished run keeps ticking; why_new=run cost readout.
  test("rows carry the mono elapsed figure", () => {
    const t0 = 1_760_000_000_000;
    const live = run({ id: "live", prompt: "running", startedAt: t0 });
    const past = run({ id: "past", prompt: "finished", state: "done", startedAt: t0, endedAt: t0 + 125_000 });
    const html = renderRunsList([past, live], undefined, t0 + 65_000);
    expect(html).toContain('<span class="run-elapsed mono">1m 5s</span>');
    expect(html).toContain('<span class="run-elapsed mono">2m 5s</span>');
    // The ended row is frozen at its end, not at now.
    expect(renderRunsList([past], undefined, t0 + 3_700_000)).toContain(
      '<span class="run-elapsed mono">2m 5s</span>',
    );
  });

  // Value: protects=compact counts (narrow rows stay readable, one
  // decimal above thousands); fails_when=figures lose precision or
  // grow unbounded; why_new=run cost readout.
  test("formatCompact renders full digits, then one-decimal k/M", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(999)).toBe("999");
    expect(formatCompact(1000)).toBe("1k");
    expect(formatCompact(4077)).toBe("4.1k");
    expect(formatCompact(12345)).toBe("12.3k");
    expect(formatCompact(12000)).toBe("12k");
    expect(formatCompact(999499)).toBe("999.5k");
    expect(formatCompact(1_234_567)).toBe("1.2M");
    expect(formatCompact(2_000_000)).toBe("2M");
  });

  // Value: protects=the Tokens row in every state (full and partial
  // reports compact with exact titles, total-only, and the honest
  // absent words — never blank, never zero-filled);
  // fails_when=any state misrenders or invents a figure;
  // why_new=run cost readout.
  test("detail Tokens states: full, partial, total-only, absent", () => {
    const t0 = 1_760_000_000_000;
    const full = renderRunDetail(run({ startedAt: t0, usage: { inputTokens: 12345, outputTokens: 4077 } }), t0);
    expect(full).toContain("Tokens");
    expect(full).toContain("12.3k in · 4.1k out");
    expect(full).toContain('title="12345 in · 4077 out"');
    const inOnly = renderRunDetail(run({ startedAt: t0, usage: { inputTokens: 12345 } }), t0);
    expect(inOnly).toContain("12.3k in · out —");
    expect(inOnly).toContain('title="12345 in"');
    const outOnly = renderTokensCell({ outputTokens: 4077 });
    expect(outOnly).toContain("in — · 4.1k out");
    expect(outOnly).toContain('title="4077 out"');
    const totalOnly = renderRunDetail(run({ startedAt: t0, usage: { totalTokens: 16422 } }), t0);
    expect(totalOnly).toContain("16.4k total");
    expect(totalOnly).toContain('title="16422 total"');
    const absent = renderRunDetail(run({ startedAt: t0 }), t0);
    expect(absent).toContain(escapeHtml(RUN_TOKENS_ABSENT));
    expect(absent).toContain("Not reported by the agent");
    expect(absent).not.toContain("0 in");
  });
});

describe("lessons write-back (instruction write-back)", () => {
  const t0 = 1_760_000_000_000;
  const done = (over: Partial<RunRecord> = {}): RunRecord =>
    run({ id: "12345678-aaaa-bbbb-cccc-000000000001", state: "done", startedAt: t0, endedAt: t0 + 65_000, ...over });
  const view = (over: Partial<LessonsView> = {}): LessonsView =>
    ({ draft: "", hasSection: true, ...over });

  // Value: protects=FR1 (Lessons for terminal runs only — a live
  // run has no outcome to learn from yet); fails_when=the section
  // leaks onto running runs or vanishes from terminal ones.
  test("terminal runs gain the section, running runs never do", () => {
    for (const state of ["done", "error", "stopped"] as const) {
      const html = renderRunDetail(done({ state }), t0 + 65_000, view());
      expect(html).toContain('aria-label="Lessons"');
      expect(html).toContain("Record to AGENTS.md");
    }
    expect(renderRunDetail(run({ startedAt: t0 }), t0 + 1000, view())).not.toContain("Lessons");
    expect(renderLessonsSection(run({ startedAt: t0 }), view(), t0)).toBe("");
    // No view state, no section (back-compat callers).
    expect(renderRunDetail(done(), t0 + 65_000)).not.toContain("lessonInput");
  });

  // Value: protects=FR6 (the textarea starts empty — the floor
  // never generates, templates, or prefills lesson text);
  // fails_when=any draft appears unasked.
  test("the textarea starts empty with guidance toward reusable lessons", () => {
    const html = renderLessonsSection(done(), view(), t0 + 65_000);
    expect(html).toContain('<textarea id="lessonInput"');
    expect(html).toContain("what wasted context, what to do differently next time");
    expect(html).toContain("Secrets are masked");
    expect(html).toContain("capped at 280 chars");
    expect(html).toContain("Records to AGENTS.md at the repo root.");
    expect(html).toContain("></textarea>");
  });

  // Value: protects=FR2/FR5 button states (Record enabled only
  // with a lesson to record, locked once recorded);
  // fails_when=empty drafts send or recorded runs re-record.
  test("Record enables on lessons, disables on empty and recorded", () => {
    const empty = renderLessonsSection(done(), view(), t0 + 65_000);
    expect(empty).toContain('id="lessonRecord" disabled');
    const filled = renderLessonsSection(done(), view({ draft: "batch the reads" }), t0 + 65_000);
    expect(filled).toContain('id="lessonRecord">Record to AGENTS.md</button>');
    expect(filled).not.toContain('id="lessonRecord" disabled');
    const whitespace = renderLessonsSection(done(), view({ draft: "  \n  " }), t0 + 65_000);
    expect(whitespace).toContain('id="lessonRecord" disabled');
    const recorded = renderLessonsSection(done(), view({ draft: "batch the reads", recordedAt: t0 + 70_000 }), t0 + 80_000);
    expect(recorded).toContain('id="lessonRecord" disabled');
    expect(recorded).toContain(`Recorded ${formatClock(t0 + 70_000)}`);
    expect(recorded).toContain("<textarea id=\"lessonInput\"");
  });

  // Value: protects=FR4 preview honesty (masked, capped, escaped,
  // header iff the file lacks the section); fails_when=the
  // preview drifts from what the server appends.
  test("preview mirrors the append: header iff absent, masked, capped, escaped", () => {
    const runRec = done();
    const block = buildLessonsPreview(runRec, ["first lesson", "second"], false, t0 + 65_000);
    expect(block).toBe(
      `\n${WRITEBACK_SECTION_HEADER}\n` +
      `- ${formatEntryDate(t0 + 65_000)} run 12345678 (done, 1m 5s): first lesson\n` +
      `- ${formatEntryDate(t0 + 65_000)} run 12345678 (done, 1m 5s): second\n`,
    );
    const reuse = buildLessonsPreview(runRec, ["first lesson"], true, t0 + 65_000);
    expect(reuse).not.toContain(WRITEBACK_SECTION_HEADER);
    expect(reuse).toBe(`- ${formatEntryDate(t0 + 65_000)} run 12345678 (done, 1m 5s): first lesson\n`);
    expect(buildLessonsPreview(runRec, [], false, t0 + 65_000)).toBe("");
    // Long lines cap visibly, HTML escapes, empties drop (via the
    // real chain: parse, then render — as renderLessonsSection does).
    const long = "x".repeat(MAX_LESSON_CHARS + 50);
    const tricky = buildLessonsPreview(
      runRec,
      parseLessonLines(`  \n<script>alert(1)</script>\n${long}\n`),
      true,
      t0 + 65_000,
    );
    const lines = tricky.split("\n").filter(Boolean);
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("<script>alert(1)</script>");
    expect(lines[1]!.length).toBeLessThan(long.length);
    expect(lines[1]!.endsWith("…")).toBe(true);
    const html = renderLessonsSection(runRec, view({ draft: `<b>x</b>\n${long}` }), t0 + 65_000);
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).toContain("…");
    expect(lessonCountText(1)).toContain("1 lesson line");
    expect(lessonCountText(2)).toContain("2 lesson lines");
    expect(lessonCountText(0)).toContain(`at most ${MAX_LESSONS_PER_RUN} per run`);
  });

  // Value: protects=FR13 entry provenance (date, short id, outcome,
  // elapsed) and FR14 WYSIWYG masking; fails_when=the entry
  // misattributes the run or a secret-shaped line lands raw.
  test("entries cite the run; secret-shaped lessons mask before they land", () => {
    const runRec = done({ state: "error", endedAt: t0 + 3_700_000 });
    expect(buildLessonEntry(runRec, "check the timeout", "2026-10-19")).toBe(
      "- 2026-10-19 run 12345678 (error, 1h 1m): check the timeout",
    );
    expect(formatEntryDate(t0)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const [masked] = prepareLessonLines(['const API_KEY = "sk-live-abc"']);
    expect(masked).toBe("const API_KEY = [masked]");
    expect(prepareLessonLines(["plain words"])).toEqual(["plain words"]);
    expect(parseLessonLines("  one\n\n  \ntwo  \n")).toEqual(["one", "two"]);
    // Every smuggled separator splits: CR, CRLF, U+2028/2029 all
    // count as line breaks, so the draft count matches the server cap.
    expect(parseLessonLines("one\rtwo\r\nthree\u2028four\u2029five")).toEqual(["one", "two", "three", "four", "five"]);
    expect(prepareLessonLines(["a\rb\u2028c"])).toEqual(["a", "b", "c"]);
  });

  // Value: protects=FR2 facts line (the visible basis restates
  // outcome, elapsed, tokens — values already in the detail);
  // fails_when=the facts drift from the rendered detail.
  test("facts line restates outcome, elapsed, and tokens", () => {
    const html = renderLessonsSection(
      done({ usage: { inputTokens: 12345, outputTokens: 4077 } }),
      view(),
      t0 + 65_000,
    );
    expect(html).toContain("Done · 1m 5s · 12.3k in · 4.1k out");
    expect(tokensSummary(undefined)).toBe(RUN_TOKENS_ABSENT);
    expect(tokensSummary({ totalTokens: 16422 })).toBe("16.4k total");
    expect(tokensSummary({ inputTokens: 500 })).toBe("500 in · out —");
  });

  // Value: protects=FR9 ack surfacing (every attempt's text shows
  // in the detail flow, replacing the last; refusals keep the
  // draft); fails_when=an ack goes silent or wipes the draft.
  test("ack text surfaces in the flow; refusals keep the draft", () => {
    const html = renderLessonsSection(
      done(),
      view({ draft: "keep me", resultText: "No AGENTS.md at the repo root — create one to record lessons." }),
      t0 + 65_000,
    );
    expect(html).toContain("No AGENTS.md at the repo root — create one to record lessons.");
    expect(html).toContain(">keep me</textarea>");
    expect(html).toContain("aria-live");
  });

  // Value: protects=the ack fold (success marks recorded with a
  // clock, every text replaces the last, refusals never mark);
  // fails_when=a refusal locks the run or a success leaves it open.
  test("applyWritebackResult folds acks into the per-boot memory", () => {
    const recorded = new Map<string, number>();
    const results = new Map<string, string>();
    applyWritebackResult(recorded, results, { runId: "a", ok: false, text: "Unknown run." }, 1000);
    expect(results.get("a")).toBe("Unknown run.");
    expect(recorded.has("a")).toBe(false);
    applyWritebackResult(recorded, results, { runId: "a", ok: true, text: "Recorded 1 lesson(s) in AGENTS.md." }, 2000);
    expect(results.get("a")).toBe("Recorded 1 lesson(s) in AGENTS.md.");
    expect(recorded.get("a")).toBe(2000);
    // A later refusal for another run touches only that run.
    applyWritebackResult(recorded, results, { runId: "b", ok: false, text: "Nope." }, 3000);
    expect(recorded.has("b")).toBe(false);
    expect(recorded.get("a")).toBe(2000);
  });
});
