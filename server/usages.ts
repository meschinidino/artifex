/**
 * Belt usage evidence (BCR4c): WHAT an import belt carries — the
 * symbols the source file actually uses from the target. Pure and
 * display-only: every entry point returns undefined on any shape
 * it does not recognize, and the caller keeps the bare line
 * citation. Never fed back into resolution.
 */

/** Cap for listed symbols; the rest fold into "+N more". */
export const USES_CAP = 8;

export function formatUses(symbols: readonly string[]): string | undefined {
  if (symbols.length === 0) return undefined;
  const head = symbols.slice(0, USES_CAP).join(", ");
  const rest = symbols.length - USES_CAP;
  return rest > 0 ? `uses ${head}, +${rest} more` : `uses ${head}`;
}

/** Same, with a shared qualifier factored out once (`uses domain: A, B`). */
export function formatPrefixedUses(prefix: string, symbols: readonly string[]): string | undefined {
  if (symbols.length === 0) return undefined;
  const head = symbols.slice(0, USES_CAP).join(", ");
  const rest = symbols.length - USES_CAP;
  return rest > 0 ? `uses ${prefix}: ${head}, +${rest} more` : `uses ${prefix}: ${head}`;
}

/**
 * Strip Go comments, interpreted strings, raw strings, and rune
 * literals to spaces (newlines preserved): the uses scan must
 * never match inside them.
 */
export function stripGoNonCode(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const pushSpaces = (count: number) => {
    out += " ".repeat(count);
  };
  while (i < n) {
    const c = source[i]!;
    const d = source[i + 1] ?? "";
    if (c === "/" && d === "/") {
      let j = i;
      while (j < n && source[j] !== "\n") j++;
      pushSpaces(j - i);
      i = j;
    } else if (c === "/" && d === "*") {
      let j = i + 2;
      while (j < n && !(source[j] === "*" && source[j + 1] === "/")) {
        out += source[j] === "\n" ? "\n" : " ";
        j++;
      }
      pushSpaces(Math.min(j + 2, n) - j);
      i = Math.min(j + 2, n);
    } else if (c === "`") {
      let j = i + 1;
      while (j < n && source[j] !== "`") {
        out += source[j] === "\n" ? "\n" : " ";
        j++;
      }
      pushSpaces(1); // opening backquote
      if (j < n) pushSpaces(1); // closing backquote
      i = j + 1;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"' && source[j] !== "\n") {
        if (source[j] === "\\") j++;
        j++;
      }
      pushSpaces(Math.min(j + 1, n) - i);
      i = Math.min(j + 1, n);
    } else if (c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== "'" && source[j] !== "\n") {
        if (source[j] === "\\") j++;
        j++;
      }
      pushSpaces(Math.min(j + 1, n) - i);
      i = Math.min(j + 1, n);
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/**
 * Distinct `alias.Symbol` uses in Go source (stripped first):
 * cross-package belts only reach exported (uppercase) symbols.
 * Sorted; the caller caps for display.
 */
export function goAliasUses(source: string, alias: string): string[] {
  if (!/^[A-Za-z_]\w*$/.test(alias)) return [];
  const code = stripGoNonCode(source);
  const re = new RegExp(`\\b${alias}\\.([A-Z][A-Za-z0-9_]*)\\b`, "g");
  const found = new Set<string>();
  for (const m of code.matchAll(re)) found.add(m[1]!);
  return [...found].sort();
}

/**
 * Parse one Go import line: the explicit alias (`_` and `.`
 * included), "" when the line is a bare quoted path, undefined
 * when the line is not a recognizable import spec.
 */
export function goImportAlias(lineText: string): string | undefined {
  const noComment = lineText.split("//")[0]!.trim().replace(/^import\s+/, "");
  const bare = /^"[^"]+"$/.test(noComment) || /^`[^`]+`$/.test(noComment);
  if (bare) return "";
  const m = /^([A-Za-z_.][\w.]*)\s+(?:"[^"]+"|`[^`]+`)$/.exec(noComment);
  return m ? m[1]! : undefined;
}

/** First `package <name>` clause in the head of a Go file. */
export function goPackageClause(source: string): string | undefined {
  const head = source.split("\n").slice(0, 50).join("\n");
  const m = /^\s*package\s+([A-Za-z_]\w*)/m.exec(head);
  return m ? m[1]! : undefined;
}

/**
 * Exported top-level declarations in Go source: types, funcs,
 * methods, vars, consts (grouped blocks included, struct fields
 * and closures excluded). Powers per-file attribution (BCR4d):
 * a file edge only claims the used symbols it declares.
 */
export function goDeclaredSymbols(source: string): string[] {
  const found = new Set<string>();
  // Leading `Name (, Name)*`: the declared identifiers only, never
  // a type reference further down the line.
  const takeLeading = (line: string) => {
    const m = /^\s*([A-Z]\w*(?:\s*,\s*[A-Z]\w*)*)/.exec(line);
    if (m) for (const part of m[1]!.split(",")) found.add(part.trim());
  };
  const bump = (line: string): number => {
    let depth = 0;
    for (const c of line) {
      if (c === "(" || c === "{" || c === "[") depth++;
      else if (c === ")" || c === "}" || c === "]") depth--;
    }
    return depth;
  };
  let inBlock = false;
  let depth = 0;
  for (const line of stripGoNonCode(source).split("\n")) {
    if (inBlock) {
      if (/^\s*\)/.test(line)) {
        inBlock = false;
        depth = 0;
        continue;
      }
      if (depth === 1) takeLeading(line);
      depth += bump(line);
      continue;
    }
    const single = /^type\s+([A-Z]\w*)\b/.exec(line);
    if (single) {
      found.add(single[1]!);
      continue;
    }
    if (/^(type|var|const)\s*\($/.test(line.trim())) {
      inBlock = true;
      depth = 1;
      continue;
    }
    const oneLine = /^(?:var|const)\s+([A-Z]\w*(?:\s*,\s*[A-Z]\w*)*)\b/.exec(line);
    if (oneLine) {
      for (const part of oneLine[1]!.split(",")) found.add(part.trim());
      continue;
    }
    const fn = /^func\s+(?:\([^)]*\)\s*)?([A-Z]\w*)\s*[[(]/.exec(line);
    if (fn) found.add(fn[1]!);
  }
  return [...found].sort();
}

export type TsStatementNames = {
  /** Local names bound (default, named; namespace as `ns.*`). */
  names: string[];
  /** 1-based last line of the statement. */
  endLine: number;
  /** True when a `* as ns` binding is present. */
  namespace: boolean;
};

/**
 * Names bound by the TS/JS import (or export-from) statement
 * starting at startLine (1-based). Undefined unless the
 * statement completes with a `from "…"` terminator inside 64
 * lines: side-effect imports, requires, star re-exports, and
 * anything with a block comment fall back to the bare line.
 * The window is wide because one-name-per-line imports in big
 * files (app.ts runs past 20) are real, not pathological.
 */
export function tsStatementNames(lines: readonly string[], startLine: number): TsStatementNames | undefined {
  const first = lines[startLine - 1];
  if (first === undefined) return undefined;
  const head = first.trim();
  const isImport = head.startsWith("import ");
  const isExportFrom = head.startsWith("export ");
  if (!isImport && !isExportFrom) return undefined;
  const stmt: string[] = [];
  for (let i = startLine - 1; i < Math.min(lines.length, startLine - 1 + 64); i++) {
    const raw = lines[i]!;
    if (raw.includes("/*")) return undefined;
    stmt.push(raw.split("//")[0]!);
    if (/\bfrom\s+["']/.test(stmt.join("\n"))) break;
  }
  const text = stmt.join("\n");
  if (!/\bfrom\s+["'][^"']*["']/.test(text)) return undefined;
  const endLine = startLine - 1 + stmt.length;
  const clause = text.replace(/\bfrom\s+["'][^"']*["'][\s;]*$/, "");
  const body = clause
    .replace(/^\s*(import|export)\s+type\s+/, "$1 ")
    .replace(/^\s*import\s+/, "")
    .replace(/^\s*export\s+/, "");
  if (/^\s*\*\s*$/.test(body)) return undefined; // export * from: everything, nothing to name
  const names: string[] = [];
  const defLead = /^\s*([A-Za-z_$][\w$]*)\s*(,|$)/.exec(body);
  if (defLead) names.push(defLead[1]!);
  const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(body);
  if (ns) names.push(`${ns[1]}.*`);
  const brace = /\{([\s\S]*)\}/.exec(body);
  if (brace) {
    for (const item of brace[1]!.split(",")) {
      const local = item
        .trim()
        .replace(/^type\s+/, "")
        .split(/\s+as\s+/)
        .pop()!
        .trim();
      if (/^[A-Za-z_$][\w$]*$/.test(local)) names.push(local);
    }
  }
  if (names.length === 0) return undefined;
  return { names, endLine, namespace: ns !== null };
}
