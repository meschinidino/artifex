import { describe, expect, test } from "bun:test";
import { formatTrace, TRACE_SECTION_CAP, TRACE_TOTAL_BYTES, type TraceInput } from "./format.ts";

function input(over: Partial<TraceInput> = {}): TraceInput {
  return {
    path: "shop/OrderController.java",
    repo: "",
    imports: [],
    importedBy: [],
    endpoints: [],
    callsOut: [],
    tables: [],
    topics: [],
    unresolvedImports: 0,
    unresolvedDynamics: 0,
    ...over,
  };
}

describe("formatTrace", () => {
  test("pins the worked example byte-exact", () => {
    // Value: protects=the normative FR1-FR12 shape end to end;
    // fails_when=any heading, anchor, or marker drifts
    const got = formatTrace(input({
      imports: [
        { target: "shop/model/Order.java", line: 4 },
        { target: "shop/OrderService.java", line: 3 },
      ],
      importedBy: [{ path: "shop/AdminController.java", line: 5 }],
      endpoints: [{
        method: "GET",
        route: "/api/shop/order/{id}",
        line: 7,
        handler: "byId",
        tables: [{ table: "orders", access: "read" }],
        callers: [{ path: "sender:shop/OrderClient.java", line: 4, caller: "byId", via: "feign" }],
      }],
      tables: [{ table: "orders", access: "read", via: "entity", through: "OrderController", implicit: false }],
      unresolvedImports: 1,
    }));
    expect(got).toBe(
      [
        "# trace: shop/OrderController.java",
        "floor: (single)",
        "## imports (2)",
        "- shop/OrderService.java:3",
        "- shop/model/Order.java:4",
        "## imported by (1)",
        "- shop/AdminController.java:5",
        "## endpoints (1)",
        "- GET /api/shop/order/{id} shop/OrderController.java:7 → byId → tables: orders (read)",
        "  ← sender:shop/OrderClient.java:4 byId (feign)",
        "## calls out (0)",
        "none",
        "## tables (1)",
        "- orders read via entity through OrderController",
        "## topics (0)",
        "none",
        "## unresolved",
        "1 unresolved import(s)",
        "",
      ].join("\n"),
    );
  });

  test("section order is fixed and empty sections render none", () => {
    // Value: protects=FR1 order + FR3-FR8 empty bodies; fails_when=a section moves or empties silently
    const lines = formatTrace(input({ repo: "shop" })).split("\n");
    expect(lines).toEqual([
      "# trace: shop/OrderController.java",
      "floor: shop",
      "## imports (0)",
      "none",
      "## imported by (0)",
      "none",
      "## endpoints (0)",
      "none",
      "## calls out (0)",
      "none",
      "## tables (0)",
      "none",
      "## topics (0)",
      "none",
      "",
    ]);
  });

  test("unproven imports name the reason, never a zero-imports claim", () => {
    // Value: protects=FR3 honesty for error/unparsed/binary files; fails_when=unproven renders none or (0)
    for (const reason of ["parse-error", "unparsed", "binary"] as const) {
      const got = formatTrace(input({ imports: { unproven: reason } }));
      expect(got).toContain(`## imports (?)\nunproven (${reason})\n`);
      expect(got).not.toContain("## imports (0)");
    }
  });

  test("lists sort deterministically regardless of input order", () => {
    // Value: protects=FR12 (no caller order leaks); fails_when=output follows input order
    const fwd = input({
      imports: [{ target: "b.ts", line: 2 }, { target: "a.ts", line: 9 }, { target: "a.ts", line: 1 }],
      importedBy: [{ path: "d.ts", line: 1 }, { path: "c.ts", line: 5 }],
      endpoints: [
        { method: "POST", route: "/z", line: 1, handler: "z", tables: [], callers: [] },
        { method: "GET", route: "/z", line: 2, handler: "z", tables: [], callers: [] },
        { method: "GET", route: "/a", line: 3, handler: "a", tables: [], callers: [] },
      ],
      callsOut: [
        { method: "GET", path: "/z", line: 9, via: "fetch", caller: "", matchedPath: "x.ts" },
        { method: "GET", path: "/a", line: 1, via: "fetch", caller: "", targetService: "svc" },
      ],
      tables: [
        { table: "b", access: "read", via: "entity", through: "C", implicit: false },
        { table: "a", access: "write", via: "entity", through: "C", implicit: true },
      ],
      topics: [{ topic: "b", direction: "produce", handler: "", peers: [] }, { topic: "a", direction: "consume", handler: "h", peers: ["z", "y"] }],
    });
    const rev = input({
      imports: [...fwd.imports as { target: string; line: number }[]].reverse(),
      importedBy: [...fwd.importedBy].reverse(),
      endpoints: [...fwd.endpoints].reverse(),
      callsOut: [...fwd.callsOut].reverse(),
      tables: [...fwd.tables].reverse(),
      topics: [...fwd.topics].reverse(),
    });
    const a = formatTrace(fwd);
    expect(formatTrace(rev)).toBe(a);
    expect(a).toContain("- a.ts:1\n- a.ts:9\n- b.ts:2\n");
    expect(a).toContain("- c.ts:5\n- d.ts:1\n");
    expect(a).toContain("- GET /a shop/OrderController.java:3 → a\n");
    const epIdx = (route: string, method: string) => a.indexOf(`- ${method} ${route} `);
    expect(epIdx("/a", "GET")).toBeLessThan(epIdx("/z", "GET"));
    expect(epIdx("/z", "GET")).toBeLessThan(epIdx("/z", "POST"));
    expect(a).toContain("- GET /a shop/OrderController.java:1 (fetch) → svc (not in indexed repos)\n");
    expect(a).toContain("- a write via entity through C (implicit name)\n- b read via entity through C\n");
    expect(a).toContain("- a consume (h) · peers: y, z\n- b produce\n");
  });

  test("endpoint rows omit the tables suffix when none are proven and callers ride along", () => {
    // Value: protects=FR5 row shapes (suffix omission, caller indent, empty-caller/handler fallbacks);
    // fails_when=a row gains a phantom suffix or a double space
    const got = formatTrace(input({
      path: "c.ts",
      endpoints: [{
        method: "GET",
        route: "/x",
        line: 3,
        handler: "",
        tables: [],
        callers: [
          { path: "b.ts", line: 1, caller: "", via: "fetch" },
          { path: "a.ts", line: 2, caller: "go", via: "http" },
        ],
      }],
    }));
    expect(got).toContain("- GET /x c.ts:3 → ?\n  ← a.ts:2 go (http)\n  ← b.ts:1 (fetch)\n");
  });

  test("calls out cite the exporting file and resolve destinations honestly", () => {
    // Value: protects=FR6 rows (file:line anchor, caller omission, dest kinds);
    // fails_when=a dest guesses or the anchor drops
    const got = formatTrace(input({
      path: "c.ts",
      callsOut: [
        { method: "POST", path: "/a", line: 1, via: "feign", caller: "save", matchedPath: "svc:api.ts" },
        { method: "GET", path: "/b", line: 2, via: "fetch", caller: "" },
      ],
    }));
    expect(got).toContain("- POST /a c.ts:1 (feign, save) → svc:api.ts\n");
    expect(got).toContain("- GET /b c.ts:2 (fetch) → unresolved\n");
  });

  test("sections cap at 50 entries with a truthful +N more", () => {
    // Value: protects=FR10 per-section cap (title counts stay truthful);
    // fails_when=the 51st entry renders or the count lies
    const many = Array.from({ length: 63 }, (_, i) => ({ target: `f${String(i).padStart(2, "0")}.ts`, line: 1 }));
    const got = formatTrace(input({ imports: many }));
    expect(got).toContain("## imports (63)\n");
    expect(got).toContain("+13 more\n");
    expect(got).not.toContain("f62.ts");
    expect(got).toContain("- f49.ts:1\n+13 more\n");
  });

  test("endpoint caps count entries, with caller lines riding along", () => {
    // Value: protects=FR10 atomicity (caller sub-rows never orphan or split the cap);
    // fails_when=callers count as entries or strand without their endpoint
    const endpoints = Array.from({ length: 55 }, (_, i) => ({
      method: "GET",
      route: `/r${String(i).padStart(2, "0")}`,
      line: 1,
      handler: "h",
      tables: [],
      callers: [{ path: "c.ts", line: 1, caller: "h", via: "fetch" }],
    }));
    const got = formatTrace(input({ endpoints }));
    expect(got).toContain("## endpoints (55)\n");
    expect(got).toContain("+5 more\n");
    // The 50th endpoint keeps its caller line directly above the marker.
    expect(got).toContain("- GET /r49 shop/OrderController.java:1 → h\n  ← c.ts:1 h (fetch)\n+5 more\n");
  });

  test("output past 32 KiB stops at a section boundary with a marker", () => {
    // Value: protects=FR10 total cap (atomic sections, final marker line, byte-exact bound);
    // fails_when=a row is cut mid-line or the output exceeds the cap
    const pad = (n: number) => `long/${"p".repeat(400)}/${n}.ts`;
    const got = formatTrace(input({
      imports: Array.from({ length: 50 }, (_, i) => ({ target: pad(i), line: 1 })),
      importedBy: Array.from({ length: 50 }, (_, i) => ({ path: pad(i + 100), line: 2 })),
      endpoints: Array.from({ length: 50 }, (_, i) => ({
        method: "GET",
        route: `/r${i}`,
        line: 1,
        handler: "h",
        tables: [],
        callers: [],
      })),
    }));
    expect(Buffer.byteLength(got, "utf8")).toBeLessThanOrEqual(TRACE_TOTAL_BYTES);
    expect(got.endsWith("… truncated (1 of 6 sections)\n")).toBe(true);
    // The imports section rendered whole (all 50 rows present).
    expect(got).toContain("- long/pppp");
    expect(got).not.toContain("## imported by");
    expect(got.split("\n").filter((l) => l.startsWith("- long/")).length).toBe(TRACE_SECTION_CAP);
  });

  test("the unresolved section omits only when both counts are zero", () => {
    // Value: protects=FR9 (omissible section, per-kind lines); fails_when=an empty section renders or a kind drops
    expect(formatTrace(input())).not.toContain("## unresolved");
    expect(formatTrace(input({ unresolvedDynamics: 2 }))).toContain("## unresolved\n2 dynamic connection(s) not guessed\n");
    const both = formatTrace(input({ unresolvedImports: 1, unresolvedDynamics: 2 }));
    expect(both).toContain("## unresolved\n1 unresolved import(s)\n2 dynamic connection(s) not guessed\n");
  });

  test("double formatting is byte-identical and emits no trailing whitespace", () => {
    // Value: protects=FR12 determinism + FR2 whitespace rule; fails_when=clock/map order leaks or a row pads
    const rich = input({
      imports: [{ target: "b.ts", line: 2 }],
      importedBy: [{ path: "a.ts", line: 1 }],
      endpoints: [{
        method: "GET",
        route: "/x",
        line: 1,
        handler: "h",
        tables: [{ table: "t", access: "read" }],
        callers: [{ path: "c.ts", line: 4, caller: "h", via: "fetch" }],
      }],
      callsOut: [{ method: "GET", path: "/y", line: 2, via: "http", caller: "h", matchedPath: "d.ts" }],
      tables: [{ table: "t", access: "read", via: "entity", through: "C", implicit: false }],
      topics: [{ topic: "t", direction: "produce", handler: "h", peers: ["p"] }],
      unresolvedImports: 1,
      unresolvedDynamics: 1,
    });
    const a = formatTrace(rich);
    expect(formatTrace(rich)).toBe(a);
    for (const line of a.split("\n")) expect(line).not.toMatch(/ $/);
    expect(a.endsWith("\n")).toBe(true);
  });

  test("no output line carries source statement text beyond structural tokens", () => {
    // Value: protects=FR11 (structure only — an `import { x } from`
    // line surfaces only as its target path + line);
    // fails_when=statement text, literals, or comments leak in
    const source = [
      'import { x } from "./mod"; // fetch the thing',
      'const SECRET = "sk-live-123";',
      "from pkg import (a, b)",
    ];
    const got = formatTrace(input({
      path: "a.ts",
      imports: [{ target: "mod.ts", line: 1 }],
      importedBy: [{ path: "b.ts", line: 3 }],
      endpoints: [{
        method: "GET",
        route: "/api/x",
        line: 9,
        handler: "getX",
        tables: [{ table: "widgets", access: "read" }],
        callers: [{ path: "c.ts", line: 2, caller: "load", via: "fetch" }],
      }],
      tables: [{ table: "widgets", access: "read", via: "entity", through: "X", implicit: false }],
      topics: [{ topic: "events", direction: "consume", handler: "onEvent", peers: [] }],
      unresolvedImports: 1,
    }));
    // Structural tokens surface; statement text never does.
    expect(got).toContain("mod.ts:1");
    for (const fragment of ["import { x }", "fetch the thing", "sk-live-123", "from pkg import", "const SECRET"]) {
      expect(got).not.toContain(fragment);
    }
    for (const line of source) expect(got.split("\n")).not.toContain(line);
  });

  test("unlined type uses render honestly and count toward the total", () => {
    // Value: protects=FR3/FR4 honesty for wildcard/same-package
    // JVM edges (proven, no statement line); fails_when=they
    // vanish into a false none or skip the count
    const got = formatTrace(input({
      imports: [
        { target: "shop/Wild.java", line: null },
        { target: "shop/Lined.java", line: 3 },
        { target: "shop/Wild.java", line: 9 },
      ],
      importedBy: [
        { path: "shop/User.java", line: null },
        { path: "shop/Direct.java", line: 2 },
      ],
    }));
    expect(got).toContain("## imports (3)\n- shop/Lined.java:3\n- shop/Wild.java:9\n- shop/Wild.java (type use, no import line)\n");
    expect(got).toContain("## imported by (2)\n- shop/Direct.java:2\n- shop/User.java (type use, no import line)\n");
    // Every edge unlined still names its target — never `none`.
    const all = formatTrace(input({ imports: [{ target: "shop/Wild.java", line: null }] }));
    expect(all).toContain("## imports (1)\n- shop/Wild.java (type use, no import line)\n");
  });

  test("routes and call paths strip queries/fragments and mask secret pairs", () => {
    // Value: protects=F4/D18 (no ?api_key=secret in exports);
    // fails_when=a query value, fragment, or secret pair renders
    const got = formatTrace(input({
      endpoints: [{
        method: "GET",
        route: "/api/x?api_key=secret#frag",
        line: 1,
        handler: "h",
        tables: [],
        callers: [],
      }],
      callsOut: [
        { method: "GET", path: "https://api.example.com/v1/items?token=abc&n=1", line: 2, via: "fetch", caller: "", matchedPath: "d.ts" },
        { method: "GET", path: "/dl/token=abc123/f", line: 3, via: "fetch", caller: "c", matchedPath: "d.ts" },
      ],
    }));
    expect(got).toContain("- GET /api/x shop/OrderController.java:1 → h\n");
    expect(got).toContain("- GET https://api.example.com/v1/items shop/OrderController.java:2 (fetch) → d.ts\n");
    expect(got).toContain("- GET /dl/token=[masked]/f shop/OrderController.java:3 (fetch, c) → d.ts\n");
    for (const leaked of ["api_key=secret", "token=abc", "#frag", "?token", "abc123"]) {
      expect(got).not.toContain(leaked);
    }
  });

  test("markdown metacharacters in derived strings render escaped", () => {
    // Value: protects=FR11 injection resistance (no [x](y) links,
    // code spans, or tags smuggled in); fails_when=a raw special
    // reaches the output
    const got = formatTrace(input({
      path: "evil[0].ts",
      imports: [{ target: "x[link](y)*z_q`w`v~u!t|s<r>t", line: 1 }],
      tables: [{ table: "a*b", access: "read", via: "entity", through: "C<d>", implicit: false }],
      topics: [{ topic: "t|u", direction: "consume", handler: "h(w)", peers: ["p`q"] }],
    }));
    expect(got).toContain("# trace: evil\\[0\\].ts\n");
    expect(got).toContain("- x\\[link\\]\\(y\\)\\*z\\_q\\`w\\`v\\~u\\!t\\|s\\<r\\>t:1\n");
    expect(got).toContain("- a\\*b read via entity through C\\<d\\>\n");
    expect(got).toContain("- t\\|u consume (h\\(w\\)) · peers: p\\`q\n");
    for (const raw of ["[link](y)", "evil[0]", "a*b", "C<d>", "t|u", "h(w)", "p`q"]) {
      expect(got).not.toContain(raw);
    }
    expect(got).not.toContain("](");
  });

  test("entries with control characters drop; identities substitute", () => {
    // Value: protects=FR11 one-line-per-row (no smuggled breaks);
    // fails_when=a newline/CTl survives or a count lies
    const LF = String.fromCharCode(10);
    const CR = String.fromCharCode(13);
    const NUL = String.fromCharCode(0);
    const DEL = String.fromCharCode(127);
    const LS = String.fromCharCode(0x2028);
    const got = formatTrace(input({
      path: `ok${LF}evil.ts`,
      imports: [{ target: `bad${LF}line.ts`, line: 1 }, { target: "ok.ts", line: 2 }],
      importedBy: [{ path: `d${DEL}rop.ts`, line: 3 }],
      endpoints: [{
        method: "GET",
        route: "/x",
        line: 1,
        handler: "h",
        tables: [{ table: `t${NUL}able`, access: "read" }, { table: "kept", access: "read" }],
        callers: [
          { path: `c${CR}all.ts`, line: 1, caller: "h", via: "fetch" },
          { path: "fine.ts", line: 2, caller: `c${LS}aller`, via: "fetch" },
          { path: "fine.ts", line: 3, caller: "h", via: "fetch" },
        ],
      }],
      topics: [{ topic: "t", direction: "consume", handler: "h", peers: [`p${NUL}eer`, "kept-peer"] }],
    }));
    // The header names its file with the break substituted, not dropped.
    expect(got.split("\n")[0]).toBe(`# trace: ok${String.fromCharCode(0xfffd)}evil.ts`);
    expect(got).toContain("## imports (1)\n- ok.ts:2\n");
    expect(got).toContain("## imported by (0)\nnone\n");
    expect(got).toContain("→ tables: kept (read)\n");
    expect(got).toContain("  ← fine.ts:3 h (fetch)\n");
    expect(got).not.toContain("fine.ts:2");
    expect(got).toContain("· peers: kept-peer\n");
    // (Dropped table/peer remnants are pinned by the exact-suffix
    // assertions above; their fragments collide with fixed words.)
    for (const leaked of ["bad", "line.ts", "rop.ts", "all.ts", "aller"]) {
      expect(got).not.toContain(leaked);
    }
    const bare = got.replaceAll("\n", "");
    expect(bare).not.toContain(LF);
    expect(bare).not.toContain(CR);
    expect(bare).not.toContain(NUL);
    expect(bare).not.toContain(DEL);
    expect(bare).not.toContain(LS);
  });

  test("adversarial inputs never break line structure (property)", () => {
    // Value: protects=FR11 injection resistance over generated
    // hostile strings; fails_when=a value smuggles a line break,
    // control char, or raw markdown structure into the export
    let seed = 0x12345678;
    const rand = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const alphabet = [
      "a", "/", ".", "-", "_", "{", "}", ":", " ", "→",
      "\\", "`", "*", "~", "[", "]", "(", ")", "<", ">", "!", "|", "?", "#", "=", ";",
      String.fromCharCode(10), String.fromCharCode(13), String.fromCharCode(0),
      String.fromCharCode(127), String.fromCharCode(0x2028), String.fromCharCode(0x2029),
    ];
    const word = (): string => {
      const n = 1 + Math.floor(rand() * 12);
      let s = "";
      for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
      return s;
    };
    const controlRe = new RegExp(
      `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}` +
        `${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`,
    );
    const titles = ["## imports", "## imported by", "## endpoints", "## calls out", "## tables", "## topics"];
    for (let i = 0; i < 200; i++) {
      const rich = input({
        path: word(),
        repo: word(),
        imports: [{ target: word(), line: rand() < 0.3 ? null : 1 + Math.floor(rand() * 50) }],
        importedBy: [{ path: word(), line: rand() < 0.3 ? null : 1 }],
        endpoints: [{
          method: word(),
          route: word(),
          line: 1,
          handler: word(),
          tables: [{ table: word(), access: word() }],
          callers: [{ path: word(), line: 1, caller: word(), via: word() }],
        }],
        callsOut: [{
          method: word(),
          path: word(),
          line: 1,
          via: word(),
          caller: word(),
          ...(rand() < 0.5 ? { matchedPath: word() } : {}),
          ...(rand() < 0.5 ? { targetService: word() } : {}),
        }],
        tables: [{ table: word(), access: word(), via: word(), through: word(), implicit: rand() < 0.5 }],
        topics: [{ topic: word(), direction: word(), handler: word(), peers: [word(), word()] }],
      });
      const got = formatTrace(rich);
      expect(formatTrace(rich)).toBe(got);
      expect(got.endsWith("\n")).toBe(true);
      for (const line of got.split("\n")) expect(controlRe.test(line)).toBe(false);
      expect(got.startsWith("# trace: ")).toBe(true);
      let at = 0;
      for (const title of titles) {
        const idx = got.indexOf(title, at);
        expect(idx).toBeGreaterThanOrEqual(0);
        at = idx;
      }
      // No raw link shape can form: every value-side bracket/paren
      // is backslash-escaped, and no fixed marker emits "](".
      expect(got).not.toContain("](");
    }
  });
});
