/**
 * Session viewer rendering: escaped markup over wire RunRecords.
 * Pure builders, no DOM — the app wires toggle and selection.
 */
import { describe, expect, test } from "bun:test";
import {
  escapeHtml,
  formatClock,
  formatCompact,
  formatElapsed,
  renderRunDetail,
  renderRunsList,
  renderTokensCell,
  runStateLabel,
  runTitle,
  RUNS_EMPTY,
  RUN_TOKENS_ABSENT,
} from "./runs.ts";
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
