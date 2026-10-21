import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SUMMARY_CACHE_SIZE,
  SUMMARY_CONTENT_CHARS,
  SUMMARY_TEXT_CHARS,
  SummaryCache,
  SummaryError,
  breakSummaryLines,
  buildBeltPrompt,
  buildFilePrompt,
  formatSummaryJson,
  runSummary,
  summaryEffort,
  summaryKey,
  type RunSpawn,
} from "./summarize.ts";
import { createFloorServer, type FloorServer } from "./index.ts";
import { authedClient, byPath, closeAllClients } from "./test-client.ts";

let floor: FloorServer | undefined;
let repo: string | undefined;

afterEach(() => {
  closeAllClients();
  floor?.stop();
  floor = undefined;
  if (repo) rmSync(repo, { recursive: true, force: true });
  repo = undefined;
});

const neighbor = (i: number) => ({ path: `src/n${i}.ts`, via: [`line ${i}: import x`, `uses a, b`] });

describe("buildFilePrompt", () => {
  // Value: protects=file summary grounding (role-in-system prompt
  // with capped content + belt neighbors carrying uses evidence);
  // fails_when=caps drift, neighbors drop, or the format contract
  // changes silently; why_new=summaries SUM2.
  test("assembles path, zone, footprint, content, and capped neighbors", () => {
    const incoming = Array.from({ length: 12 }, (_, i) => neighbor(i));
    const p = buildFilePrompt({
      path: "src/store.ts",
      zoneId: "src",
      foot: "MODIFIED vs HEAD",
      binary: false,
      content: "export const x = 1;\n",
      contentTruncated: false,
      incoming,
      outgoing: [{ path: "lib/util.ts", via: ["line 1: import { h } from"] }],
    });
    expect(p).toContain("FILE: src/store.ts (area src on the map, a changed file)");
    expect(p).toContain("export const x = 1;");
    expect(p).toContain("FILES THAT USE THIS FILE");
    expect(p).toContain("src/n0.ts");
    expect(p).toContain("(+2 more)");
    expect(p).not.toContain("src/n10.ts");
    expect(p).toContain("FILES THIS FILE USES");
    expect(p).toContain("lib/util.ts");
    expect(p).toContain("Reply with ONLY this JSON object");
    expect(p).toContain('{"what":');
    expect(p).toContain("short file name");
    expect(p).toContain("not a programmer");
    // The jargon ban names the words; the context lines themselves
    // must not feed them to the model.
    expect(p).toContain("Never use programmer words");
    expect(p).not.toContain("INCOMING BELTS");
  });

  test("caps content, flags binary, caps via per neighbor", () => {
    const p = buildFilePrompt({
      path: "big.ts",
      zoneId: "src",
      binary: false,
      content: "x".repeat(SUMMARY_CONTENT_CHARS + 100),
      contentTruncated: true,
      incoming: [{ path: "a.ts", via: ["1", "2", "3", "4", "5"] }],
      outgoing: [],
    });
    expect(p).toContain("truncated");
    expect(p).not.toContain("x".repeat(SUMMARY_CONTENT_CHARS + 100));
    expect(p).toContain("1; 2; 3; 4");
    expect(p).not.toMatch(/4; 5/);
    const bin = buildFilePrompt({
      path: "a.bin",
      zoneId: "src",
      binary: true,
      content: "",
      contentTruncated: false,
      incoming: [],
      outgoing: [],
    });
    expect(bin).toContain("not readable as text");
    expect(bin).not.toContain("binary file");
  });
});

describe("buildBeltPrompt", () => {
  // Value: protects=belt summary grounding (endpoints, kinds,
  // evidence, fan context); fails_when=evidence or fan context
  // drops; why_new=summaries SUM3.
  test("assembles endpoints, edges, and fan context with caps", () => {
    const p = buildBeltPrompt({
      fromPath: "src/a.ts",
      toPath: "src/b.ts",
      edges: [
        { kind: "IMPORT", via: ["line 1: import { h }"] },
        { kind: "HTTP CALL", via: ["GET /x — line 4: fetch"] },
      ],
      fromContent: "const a = route();\n",
      toContent: "",
      fromFan: { inCount: 2, outCount: 9, neighbors: ["n1", "n2", "n3", "n4", "n5", "n6"] },
      toFan: { inCount: 1, outCount: 0, neighbors: [] },
    });
    expect(p).toContain("FROM: src/a.ts");
    expect(p).toContain("TO: src/b.ts");
    expect(p).toContain("takes code from: line 1");
    expect(p).toContain("calls over the network: GET /x");
    expect(p).toContain("it is used by 2 files and uses 9 files");
    expect(p).toContain("n1, n2, n3, n4, n5");
    expect(p).not.toContain("n6");
    expect(p).toContain("Reply with ONLY this JSON object");
    expect(p).toContain('{"flows":');
    expect(p).toContain("Never use programmer words");
    expect(p).not.toContain("BELTS ON THIS PAIR");
    expect(p).toContain("FIRST FILE CONTENT");
    expect(p).toContain("const a = route();");
    expect(p).toContain("SECOND FILE CONTENT: (not shown)");
  });
});

describe("summaryKey + SummaryCache", () => {
  test("key is a stable content hash", () => {
    expect(summaryKey("abc")).toBe(summaryKey("abc"));
    expect(summaryKey("abc")).toHaveLength(40);
    expect(summaryKey("abc")).not.toBe(summaryKey("abd"));
  });

  test("cache hits, misses, and evicts oldest past the cap", () => {
    const cache = new SummaryCache(2);
    expect(cache.get("k")).toBeUndefined();
    cache.set("a", { text: "A", generatedAt: "t0" });
    cache.set("b", { text: "B", generatedAt: "t0" });
    expect(cache.size).toBe(2);
    cache.set("c", { text: "C", generatedAt: "t0" });
    expect(cache.size).toBe(2);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("c")).toEqual({ text: "C", generatedAt: "t0" });
    expect(SUMMARY_CACHE_SIZE).toBeGreaterThan(0);
  });
});

describe("breakSummaryLines", () => {
  // Value: protects=the readable 3-line layout when the model
  // answers in one paragraph (seen live); fails_when=the split
  // misses a label set or mangles already-broken text.
  test("splits a single-paragraph answer; leaves the rest alone", () => {
    const beltPara = "What flows: a gets b from c. Why it exists: a needs it. If it broke: a stops.";
    expect(breakSummaryLines(beltPara)).toBe(
      "What flows: a gets b from c.\nWhy it exists: a needs it.\nIf it broke: a stops.",
    );
    const filePara = "What it does: x. Why it matters: y. How it fits: z.";
    expect(breakSummaryLines(filePara)).toBe("What it does: x.\nWhy it matters: y.\nHow it fits: z.");
    const broken = "What flows: a.\nWhy it exists: b.\nIf it broke: c.";
    expect(breakSummaryLines(broken)).toBe(broken);
    expect(breakSummaryLines("plain prose, no labels")).toBe("plain prose, no labels");
    expect(breakSummaryLines("What flows: only one label here")).toBe("What flows: only one label here");
  });
});

describe("formatSummaryJson", () => {
  // Value: protects=the structured-answer seam (fixed keys in,
  // guaranteed labeled lines out); fails_when=valid JSON is
  // rejected, junk is accepted, or labels drift.
  test("accepts exact, fenced, and wrapped JSON; rejects the rest", () => {
    expect(formatSummaryJson('{"what": "a", "why": "b", "fits": "c"}')).toBe(
      "What it does: a\nWhy it matters: b\nHow it fits: c",
    );
    expect(formatSummaryJson('```json\n{"flows": "a", "why": "b", "broke": "c"}\n```')).toBe(
      "What flows: a\nWhy it exists: b\nIf it broke: c",
    );
    expect(formatSummaryJson('Here it is:\n{"what": "a", "why": "b", "fits": "c"}\nHope that helps.')).toBe(
      "What it does: a\nWhy it matters: b\nHow it fits: c",
    );
    expect(formatSummaryJson("plain prose")).toBeUndefined();
    expect(formatSummaryJson('{"what": "a"}')).toBeUndefined();
    expect(formatSummaryJson('{"what": "a", "why": "", "fits": "c"}')).toBeUndefined();
    expect(formatSummaryJson('{"what": "a", "why": 3, "fits": "c"}')).toBeUndefined();
    expect(formatSummaryJson("[1, 2]")).toBeUndefined();
    expect(formatSummaryJson('{"a": }')).toBeUndefined();
  });
});

describe("summaryEffort", () => {
  const saved = process.env.ARTIFEX_SUMMARY_EFFORT;
  afterEach(() => {
    if (saved === undefined) delete process.env.ARTIFEX_SUMMARY_EFFORT;
    else process.env.ARTIFEX_SUMMARY_EFFORT = saved;
  });

  // Value: protects=the user-tunable effort seam (default medium,
  // valid override, invalid falls back instead of failing the run);
  // fails_when=the default, the whitelist, or the fallback drifts.
  test("defaults to medium; valid values pass, the rest fall back", () => {
    delete process.env.ARTIFEX_SUMMARY_EFFORT;
    expect(summaryEffort()).toBe("medium");
    process.env.ARTIFEX_SUMMARY_EFFORT = "low";
    expect(summaryEffort()).toBe("low");
    process.env.ARTIFEX_SUMMARY_EFFORT = "  HIGH ";
    expect(summaryEffort()).toBe("high");
    process.env.ARTIFEX_SUMMARY_EFFORT = "turbo";
    expect(summaryEffort()).toBe("medium");
  });
});

describe("runSummary", () => {
  const savedStub = process.env.ARTIFEX_SUMMARY_STUB;
  const savedEffort = process.env.ARTIFEX_SUMMARY_EFFORT;
  afterEach(() => {
    if (savedStub === undefined) delete process.env.ARTIFEX_SUMMARY_STUB;
    else process.env.ARTIFEX_SUMMARY_STUB = savedStub;
    if (savedEffort === undefined) delete process.env.ARTIFEX_SUMMARY_EFFORT;
    else process.env.ARTIFEX_SUMMARY_EFFORT = savedEffort;
  });
  const fakeSpawn = (out: string, code: number | null = 0, err = ""): RunSpawn => {
    const calls: string[][] = [];
    const fn = ((cmd: string[]) => {
      calls.push(cmd);
      return { result: async () => ({ out, err, code }), kill: () => {} };
    }) as RunSpawn & { calls: string[][] };
    fn.calls = calls;
    return fn;
  };

  test("success trims, caps, and passes prompt-file + workspace (never argv text)", async () => {
    delete process.env.ARTIFEX_SUMMARY_STUB;
    delete process.env.ARTIFEX_SUMMARY_EFFORT;
    const spawn = fakeSpawn(`  hello world  \n`);
    const r = await runSummary({ prompt: "PROMPT BODY", workspace: "/repo", label: "f.ts", spawn });
    expect(r.text).toBe("hello world");
    const [cmd] = (spawn as unknown as { calls: string[][] }).calls;
    expect(cmd![0]).toBe("muse");
    expect(cmd).toContain("exec");
    expect(cmd).toContain("--prompt-file");
    expect(cmd).toContain("/repo");
    expect(cmd!.join(" ")).not.toContain("PROMPT BODY");
    // Default effort rides along; an override replaces it.
    expect(cmd!.join(" ")).toContain("--reasoning-effort medium");
    process.env.ARTIFEX_SUMMARY_EFFORT = "low";
    const spawn2 = fakeSpawn("ok\n");
    await runSummary({ prompt: "p", workspace: "/r", label: "l", spawn: spawn2 });
    const [cmd2] = (spawn2 as unknown as { calls: string[][] }).calls;
    expect(cmd2!.join(" ")).toContain("--reasoning-effort low");
    const long = await runSummary({
      prompt: "p",
      workspace: "/r",
      label: "l",
      spawn: fakeSpawn("y".repeat(SUMMARY_TEXT_CHARS + 50)),
    });
    expect(long.text).toBe(`${"y".repeat(SUMMARY_TEXT_CHARS - 1)}…`);
  });

  test("JSON answers render as labeled lines; prose falls back to raw", async () => {
    delete process.env.ARTIFEX_SUMMARY_STUB;
    const json = await runSummary({
      prompt: "p",
      workspace: "/r",
      label: "l",
      spawn: fakeSpawn('{"flows": "a", "why": "b", "broke": "c"}\n'),
    });
    expect(json.text).toBe("What flows: a\nWhy it exists: b\nIf it broke: c");
    const prose = await runSummary({ prompt: "p", workspace: "/r", label: "l", spawn: fakeSpawn("just prose\n") });
    expect(prose.text).toBe("just prose");
  });

  test("nonzero exit, empty output, and timeout throw SummaryError", async () => {
    delete process.env.ARTIFEX_SUMMARY_STUB;
    await expect(runSummary({ prompt: "p", workspace: "/r", label: "l", spawn: fakeSpawn("", 3, "boom") })).rejects.toThrow(
      SummaryError,
    );
    await expect(runSummary({ prompt: "p", workspace: "/r", label: "l", spawn: fakeSpawn("", 3, "boom") })).rejects.toThrow(
      /boom/,
    );
    await expect(runSummary({ prompt: "p", workspace: "/r", label: "l", spawn: fakeSpawn("   \n") })).rejects.toThrow(
      /empty/,
    );
    let killed = false;
    const hanging: RunSpawn = () => ({ result: () => new Promise(() => {}), kill: () => { killed = true; } });
    await expect(
      runSummary({ prompt: "p", workspace: "/r", label: "l", spawn: hanging, timeoutMs: 20 }),
    ).rejects.toThrow(/timed out/);
    expect(killed).toBe(true);
  });

  test("stub modes: canned text and forced error", async () => {
    process.env.ARTIFEX_SUMMARY_STUB = "1";
    let spawned = false;
    const spy: RunSpawn = () => {
      spawned = true;
      return { result: async () => ({ out: "", err: "", code: 0 }), kill: () => {} };
    };
    expect((await runSummary({ prompt: "p", workspace: "/r", label: "a.ts", spawn: spy })).text).toBe(
      "STUB summary for a.ts",
    );
    expect(spawned).toBe(false);
    process.env.ARTIFEX_SUMMARY_STUB = "error";
    await expect(runSummary({ prompt: "p", workspace: "/r", label: "a.ts", spawn: spy })).rejects.toThrow(SummaryError);
  });
});

describe("get-summary round trip (SUM1/SUM6)", () => {
  const savedStub = process.env.ARTIFEX_SUMMARY_STUB;
  afterEach(() => {
    if (savedStub === undefined) delete process.env.ARTIFEX_SUMMARY_STUB;
    else process.env.ARTIFEX_SUMMARY_STUB = savedStub;
  });

  async function boot() {
    const dir = mkdtempSync(join(tmpdir(), "artifex-summary-"));
    repo = dir;
    writeFileSync(join(dir, "b.ts"), `export const b = 1;\n`);
    writeFileSync(join(dir, "a.ts"), `import "./b";\nconst x = 1;\n`);
    floor = await createFloorServer({ repo, port: 0 });
    return authedClient(floor);
  }

  // Value: protects=summary request/response + cache flag over the
  // real socket (stubbed runner, no agent spawn); fails_when=the
  // message contract, target validation, or caching breaks;
  // why_new=summaries SUM1/SUM6.
  test("file summary answers over the socket and caches by content", async () => {
    process.env.ARTIFEX_SUMMARY_STUB = "1";
    const { client } = await boot();
    let mark = client.messages.length;
    client.send({ v: 1, type: "get-summary", target: { kind: "file", path: "a.ts" } });
    const first = (await client.waitFor((m) => m.type === "summary", "summary", 10_000, mark)) as {
      target: unknown;
      text: string;
      cached: boolean;
      generatedAt: string;
    };
    expect(first.target).toEqual({ kind: "file", path: "a.ts" });
    expect(first.text).toBe("STUB summary for a.ts");
    expect(first.cached).toBe(false);
    expect(first.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    mark = client.messages.length;
    client.send({ v: 1, type: "get-summary", target: { kind: "file", path: "a.ts" } });
    const second = (await client.waitFor((m) => m.type === "summary", "summary", 10_000, mark)) as { cached: boolean };
    expect(second.cached).toBe(true);
  }, 30_000);

  test("belt summary echoes the pair; gone belt and bad targets error", async () => {
    process.env.ARTIFEX_SUMMARY_STUB = "1";
    const { client, snapshot } = await boot();
    const idOf = (path: string) => byPath(snapshot.buildings).get(path)!.id;
    let mark = client.messages.length;
    client.send({ v: 1, type: "get-summary", target: { kind: "belt", fromId: idOf("a.ts"), toId: idOf("b.ts") } });
    const msg = (await client.waitFor((m) => m.type === "summary", "belt summary", 10_000, mark)) as { text: string };
    expect(msg.text).toBe("STUB summary for a.ts → b.ts");
    const askError = async (target: unknown) => {
      const at = client.messages.length;
      client.send({ v: 1, type: "get-summary", target });
      return (await client.waitFor((m) => m.type === "error", "summary error", 10_000, at)) as {
        code: string;
        message: string;
      };
    };
    expect((await askError({ kind: "belt", fromId: idOf("a.ts"), toId: "bX" })).code).toBe("not-found");
    expect((await askError({ kind: "file", path: "missing.ts" })).code).toBe("not-found");
    expect((await askError({ kind: "nope" })).code).toBe("bad-message");
    expect((await askError("a.ts")).code).toBe("bad-message");
  }, 30_000);

  test("stub error mode surfaces summary-failed", async () => {
    process.env.ARTIFEX_SUMMARY_STUB = "error";
    const { client } = await boot();
    const mark = client.messages.length;
    client.send({ v: 1, type: "get-summary", target: { kind: "file", path: "a.ts" } });
    const err = (await client.waitFor((m) => m.type === "error", "summary error", 10_000, mark)) as { code: string };
    expect(err.code).toBe("summary-failed");
  }, 30_000);
});
