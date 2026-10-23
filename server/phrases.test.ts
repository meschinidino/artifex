/** PPH2/PPH4-5: batched purpose-phrase prompt, parser, test detection, runner. */
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildPhrasesPrompt,
  isTestPath,
  parsePhrasesJson,
  PHRASE_WORD_CAP,
  runPhrases,
  type PhraseBeltInput,
} from "./phrases.ts";
import { SummaryError } from "./summarize.ts";

const belt = (over: Partial<PhraseBeltInput> = {}): PhraseBeltInput => ({
  from: "a.ts",
  to: "b.ts",
  fromTest: false,
  toTest: false,
  symbols: ["A", "B"],
  total: 2,
  cites: ["line 1: import { A, B } from './b'"],
  ...over,
});

describe("isTestPath", () => {
  test("flags test files and dirs, not lookalikes", () => {
    expect(isTestPath("tests/test_bonds.py")).toBe(true);
    expect(isTestPath("floor-ui/runs.test.ts")).toBe(true);
    expect(isTestPath("table/table_test.go")).toBe(true);
    expect(isTestPath("src/tests/app.ts")).toBe(true);
    expect(isTestPath("pkg/__tests__/a.ts")).toBe(true);
    expect(isTestPath("floor-ui/wire.ts")).toBe(false);
    expect(isTestPath("tester/foo.ts")).toBe(false);
    expect(isTestPath("contest/x.ts")).toBe(false);
    expect(isTestPath("latest/results.ts")).toBe(false);
  });
});

describe("buildPhrasesPrompt", () => {
  test("numbers entries with symbols, tails, test flags, and rules", () => {
    const prompt = buildPhrasesPrompt([
      belt(),
      belt({ from: "t.test.ts", to: "s.ts", fromTest: true, symbols: [], total: 0, cites: [] }),
      belt({ from: "x.py", to: "y.py", symbols: ["f"], total: 4, cites: ["line 2: from y import f"] }),
    ]);
    expect(prompt).toContain('1. FROM "a.ts" TO "b.ts": uses A, B; evidence: line 1:');
    expect(prompt).toContain('2. FROM "t.test.ts" (TEST FILE) TO "s.ts": symbols unlisted; no cited lines');
    expect(prompt).toContain('3. FROM "x.py" TO "y.py": uses f (+3 more); evidence: line 2:');
    expect(prompt).toContain("at most 6 words");
    expect(prompt).toContain("TEST FILE");
    expect(prompt).toContain('{"1": "fetches orders", "2": "styles tables"}');
  });
});

describe("parsePhrasesJson", () => {
  test("accepts numbered phrases, drops the rest", () => {
    const map = parsePhrasesJson('{"1": "fetches orders", "2": "  styles   tables  "}', 2);
    expect(map.get(1)).toBe("fetches orders");
    expect(map.get(2)).toBe("styles tables");
    expect(PHRASE_WORD_CAP).toBe(6);
  });

  test("tolerates fences and prose wrapping", () => {
    expect(parsePhrasesJson('```json\n{"1": "fetches orders"}\n```', 1).get(1)).toBe("fetches orders");
    expect(parsePhrasesJson('Here: {"1": "fetches orders"} done', 1).get(1)).toBe("fetches orders");
  });

  test("rejects out-of-range keys, long values, and non-objects", () => {
    expect(parsePhrasesJson('{"0": "x", "3": "y", "z": "w"}', 2).size).toBe(0);
    expect(parsePhrasesJson('{"1": "one two three four five six seven"}', 1).size).toBe(0);
    expect(parsePhrasesJson('{"1": ""}', 1).size).toBe(0);
    expect(parsePhrasesJson('{"1": 5}', 1).size).toBe(0);
    expect(parsePhrasesJson("[]", 1).size).toBe(0);
    expect(parsePhrasesJson("no json here", 1).size).toBe(0);
    expect(parsePhrasesJson("", 1).size).toBe(0);
  });
});

describe("runPhrases", () => {
  afterEach(() => {
    delete process.env.ARTIFEX_PHRASES_STUB;
    delete process.env.ARTIFEX_SUMMARY_STUB;
  });

  test("stub map parses; stub error throws", async () => {
    process.env.ARTIFEX_PHRASES_STUB = '{"1": "fetches orders"}';
    const map = await runPhrases({ prompt: "p", workspace: "w", label: "l", count: 2 });
    expect(map.get(1)).toBe("fetches orders");
    process.env.ARTIFEX_PHRASES_STUB = "error";
    await expect(runPhrases({ prompt: "p", workspace: "w", label: "l", count: 2 })).rejects.toThrow(SummaryError);
  });

  test("empty map throws (nothing usable)", async () => {
    process.env.ARTIFEX_PHRASES_STUB = "{}";
    await expect(runPhrases({ prompt: "p", workspace: "w", label: "l", count: 2 })).rejects.toThrow(
      "no usable phrases",
    );
  });

  test("spawn seam feeds the parser; timeout and exit codes throw", async () => {
    const ok = await runPhrases({
      prompt: "p",
      workspace: "w",
      label: "l",
      count: 1,
      spawn: () => ({ result: async () => ({ out: '{"1": "sends chequera"}', err: "", code: 0 }), kill: () => {} }),
    });
    expect(ok.get(1)).toBe("sends chequera");
    await expect(
      runPhrases({
        prompt: "p",
        workspace: "w",
        label: "l",
        count: 1,
        spawn: () => ({ result: async () => ({ out: "", err: "boom", code: 1 }), kill: () => {} }),
      }),
    ).rejects.toThrow(SummaryError);
    await expect(
      runPhrases({
        prompt: "p",
        workspace: "w",
        label: "l",
        count: 1,
        timeoutMs: 20,
        spawn: () => ({ result: () => new Promise(() => {}), kill: () => {} }),
      }),
    ).rejects.toThrow("timed out");
  });
});
