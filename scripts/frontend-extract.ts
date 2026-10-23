// Frontend call extractor (probe): Angular HttpClient call sites -> {method, path, file, line}.
// Base resolution: literal fields, inject(API_URL) (placeholder shape proven by
// guarani dev env: BACKEND_URL = <origin>/api/tesoreria), inject(EXTERNO_API_BASE).
// Unresolvable bases land in `unresolved` — visible, never dropped.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = "/Users/dinomeschini/Documents/tes-um/UM.tesoreria.frontend-client";
const GW = "{GW}/api/tesoreria"; // BACKEND_URL_PLACEHOLDER path shape (guarani env sample)

type Call = { method: string; path: string; file: string; line: number; raw: string };
const calls: Call[] = [];
const unresolved: Call[] = [];
let unparsed = 0;

function walk(dir: string, out: string[]) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { walk(p, out); continue; }
    if (p.endsWith(".ts") && !p.endsWith(".spec.ts") && !p.endsWith("test-setup.ts")) out.push(p);
  }
}

/** Skip balanced <...> generics / (...) parens from index i (text[i] is the opener). */
function skipBalanced(text: string, i: number, open: string, close: string): number {
  let depth = 0;
  let q: string | null = null;
  let tpl = 0; // ${} depth inside template
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return i + 1; }
  }
  return -1;
}

/** Capture the first argument of a call: text[i] is '('. Returns [arg, endIndex]. */
function firstArg(text: string, i: number): [string, number] | null {
  let depth = 0, q: string | null = null;
  let start = -1;
  for (; i < text.length; i++) {
    const c = text[i]!;
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "(" || c === "[" || c === "{") { if (depth === 0 && c === "(") start = i + 1; depth++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0 && c === ")") return [text.slice(start, i), i + 1];
      continue;
    }
    if (c === "," && depth === 1) return [text.slice(start, i), i + 1];
  }
  return null;
}

/** Scan a field/const initializer: from index i (after `=`) to the depth-0 `;`. */
function stmtEnd(src: string, i: number): number {
  let depth = 0, q: string | null = null;
  for (; i < src.length; i++) {
    const c = src[i]!;
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return i;
  }
  return -1;
}

/** Apply JS .replace(/re/, '') ops found in `ops` to value v. The real semantics, not guesses. */
function applyReplaces(v: string, ops: string): string {
  for (const m of ops.matchAll(/\.replace\(\s*\/((?:\\.|[^/\\])+)\/[a-z]*\s*,/g)) {
    try { v = v.replace(new RegExp(m[1]!), ""); } catch { /* keep */ }
  }
  return v;
}

/**
 * Substitute ${this.x<ops>} units and bare this.x using bases. A `this.x`
 * that was never stringish as a field/const is component state (a path
 * param) and becomes {} — only stringish-but-unresolved names fail.
 */
function subThis(expr: string, bases: Map<string, string>, stringish: Set<string>): string | null {
  let failed = false;
  const one = (name: string, ops: string, orig: string): string => {
    const b = bases.get(name);
    if (b !== undefined) return applyReplaces(b, ops);
    // Declared with a non-string init (null, number[], inject(FormBuilder))
    // or never stringish: a value, i.e. a path param.
    if (!stringish.has(name)) return "{}";
    failed = true;
    return orig;
  };
  let out = expr.replace(/\$\{this\.(\w+)((?:[^}"']|"[^"]*"|'[^']*')*)\}/g, (full: string, name: string, ops: string) => one(name, ops, full));
  out = out.replace(/this\.(\w+)((?:\.replace\((?:[^()]|\([^()]*\))*\))?)/g, (full: string, name: string, ops: string) => one(name, ops || "", full));
  return failed ? null : out;
}

/** Split on top-level delimiter (depth-aware, string-skipping). */
function splitTop(stmt: string, delim: string): string[] {
  const parts: string[] = [];
  let depth = 0, q: string | null = null, start = 0;
  for (let i = 0; i < stmt.length; i++) {
    const c = stmt[i]!;
    if (q) {
      if (c === "\\") { i++; continue; }
      if (c === q) q = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") { q = c; continue; }
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === delim && depth === 0) { parts.push(stmt.slice(start, i)); start = i + 1; }
  }
  parts.push(stmt.slice(start));
  return parts;
}

function resolveBases(src: string): Map<string, string> {
  const bases = new Map<string, string>();
  // Collect field + const statements (multiline-safe via stmtEnd).
  const stmts: { name: string; local: boolean; stmt: string }[] = [];
  // `=` only: never ==/===/=>/!=/<=/>=, never this.x assignments (bases are field/const initializers).
  const decl = /(?:(?:private|protected|public)\s+)?(?:readonly\s+)?(?:(const|let|var)\s+)?(?<![\w$.])(\w+)\s*(?::\s*[\w<>\[\]| ]+)?=(?![=>])\s*/g;
  let m: RegExpExecArray | null;
  while ((m = decl.exec(src))) {
    const end = stmtEnd(src, m.index + m[0].length);
    if (end < 0) continue;
    stmts.push({ name: m[2]!, local: !!m[1], stmt: src.slice(m.index + m[0].length, end).trim() });
  }
  const key = (s: { name: string; local: boolean }) => (s.local ? "local:" + s.name : s.name);
  const stringish = new Set(stmts.filter((s) => !/^(['"])\1$/.test(s.stmt) && /[`'"]|inject\(|environment\.|this\./.test(s.stmt)).map((s) => s.name));
  const alts = new Map<string, string[]>();
  // Pure literals first (exact, no dependencies). Empty strings are
  // placeholders reassigned before use, never URL bases.
  for (const s of stmts) {
    const lit = s.stmt.match(/^(['"])((?:\\\1|(?!\1)[\s\S])*)\1$/);
    if (lit && lit[2] !== "" && !bases.has(key(s))) bases.set(key(s), lit[2]!);
  }
  // Fixed point over the rest.
  for (let round = 0; round < 6; round++) {
    let progress = false;
    for (const s of stmts) {
      if (bases.has(key(s))) continue;
      const v = resolveStmt(s.stmt, bases, stringish, alts, key(s));
      if (v !== null) { bases.set(key(s), v); progress = true; }
    }
    if (!progress) break;
  }
  return { bases, stringish, alts };
}

/** Resolve one initializer statement to a string, or null when it depends on the unknown. */
function resolveStmt(stmt: string, bases: Map<string, string>, stringish: Set<string>, alts: Map<string, string[]>, altKey: string): string | null {
  // inject(API_URL...) / inject(EXTERNO_API_BASE) / environment.apiUrl: env value + fallback + replaces + concats.
  if (stmt.includes("inject(API_URL") || stmt.includes("inject(EXTERNO_API_BASE") || stmt.includes("environment.apiUrl")) {
    const fb = stmt.match(/\?\?\s*(['"])((?:\\\1|(?!\1)[\s\S])*)\1/);
    let v = fb ? fb[2]! : stmt.includes("EXTERNO") && !stmt.includes("environment.apiUrl") ? GW : `${GW}/core/auth`;
    v = applyReplaces(v, stmt);
    for (const c of stmt.matchAll(/\+\s*(['"])((?:\\\1|(?!\1)[\s\S])*)\1/g)) v += c[2];
    return subThis(v, bases, stringish);
  }
  // Array join: [base, 'lit', expr, ...].join('/') — elements to segments.
  if (stmt.startsWith("[")) {
    const arrEnd = skipBalanced(stmt, 0, "[", "]");
    if (arrEnd < 0 || !stmt.slice(arrEnd).startsWith(".join(")) return null;
    const segs: string[] = [];
    for (const el of splitTop(stmt.slice(1, arrEnd - 1), ",")) {
      const t = el.trim();
      if (!t) continue; // trailing comma
      const lit = t.match(/^(['"])((?:\\\1|(?!\1)[\s\S])*)\1$/);
      if (lit) { segs.push(lit[2]!); continue; }
      // Calls (encodeURIComponent(...)) and unresolvable exprs are params.
      if (t.includes("(")) { segs.push("{}"); continue; }
      const sub = subThis(t, bases, stringish);
      if (sub === null) return null;
      segs.push(sub.includes("this.") || sub.includes("${") || !sub.startsWith("{GW}") && !sub.startsWith("/") && !/^\{\}$/.test(sub) ? "{}" : sub.replace(/^\//, ""));
    }
    return "/" + segs.join("/").replace(/\/+/g, "/");
  }
  // Ternary: cond ? A : B — both branches are real paths; primary + alternate.
  {
    const q = splitTop(stmt, "?");
    if (q.length === 2) {
      const c = splitTop(q[1]!, ":");
      if (c.length === 2) {
        const a = resolveStmt(c[0]!.trim(), bases, stringish, alts, altKey);
        const b = resolveStmt(c[1]!.trim(), bases, stringish, alts, altKey);
        if (a !== null && b !== null && a !== b) {
          alts.set(altKey, [a, b]);
          return a;
        }
        return a ?? b;
      }
    }
  }
  // Template literal, possibly with + 'suffix' concats.
  if (stmt.startsWith("`")) {
    const end = stmt.indexOf("`", 1);
    if (end < 0) return null;
    let v = subThis(stmt.slice(1, end), bases, stringish);
    if (v === null) return null;
    for (const c of stmt.slice(end).matchAll(/\+\s*(['"])((?:\\\1|(?!\1)[\s\S])*)\1/g)) v += c[2];
    // ${param} holes stay as {} (path params, not bases).
    v = v.replace(/\$\{[^}]*\}/g, "{}");
    return v.includes("this.") ? null : v;
  }
  // this.x[.replace(...)] + 'suffix' chains, or bare this.x / bare local.
  if (stmt.includes("this.") || stmt.includes("+")) {
    let sawThis = false;
    let v = "";
    for (const p of splitTop(stmt, "+")) {
      let t = p.trim();
      // Unwrap ONE enclosing pair only (a blind trailing-paren strip eats .replace(...)'s paren).
      if (t.startsWith("(") && skipBalanced(t, 0, "(", ")") === t.length) t = t.slice(1, -1).trim();
      const lit = t.match(/^(['"])((?:\\\1|(?!\1)[\s\S])*)\1$/);
      if (lit) { v += lit[2]; continue; }
      // (inner).replace(...) — resolve the inner, then apply the outer call.
      if (t.startsWith("(")) {
        const end = skipBalanced(t, 0, "(", ")");
        if (end > 0 && t.slice(end).trimStart().startsWith(".replace(")) {
          const inner = t.slice(1, end - 1);
          const rest = t.slice(end);
          let iv: string | null = null;
          if (inner.includes("??")) {
            const fb = inner.match(/\?\?\s*(['"])((?:\\\1|(?!\1)[\s\S])*)\1/);
            iv = fb ? fb[2]! : subThis(inner.split("??")[0]!.trim(), bases, stringish);
          } else {
            iv = subThis(inner.trim(), bases, stringish);
          }
          if (iv !== null && !iv.includes("this.")) { v += applyReplaces(iv, rest); sawThis = true; continue; }
        }
      }
      // A call that isn't this.x.replace(...) (toIsoDate, encodeURIComponent)
      // computes a value, never a base: it is a path param.
      if (t.includes("(") && !/^this\.\w+\.replace\(/.test(t)) { v += "{}"; sawThis = sawThis || t.includes("this."); continue; }
      // Bare identifier: base value when it names one, else a path param.
      if (/^[a-zA-Z_]\w*$/.test(t)) {
        const baseVal = bases.get(t) ?? bases.get("local:" + t);
        if (baseVal === undefined) { v += "{}"; continue; }
        v += baseVal;
        continue;
      }
      const sub = subThis(t, bases, stringish);
      if (sub === null) return null;
      if (sub.includes("this.")) return null;
      // A non-literal operand that resolves to no path (payload.id, foo.bar)
      // is a computed value, never a base: path param.
      v += sub.startsWith("/") || sub.startsWith("{GW}") || sub === "{}" ? sub : "{}";
      sawThis = sawThis || t.includes("this.");
    }
    if (!sawThis && !stmt.includes("+")) return null;
    return v;
  }
  // Bare single identifier: alias to a local/field.
  {
    const bare = stmt.match(/^([a-zA-Z_]\w*)$/)?.[1];
    if (bare) return bases.get(bare) ?? bases.get("local:" + bare) ?? null;
  }
  return null;
}

function extractFile(path: string) {
  const src = readFileSync(path, "utf8");
  const rel = path.slice(ROOT.length + 1);
  const { bases, stringish, alts } = resolveBases(src);
  const finish = (expr: string, rec: Call): string | null => {
    if (expr.includes("this.")) return null;
    let p = expr.replace(/^\s*[`'"]/, "").replace(/[`'"]\s*$/, "");
    p = p.replace(/\$\{[^}]*\}/g, "{}");
    p = p.replace(/\{GW\}[^/]*/, "");
    p = p.replace(/\/+/g, "/");
    return p.startsWith("/") ? p : null;
  };
  const re = /\.http\s*\.\s*(get|post|put|delete|patch)\s*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    while (src[i] === " " || src[i] === "\n" || src[i] === "\t") i++;
    if (src[i] === "<") { // generics, possibly multiline
      const end = skipBalanced(src, i, "<", ">");
      if (end < 0) { unparsed++; continue; }
      i = end;
      while (src[i] === " " || src[i] === "\n" || src[i] === "\t") i++;
    }
    if (src[i] !== "(") { unparsed++; continue; }
    const got = firstArg(src, i);
    if (!got) { unparsed++; continue; }
    const line = src.slice(0, m.index).split("\n").length;
    let expr = got[0].trim();
    const sub = subThis(expr, bases, stringish);
    if (sub !== null) expr = sub;
    // Bare identifier with alternates (ternary local): emit every branch.
    const bare = expr.match(/^([a-zA-Z_]\w*)$/)?.[1];
    let exprs = [expr];
    if (bare) {
      // Nearest preceding `const|let name =` wins (one file, many method-scope urls).
      let scoped: string[] | null = null;
      const re2 = new RegExp(`(?:const|let|var)\\s+${bare}\\s*(?::\\s*[\\w<>\\[\\]| ]+)?=\\s*`, "g");
      let dm: RegExpExecArray | null, last: RegExpExecArray | null = null;
      while ((dm = re2.exec(src)) && dm.index < m.index) last = dm;
      if (last) {
        const end = stmtEnd(src, last.index + last[0].length);
        if (end > 0) {
          const localAlts = new Map<string, string[]>();
          const lv = resolveStmt(src.slice(last.index + last[0].length, end).trim(), bases, stringish, localAlts, "scoped");
          if (lv !== null) scoped = localAlts.has("scoped") ? localAlts.get("scoped")! : [lv];
        }
      }
      if (scoped) exprs = scoped;
      else {
        const key = bases.has("local:" + bare) ? "local:" + bare : bare;
        if (alts.has(key)) exprs = alts.get(key)!;
        else {
          const argAlts = new Map<string, string[]>();
          const via = resolveStmt(expr, bases, stringish, argAlts, "arg");
          if (via !== null) exprs = argAlts.has("arg") ? argAlts.get("arg")! : [via];
        }
      }
    } else {
      // Inline concat/template/ternary at the call site.
      const argAlts = new Map<string, string[]>();
      const via = resolveStmt(expr, bases, stringish, argAlts, "arg");
      if (via !== null) exprs = argAlts.has("arg") ? argAlts.get("arg")! : [via];
    }
    const raw = got[0].trim().slice(0, 160);
    let ok = false;
    for (const e of exprs) {
      const rec: Call = { method: m[1]!.toUpperCase(), path: "", file: rel, line, raw };
      const p = finish(e, rec);
      if (p === null) { rec.path = e.slice(0, 200); unresolved.push(rec); continue; }
      rec.path = p;
      calls.push(rec);
      ok = true;
    }
    void ok;
  }
}

export { resolveBases, resolveStmt, subThis, stmtEnd, calls, unresolved };
export function reset() { calls.length = 0; unresolved.length = 0; unparsed = 0; }
export { extractFile };

if (import.meta.main) {
  const files: string[] = [];
  walk(join(ROOT, "apps"), files);
  walk(join(ROOT, "libs"), files);
  for (const f of files) extractFile(f);
  console.log(JSON.stringify({ calls, unresolved, unparsed, files: files.length }, null, 1));
}
