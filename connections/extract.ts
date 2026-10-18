/**
 * Literal-only connection extraction per file.
 *
 * JVM (Java/Kotlin) is the deep pass: Spring stereotype/mapping
 * annotations, Feign clients, JPA entities/repositories, native and
 * JPQL @Query SQL, Kafka listeners/templates, injected fields, and
 * per-method receiver calls (the raw material for endpoint→tables
 * chains). TS/Python/Go get literal HTTP endpoint/call passes.
 *
 * Rules, same as the import extractor: only literal strings are
 * ever emitted. Templates, placeholders (${...}), and computed
 * values are recorded in `notes` as unresolved — visible, not
 * silently dropped and never guessed.
 */
import type { EndpointCall, FileConnections, MethodInfo, TableUse, TopicUse } from "./types.ts";
import { joinPaths } from "./types.ts";

type Lang = "java" | "kotlin" | "ts" | "py" | "go";

export function connectionsLang(path: string): Lang | undefined {
  if (/\.java$/.test(path)) return "java";
  if (/\.(kt|kts)$/.test(path)) return "kotlin";
  if (/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(path)) return "ts";
  if (/\.py$/.test(path)) return "py";
  if (/\.go$/.test(path)) return "go";
  return undefined;
}

export function extractConnections(path: string, content: string): FileConnections | undefined {
  const lang = connectionsLang(path);
  if (!lang) return undefined;
  if (lang === "java" || lang === "kotlin") return extractJvm(path, content, lang);
  if (lang === "ts") return extractTs(path, content);
  if (lang === "py") return extractPy(path, content);
  return extractGo(path, content);
}

function empty(path: string): FileConnections {
  return {
    path, kinds: [], supertypes: [], endpoints: [], calls: [], tables: [], repoEntities: [],
    topics: [], injections: [], methods: [], notes: [],
  };
}

/** Supertype simple names from a class/interface header (generics stripped). */
function parseSupertypes(header: string, lang: "java" | "kotlin", className: string): string[] {
  const out = new Set<string>();
  const noGenerics = header.replace(/<[^>]*>/g, "");
  if (lang === "java") {
    for (const kw of ["implements", "extends"]) {
      const m = new RegExp(`\\b${kw}\\s+([\\w.,\\s]+?)(?:\\{|$)`).exec(noGenerics);
      if (m) for (const part of m[1]!.split(",")) {
        const name = part.trim().split(".").pop()?.trim();
        if (name && /^[A-Z]/.test(name) && name !== className) out.add(name);
      }
    }
  } else {
    // Kotlin: the supertype colon sits after the primary
    // constructor's closing paren (or the name): `: A(), B` up to
    // '{'. A colon inside constructor parens declares a property
    // type (`private val repo: Repo`), never a supertype.
    let headerTail = noGenerics;
    const openParen = noGenerics.indexOf("(");
    if (openParen !== -1) {
      let pd = 0;
      let closeAt = -1;
      for (let i = openParen; i < noGenerics.length; i++) {
        if (noGenerics[i] === "(") pd++;
        else if (noGenerics[i] === ")") { pd--; if (pd === 0) { closeAt = i; break; } }
      }
      headerTail = closeAt === -1 ? noGenerics.slice(noGenerics.indexOf(className) + className.length) : noGenerics.slice(closeAt);
    }
    const colon = headerTail.indexOf(":");
    if (colon !== -1) {
      const tail = headerTail.slice(colon + 1).split("{")[0]!;
      for (const part of tail.split(",")) {
        const name = /([A-Z]\w*)/.exec(part.trim())?.[1];
        if (name && name !== className) out.add(name);
      }
    }
  }
  return [...out];
}

/** All string literals in a fragment: "..." (escape-aware) and """...""" text blocks. */
function stringLiterals(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      if (end === -1) break;
      out.push(text.slice(i + 3, end));
      i = end + 3;
      continue;
    }
    const c = text[i]!;
    if (c === '"') {
      let j = i + 1;
      let value = "";
      let ok = false;
      while (j < text.length) {
        const d = text[j]!;
        if (d === "\\") { value += text[j + 1] ?? ""; j += 2; continue; }
        if (d === '"') { ok = true; break; }
        if (d === "\n") break;
        value += d;
        j++;
      }
      if (ok) { out.push(value); i = j + 1; continue; }
      i = j;
      continue;
    }
    i++;
  }
  return out;
}

/** True when parens balance outside string literals/text blocks. */
function parensBalanced(text: string): boolean {
  let depth = 0;
  let i = 0;
  while (i < text.length) {
    if (text.startsWith('"""', i)) {
      const end = text.indexOf('"""', i + 3);
      if (end === -1) return false;
      i = end + 3;
      continue;
    }
    const c = text[i]!;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"' && text[i] !== "\n") { if (text[i] === "\\") i++; i++; }
      i++;
      continue;
    }
    if (c === "'") {
      i++;
      while (i < text.length && text[i] !== "'" && text[i] !== "\n") { if (text[i] === "\\") i++; i++; }
      i++;
      continue;
    }
    if (c === "(") depth++;
    else if (c === ")") depth--;
    i++;
  }
  return depth <= 0;
}

/** Brace delta of a line, ignoring string/char literals and // comments. */
function braceDelta(line: string): number {
  let delta = 0;
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "/" && line[i + 1] === "/") break;
    if (line.startsWith('"""', i)) {
      const end = line.indexOf('"""', i + 3);
      if (end === -1) return delta; // text block runs to later lines
      i = end + 3;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      while (i < line.length && line[i] !== quote) { if (line[i] === "\\") i++; i++; }
      i++;
      continue;
    }
    if (c === "{") delta++;
    else if (c === "}") delta--;
    i++;
  }
  return delta;
}

type Annotation = { name: string; args: string; line: number };

/** Args fragment inside an annotation's outer parens ("" when none). */
function annotationArgs(raw: string): string {
  const open = raw.indexOf("(");
  if (open === -1) return "";
  const close = raw.lastIndexOf(")");
  return close > open ? raw.slice(open + 1, close) : raw.slice(open + 1);
}

/** Named string argument: name="..." / name={"a","b"} / name={"a"}; positionals via namedArgumentStrings(args, undefined). */
/** Balanced {...} slice starting at idx ({param} inside strings must not close it). */
function balancedBraces(text: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === "\\") i++; i++; }
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
    i++;
  }
  return text.slice(start);
}

function namedArgumentStrings(args: string, name: string | undefined): string[] {
  if (name !== undefined) {
    const m = new RegExp(`(?:^|[^\\w.])${name}\\s*=\\s*`).exec(args);
    if (!m) return [];
    const at = m.index + m[0].length;
    if (args[at] === "{") return stringLiterals(balancedBraces(args, at));
    if (args[at] === "[") return stringLiterals(args.slice(at, args.indexOf("]", at) + 1)); // Kotlin array literal
    if (args[at] === '"') return stringLiterals(args.slice(at, args.indexOf('"', at + 1) + 1));
    return [];
  }
  // Positional: only when args do not start with an identifier `x =`.
  const head = args.trimStart();
  if (/^\w+\s*=/.test(head)) return [];
  if (head.startsWith("{")) return stringLiterals(balancedBraces(head, 0));
  if (head.startsWith("[")) return stringLiterals(head.slice(0, head.indexOf("]") + 1));
  if (head.startsWith('"')) {
    const end = head.indexOf('"', 1) + 1;
    return end > 0 ? stringLiterals(head.slice(0, end)) : [];
  }
  return [];
}

/** Mapping paths from annotation args: positional, value=, or path=. */
function mappingPaths(args: string): string[] {
  const positional = namedArgumentStrings(args, undefined);
  if (positional.length > 0) return positional;
  const byValue = namedArgumentStrings(args, "value");
  if (byValue.length > 0) return byValue;
  return namedArgumentStrings(args, "path");
}

function mappingMethod(args: string): string | undefined {
  const m = /method\s*=\s*(?:\{\s*)?RequestMethod\.(\w+)/.exec(args);
  return m ? m[1]!.toUpperCase() : undefined;
}

export function snakeCase(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

const SQL_TABLE_RE = /(?:\bFROM|\bJOIN|\bUPDATE|\bINTO)\s+`?([\w.]+)`?/gi;
const SQL_STOPWORDS = new Set(["select", "skip", "locked", "of", "where", "set", "values", "duplicate", "key", "nowait"]);

function cleanSql(sql: string): string {
  return sql
    .replace(/EXTRACT\s*\([^)]*\)/gi, " ")
    .replace(/\bFOR\s+UPDATE\b(\s+OF\s+[\w.,\s]+?)?(?=\s+(?:SKIP|NOWAIT|;|$))/gi, " ")
    .replace(/\bSKIP\s+LOCKED\b|\bNOWAIT\b/gi, " ");
}

/** Physical tables of one SQL statement with per-table access. */
function sqlTables(sql: string): { table: string; access: TableUse["access"] }[] {
  const cleaned = cleanSql(sql);
  const verb = sqlAccess(cleaned);
  const selectAt = cleaned.search(/\bSELECT\b/i);
  const byTable = new Map<string, TableUse["access"]>();
  for (const m of cleaned.matchAll(SQL_TABLE_RE)) {
    const t = m[1]!.replace(/`/g, "").toLowerCase();
    if (!t || SQL_STOPWORDS.has(t)) continue;
    const kw = /^(\w+)/.exec(m[0])![1]!.toUpperCase();
    let access: TableUse["access"] = verb;
    // INSERT INTO t ... SELECT ... FROM u: INTO is the write, the rest reads.
    if (verb === "write" && cleaned.trimStart().toUpperCase().startsWith("INSERT")) {
      access = kw === "INTO" ? "write" : "read";
    } else if (verb === "write" && kw === "FROM" && selectAt !== -1 && (m.index ?? 0) > selectAt) {
      access = "read";
    }
    const prev = byTable.get(t);
    byTable.set(t, prev === undefined ? access : prev === access ? prev : "readwrite");
  }
  return [...byTable].map(([table, access]) => ({ table, access }));
}

function sqlAccess(sql: string): TableUse["access"] {
  const head = sql.trimStart().slice(0, 8).toUpperCase();
  if (head.startsWith("SELECT")) return "read";
  if (head.startsWith("UPDATE") || head.startsWith("INSERT") || head.startsWith("DELETE")) return "write";
  return "unknown";
}

const HTTP_METHOD_ANNOTATIONS: Record<string, string> = {
  GetMapping: "GET", PostMapping: "POST", PutMapping: "PUT",
  DeleteMapping: "DELETE", PatchMapping: "PATCH",
};

const STEREOTYPE_KINDS: Record<string, string> = {
  RestController: "controller", Controller: "controller", Service: "service",
  Repository: "repository", Component: "component", Configuration: "configuration",
  Entity: "entity", FeignClient: "feign", RestControllerAdvice: "advice",
  ControllerAdvice: "advice", KafkaListener: "listener",
};

/** Parse @FeignClient args: name/value is the service, path= the base; a path glued into the name splits off. */
function parseFeign(args: string): { targetService: string; basePath: string; absoluteUrl?: boolean } | undefined {
  let name = namedArgumentStrings(args, "name")[0] ?? namedArgumentStrings(args, "value")[0] ?? namedArgumentStrings(args, undefined)[0];
  let basePath = namedArgumentStrings(args, "path")[0] ?? "";
  const url = namedArgumentStrings(args, "url")[0];
  if (url !== undefined) {
    // An explicit url wins over the service name in Spring Cloud
    // OpenFeign (no load balancing): the host is that URL, so the
    // calls are absolute-URL calls even when name= is also given.
    try {
      const u = new URL(url);
      name = u.hostname;
      if (basePath === "") basePath = u.pathname === "/" ? "" : u.pathname;
    } catch {
      name = url;
    }
    return { targetService: name, basePath, absoluteUrl: true };
  }
  if (name === undefined) return undefined;
  if (name.includes("${")) return undefined; // placeholder service name: unresolved, handled by caller note path
  const slash = name.indexOf("/");
  if (slash > 0) {
    if (basePath === "") basePath = name.slice(slash);
    name = name.slice(0, slash);
  }
  return { targetService: name, basePath };
}

type Span = { start: number; end: number; name: string };

function extractJvm(path: string, content: string, lang: "java" | "kotlin"): FileConnections {
  const out = empty(path);
  const lines = content.split("\n");

  // String constants (topic resolution within this file only).
  // Only true compile-time constants: a local `String x = "..."` or
  // `val x` redefined per method must never resolve another
  // method's topic.
  const consts = new Map<string, string>();
  for (const line of lines) {
    const m = /(?:static\s+final\s+String|const\s+val)\s+(\w+)\s*=\s*"([^"]+)"/.exec(line);
    if (m && !consts.has(m[1]!)) consts.set(m[1]!, m[2]!);
  }

  // Repository entity bindings count only in the type's own header
  // (supertype clause), never from a field or comment mentioning
  // JpaRepository<X, ...> elsewhere in the file.
  {
    let headerText = "";
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i]!;
      if (/\b(?:class|interface|record|enum|object)\s+\w+/.test(l) && !/^\s*(import|package)\b/.test(l.trim())) {
        headerText = l;
        for (let j = i + 1; !headerText.includes("{") && j < lines.length && j <= i + 8; j++) headerText += `\n${lines[j]}`;
        break;
      }
    }
    for (const m of headerText.matchAll(/(?:JpaRepository|CrudRepository|PagingAndSortingRepository|JpaSpecificationExecutor)\s*<\s*(\w+)/g)) {
      if (!out.repoEntities.includes(m[1]!)) out.repoEntities.push(m[1]!);
    }
  }

  // --- structural pass: annotations, class, fields, methods ---------
  let pending: Annotation[] = [];
  let depth = 0;
  let classDepth = -1; // brace depth just inside the class body
  let inClassHeader = false; // class declared, body brace not yet seen (multi-line headers)
  let classPaths: string[] = [];
  let classPathUnresolved = false;
  let classMethod: string | undefined;
  let currentMethod: MethodInfo | undefined;
  let methodBodyDepth = -1;
  let methodSpan: Span | undefined;
  let pendingMethod: MethodInfo | undefined;
  let pendingMethodSpan: Span | undefined;
  // Fluent chains split as `return repository` / `.findByX(...)`:
  // the bare receiver at end-of-line owns the first `.call` below.
  let chainReceiver: string | undefined;
  let inBlockComment = false;
  let inTextBlock = false;
  let headerAccum = "";
  let pendingText = "";
  const spans: Span[] = [];
  let annotationBuf: { text: string; line: number } | undefined;

  const flushPendingOnClass = (anns: Annotation[]) => {
    for (const a of anns) {
      const kind = STEREOTYPE_KINDS[a.name];
      if (kind && !out.kinds.includes(kind)) out.kinds.push(kind);
      if (a.name === "RequestMapping") {
        classPaths = mappingPaths(a.args);
        // `@RequestMapping(Paths.BASE)`: the base is a constant we
        // cannot prove. Method paths must not become root paths.
        if (classPaths.length === 0 && a.args.trim() !== "" && stringLiterals(a.args).length === 0) {
          classPathUnresolved = true;
          out.notes.push(`unresolved class-level mapping path at line ${a.line}`);
        }
        classMethod = mappingMethod(a.args);
      }
      if (a.name === "FeignClient") out.feign = parseFeign(a.args);
      if (a.name === "Entity") {
        // @Entity(name=) names the JPQL entity, not the table; the
        // table comes from @Table or falls back to the (labelled)
        // implicit naming-strategy name.
        out.entityName = out.className;
        if (!out.entityTable && out.className) {
          out.entityTable = { table: snakeCase(out.className), access: "unknown", via: "entity", derived: "implicit-name", line: a.line };
        }
      }
      if (a.name === "Table" && out.className) {
        const table = namedArgumentStrings(a.args, "name")[0] ?? namedArgumentStrings(a.args, undefined)[0];
        const schema = namedArgumentStrings(a.args, "schema")[0];
        out.entityName ??= out.className;
        if (table) {
          out.entityTable = {
            table: (schema ? `${schema}.${table}` : table).toLowerCase(),
            access: "unknown", via: "entity", derived: "explicit", line: a.line,
          };
        } else if (!out.entityTable) {
          out.entityTable = { table: snakeCase(out.className), access: "unknown", via: "entity", derived: "implicit-name", line: a.line };
        }
      }
    }
  };

  const handleMethodAnnotations = (anns: Annotation[], methodName: string, methodLine: number, method: MethodInfo) => {
    const isFeign = out.feign !== undefined;
    const controllerish = out.kinds.includes("controller") || classPaths.length > 0 || anns.some((a) => a.name === "RequestMapping");
    for (const a of anns) {
      const verb = HTTP_METHOD_ANNOTATIONS[a.name] ?? (a.name === "RequestMapping" ? mappingMethod(a.args) ?? "ANY" : undefined);
      if (verb !== undefined) {
        if (classPathUnresolved) {
          out.notes.push(`endpoint under unresolved class mapping at line ${a.line}`);
          continue;
        }
        const subPaths = mappingPaths(a.args);
        // Non-empty args with no string literal = a constant or
        // placeholder path: visibly unresolved, never the base path.
        if (subPaths.length === 0 && a.args.trim() !== "" && stringLiterals(a.args).length === 0) {
          out.notes.push(`unresolved mapping path at line ${a.line}`);
          continue;
        }
        const paths = subPaths.length > 0 ? subPaths : [""];
        if (isFeign) {
          for (const p of paths) {
            out.calls.push({
              method: verb, path: joinPaths(out.feign!.basePath, p), targetService: out.feign!.targetService,
              via: "feign", caller: methodName, line: a.line,
              absoluteUrl: out.feign!.absoluteUrl || undefined,
            });
          }
        } else if (controllerish) {
          const bases = classPaths.length > 0 ? classPaths : [""];
          for (const base of bases) for (const p of paths) {
            out.endpoints.push({ method: verb, path: joinPaths(base, p), handler: methodName, line: a.line });
          }
        }
      }
      if (a.name === "KafkaListener") {
        const topics = namedArgumentStrings(a.args, "topics");
        const literals = topics.length > 0 ? topics : namedArgumentStrings(a.args, undefined);
        let any = false;
        for (const t of literals) {
          if (t.includes("${")) { out.notes.push(`unresolved Kafka topic placeholder at line ${a.line}`); continue; }
          out.topics.push({ topic: t, direction: "consume", handler: methodName, line: a.line });
          any = true;
        }
        if (!any && literals.length === 0) out.notes.push(`unresolved @KafkaListener topics at line ${a.line}`);
        if (!out.kinds.includes("listener")) out.kinds.push("listener");
      }
      if (a.name === "Query") {
        const sql = stringLiterals(a.args).join(" ");
        const native = /nativeQuery\s*=\s*true/.test(a.args);
        if (sql) {
          if (native) {
            for (const t of sqlTables(sql)) method.tables.push({ table: t.table, access: t.access, via: "native-sql", derived: "explicit", line: a.line });
          } else {
            for (const m of sql.matchAll(/\bFROM\s+([A-Z]\w*)/gi)) method.jpqlEntities.push(m[1]!);
            // JPQL that is actually written as physical SQL is rare but real:
            // a lowercase FROM target is a table literal, not an entity name.
            for (const m of sql.matchAll(/\bFROM\s+`?([a-z][\w.]*)`?/g)) {
              method.tables.push({ table: m[1]!.toLowerCase(), access: sqlAccess(sql), via: "jpql", derived: "explicit", line: a.line });
            }
          }
        }
      }
    }
    void methodLine;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const lineNo = idx + 1;
    const trimmed = raw.trim();

    // Block comments and multi-line text blocks in code (outside
    // annotation accumulation, which tracks its own): their braces
    // and call-like text are content, never structure or facts.
    if (!annotationBuf) {
      if (inBlockComment) {
        if (raw.includes("*/")) inBlockComment = false;
        continue;
      }
      if (inTextBlock) {
        if (raw.includes('"""')) inTextBlock = false;
        continue;
      }
      if (trimmed.startsWith("/*")) {
        if (!raw.includes("*/", raw.indexOf("/*") + 2)) inBlockComment = true;
        continue;
      }
      if (trimmed.startsWith("*") || trimmed.startsWith("//")) continue;
      const textOpens = raw.split('"""').length - 1;
      if (textOpens % 2 === 1) inTextBlock = true;
    }

    // Continue / start annotation accumulation. While a wrapped
    // signature is pending, `@Param`-style lines are parameters,
    // not declaration annotations — the pending block below owns them.
    if (annotationBuf || (trimmed.startsWith("@") && !pendingMethod)) {
      if (!annotationBuf) {
        // A non-annotation line starting with @ inside a method body is not a declaration annotation.
        if (depth > Math.max(classDepth, 0)) { /* fall through to body handling */ }
        else annotationBuf = { text: trimmed, line: lineNo };
      } else {
        annotationBuf.text += `\n${raw}`;
      }
      if (annotationBuf) {
        if (parensBalanced(annotationBuf.text)) {
          // One line can carry several marker annotations: `@A @B class X` — split leading markers.
          let rest = annotationBuf.text;
          for (;;) {
            const m = /^@([\w.]+)/.exec(rest);
            if (!m) break;
            const after = rest.slice(m[0].length);
            if (after.trimStart().startsWith("(")) {
              // Take through the balanced close of this annotation only.
              let d = 0; let end = -1;
              const whole = rest;
              for (let i = m[0].length; i < whole.length; i++) {
                if (whole[i] === "(") d++;
                else if (whole[i] === ")") { d--; if (d === 0) { end = i; break; } }
              }
              const rawAnn = end === -1 ? whole : whole.slice(0, end + 1);
              pending.push({ name: m[1]!.split(".").pop()!, args: annotationArgs(rawAnn), line: annotationBuf.line });
              rest = (end === -1 ? "" : whole.slice(end + 1)).trimStart();
            } else {
              pending.push({ name: m[1]!.split(".").pop()!, args: "", line: annotationBuf.line });
              rest = after.trimStart();
            }
            if (!rest.startsWith("@")) break;
          }
          annotationBuf = undefined;
          inTextBlock = false; // the annotation's own text blocks balanced out
          // Trailing code after annotations on the same line still declares.
          if (rest === "" || !/\b(class|interface|record|enum|object|fun)\b/.test(rest) && !/\w+\s*\(/.test(rest) && depth <= classDepth) {
            depth += braceDelta(raw);
            continue;
          }
        } else {
          continue; // still accumulating a multi-line annotation
        }
      }
    }

    // Wrapped method signature: consume lines until '{' (body),
    // ';' (abstract), or balanced parens with neither (Kotlin
    // bodiless interface fun: the declaration simply ends).
    if (pendingMethod) {
      pendingText += `\n${raw}`;
      const braceAt = raw.indexOf("{");
      depth += braceDelta(raw);
      if (braceAt !== -1 && !raw.slice(0, braceAt).includes(";")) {
        for (const m of raw.slice(braceAt).replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''").split("//")[0]!.matchAll(/(\b\w+)\.(\w+)\s*\(/g)) {
          pendingMethod.calls.push({ receiver: m[1]!, method: m[2]!, line: lineNo });
        }
        currentMethod = pendingMethod;
        methodSpan = pendingMethodSpan;
        methodBodyDepth = depth;
        if (depth <= classDepth) { currentMethod = undefined; methodBodyDepth = -1; if (methodSpan) methodSpan.end = lineNo; methodSpan = undefined; }
        pendingMethod = undefined; pendingMethodSpan = undefined; pendingText = "";
      } else if (braceAt === -1 && (raw.includes(";") || parensBalanced(pendingText))) {
        if (pendingMethodSpan) pendingMethodSpan.end = lineNo;
        pendingMethod = undefined; pendingMethodSpan = undefined; pendingText = "";
      }
      continue;
    }

    // Inside a method body: collect receiver calls, track exit.
    // String/char literal contents are stripped first: call-like
    // text inside a literal (or a trailing // comment) is not a call.
    if (currentMethod) {
      const scanLine = raw.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''").split("//")[0]!;
      const chainStart = /^\s*\.(\w+)\s*\(/.exec(scanLine);
      if (chainStart && chainReceiver) {
        currentMethod.calls.push({ receiver: chainReceiver, method: chainStart[1]!, line: lineNo });
        chainReceiver = undefined; // only the first link belongs to the field
      }
      for (const m of scanLine.matchAll(/(\b\w+)\.(\w+)\s*\(/g)) {
        currentMethod.calls.push({ receiver: m[1]!, method: m[2]!, line: lineNo });
      }
      // Bare same-class calls (`helper(...)` without `this.`):
      // recorded as this-calls and filtered below to methods this
      // file actually declares.
      for (const m of scanLine.matchAll(/(?<![\w.])([a-z]\w*)\s*\(/g)) {
        if (!KEYWORDS.has(m[1]!)) currentMethod.calls.push({ receiver: "this", method: m[1]!, line: lineNo });
      }
      const bare = /(?:return|=|\(|,)\s*(\w+)\s*$/.exec(trimmed);
      if (bare && !trimmed.includes(".")) chainReceiver = bare[1];
      else if (trimmed.endsWith(";") || trimmed.endsWith("}")) chainReceiver = undefined;
      depth += braceDelta(raw);
      if (methodBodyDepth !== -1 && depth < methodBodyDepth) {
        if (methodSpan) methodSpan.end = lineNo;
        currentMethod = undefined;
        methodBodyDepth = -1;
        methodSpan = undefined;
        chainReceiver = undefined;
      }
      continue;
    }

    if (trimmed === "" || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) {
      depth += braceDelta(raw);
      continue;
    }

    // Class declaration (first top-level type wins for class-level facts).
    if (out.className === undefined) {
      const cm = lang === "java"
        ? /\b(class|interface|record|enum)\s+(\w+)/.exec(raw)
        : /\b(class|interface|object)\s+(\w+)/.exec(raw);
      if (cm && !/^\s*(import|package)\b/.test(trimmed)) {
        out.className = cm[2]!;
        out.isInterface = cm[1] === "interface";
        // Header may continue on following lines until the body brace.
        let header = raw;
        for (let j = idx + 1; !header.includes("{") && j < lines.length && j <= idx + 8; j++) header += `\n${lines[j]}`;
        out.supertypes = parseSupertypes(header, lang, out.className);
        flushPendingOnClass(pending);
        pending = [];
        // Kotlin primary constructor: members declared in the header are injections.
        if (lang === "kotlin") {
          const header = collectUntilBalancedParen(lines, idx, raw.indexOf("("));
          if (header) {
            for (const m of header.matchAll(/(?:val|var)\s+(\w+)\s*:\s*([A-Z]\w*)/g)) {
              out.injections.push({ field: m[1]!, type: m[2]! });
            }
          }
        }
        const delta = braceDelta(raw);
        depth += delta;
        classDepth = depth;
        inClassHeader = delta === 0 && !raw.includes("{");
        headerAccum = raw;
        continue;
      }
    }

    if (inClassHeader) {
      // Constructor-header lines: fields count, methods cannot start yet.
      headerAccum += `\n${raw}`;
      const fm = matchField(raw, lang, pending);
      if (fm) out.injections.push(fm);
      pending = [];
      depth += braceDelta(raw);
      if (raw.includes("{")) {
        inClassHeader = false;
        classDepth = depth;
      } else if (parensBalanced(headerAccum) && !trimmed.endsWith(",") && trimmed !== ")" && !trimmed.endsWith(":")) {
        // Body-less type (`class X(val a: A)`): no brace is coming.
        inClassHeader = false;
        classDepth = depth;
      }
      continue;
    }

    if (out.className !== undefined && classDepth !== -1 && depth <= classDepth) {
      // Method declaration?
      const mm = matchMethod(raw, lang, out.className);
      if (mm) {
        const method: MethodInfo = { name: mm, line: lineNo, calls: [], tables: [], jpqlEntities: [] };
        handleMethodAnnotations(pending, mm, lineNo, method);
        pending = [];
        out.methods.push(method);
        for (const t of method.tables) if (!out.tables.some((x) => x.table === t.table && x.line === t.line)) out.tables.push(t);
        const delta = braceDelta(raw);
        depth += delta;
        methodSpan = { start: lineNo, end: lineNo, name: mm };
        spans.push(methodSpan);
        // Calls after the opening brace count even when the whole
        // body sits on the declaration line (net brace delta 0).
        const braceAt = raw.indexOf("{");
        if (braceAt !== -1) {
          for (const m of raw.slice(braceAt).replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''").split("//")[0]!.matchAll(/(\b\w+)\.(\w+)\s*\(/g)) {
            method.calls.push({ receiver: m[1]!, method: m[2]!, line: lineNo });
          }
        }
        // Kotlin expression body on the same line: `fun x() = repo.find()`.
        if (braceAt === -1 && lang === "kotlin") {
          const eqAt = raw.indexOf("=");
          if (eqAt !== -1 && parensBalanced(raw)) {
            for (const m of raw.slice(eqAt).replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/'(?:\\.|[^'\\])*'/g, "''").split("//")[0]!.matchAll(/(\b\w+)\.(\w+)\s*\(/g)) {
              method.calls.push({ receiver: m[1]!, method: m[2]!, line: lineNo });
            }
          }
        }
        if (delta > 0) {
          currentMethod = method;
          methodBodyDepth = depth;
          if (depth <= classDepth) { currentMethod = undefined; methodBodyDepth = -1; methodSpan.end = lineNo; methodSpan = undefined; }
        } else if (braceAt === -1 && !raw.includes(";") && !parensBalanced(raw)) {
          // Provably wrapped signature (unclosed parameter list):
          // parameters continue on following lines and the body
          // brace lands later. A balanced braceless declaration
          // (Kotlin interface fun, expression body) is complete
          // as-is and must never enter this state.
          pendingMethod = method;
          pendingMethodSpan = methodSpan;
          pendingText = raw;
        }
        continue;
      }
      // Field declaration?
      const fm = matchField(raw, lang, pending);
      if (fm) {
        out.injections.push(fm);
        pending = [];
        depth += braceDelta(raw);
        continue;
      }
      pending = [];
    }

    depth += braceDelta(raw);
    if (classDepth !== -1 && depth < classDepth && out.className !== undefined) {
      // Left the (single tracked) class body; keep scanning for file-level calls below.
      classDepth = -1;
    }
  }

  // Bare-call candidates only survive when the file declares the method.
  const declaredMethods = new Set(out.methods.map((m) => m.name));
  for (const m of out.methods) {
    m.calls = m.calls.filter((c) => c.receiver !== "this" || declaredMethods.has(c.method));
  }
  // A field seen both in a constructor header and as a member is one injection.
  out.injections = [...new Map(out.injections.map((i) => [i.field, i])).values()];
  if (out.entityTable && !out.tables.some((t) => t.table === out.entityTable!.table && t.via === "entity")) {
    out.tables.push(out.entityTable);
  }
  if (out.repoEntities.length > 0 && !out.kinds.includes("repository")) out.kinds.push("repository");

  // JAX-RS resources (@Path) are a different annotation family
  // than Spring MVC: unsupported must be visible, never silent.
  const jaxRs = lines.findIndex((l) => /@Path\s*\(/.test(l) || /import\s+(?:jakarta|javax)\.ws\.rs\./.test(l));
  if (jaxRs !== -1) out.notes.push(`JAX-RS @Path detected at line ${jaxRs + 1}: endpoints not extracted (unsupported)`);
  scanHttpCallsAndKafka(out, lines, spans, consts);
  return out;
}

function collectUntilBalancedParen(lines: string[], startIdx: number, parenAt: number): string | undefined {
  if (parenAt === -1) return undefined;
  let text = lines[startIdx]!.slice(parenAt);
  let i = startIdx;
  while (!parensBalanced(text) && i + 1 < lines.length && i < startIdx + 12) {
    i++;
    text += `\n${lines[i]}`;
  }
  return text;
}

const JAVA_METHOD_RE = /^\s*(?:@\w+(?:\([^)]*\))?\s*)*(?:public|protected|private|abstract|static|final|synchronized|native|default|strictfp|\s)*(?:<[\w\s,?<>]+>\s+)?[\w<>\[\], ?.]+?\s+(\w+)\s*\(/;
const JAVA_IFACE_METHOD_RE = /^\s*[\w<>\[\], ?.]+?\s+(\w+)\s*\([^)]*\)\s*(?:throws[\w\s,]+)?;\s*$/;
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "new", "throw", "else", "do", "synchronized", "class", "interface", "enum", "record", "import", "package"]);

function matchMethod(raw: string, lang: "java" | "kotlin", className: string): string | undefined {
  const line = raw.trim();
  if (!line.includes("(")) return undefined;
  if (/^(import|package)\b/.test(line)) return undefined;
  if (lang === "kotlin") {
    const m = /\bfun\s+(\w+)\s*\(/.exec(line);
    return m?.[1];
  }
  if (/=\s*[^=]/.test(line.split("(")[0]!)) return undefined; // field initializer / assignment
  let m = JAVA_METHOD_RE.exec(raw);
  if (!m) m = JAVA_IFACE_METHOD_RE.exec(raw);
  const name = m?.[1];
  if (!name || KEYWORDS.has(name) || name === className) return undefined;
  return name;
}

function matchField(raw: string, lang: "java" | "kotlin", pending: Annotation[]): { field: string; type: string } | undefined {
  const line = raw.trim();
  if (line.includes("(")) return undefined;
  if (lang === "kotlin") {
    const m = /(?:private\s+|protected\s+|internal\s+|lateinit\s+)*(?:val|var)\s+(\w+)\s*:\s*([A-Z]\w*)/.exec(line);
    return m ? { field: m[1]!, type: m[2]! } : undefined;
  }
  const m = /^(?:private|protected|public)\s+(?:static\s+|final\s+|transient\s+|volatile\s+)*([\w<>\[\], ?.]+?)\s+(\w+)\s*(?:=|;)/.exec(line);
  if (!m) {
    if (!pending.some((a) => a.name === "Autowired" || a.name === "Inject" || a.name === "Resource")) return undefined;
    const bare = /^([\w<>\[\], ?.]+?)\s+(\w+)\s*(?:=|;)/.exec(line);
    if (!bare) return undefined;
    const type = bare[1]!.replace(/<.*>/, "").trim().split(/\s+/).pop()!;
    return /^[A-Z]/.test(type) ? { field: bare[2]!, type } : undefined;
  }
  const type = m[1]!.replace(/<.*>/, "").trim().split(/\s+/).pop()!.replace(/\[\]$/, "");
  return { field: m[2]!, type };
}

function callerAt(spans: Span[], lineNo: number): string {
  for (const s of spans) if (lineNo >= s.start && lineNo <= s.end) return s.name;
  return "";
}

function isAbsoluteUrl(rawUrl: string): boolean {
  return rawUrl.startsWith("http://") || rawUrl.startsWith("https://");
}

function urlPath(rawUrl: string): string {
  if (rawUrl.startsWith("http://") || rawUrl.startsWith("https://")) {
    try { return new URL(rawUrl).pathname; } catch { return rawUrl; }
  }
  return rawUrl;
}

const REST_TEMPLATE_METHODS: Record<string, string> = {
  getForObject: "GET", getForEntity: "GET", postForObject: "POST", postForEntity: "POST",
  postForLocation: "POST", put: "PUT", delete: "DELETE", patchForObject: "PATCH",
};

function scanHttpCallsAndKafka(out: FileConnections, lines: string[], spans: Span[], consts: Map<string, string>) {
  let inBlock = false;
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const lineNo = idx + 1;
    const trimmedScan = raw.trim();
    if (inBlock) { if (raw.includes("*/")) inBlock = false; continue; }
    if (trimmedScan.startsWith("/*") && !raw.includes("*/", raw.indexOf("/*") + 2)) { inBlock = true; continue; }
    if (trimmedScan.startsWith("//") || trimmedScan.startsWith("*")) continue;
    // WebClient .uri("...") / .uri(base + "...") / baseUrl(x + "...")
    const uri = /\.(?:uri|baseUrl)\(\s*([\w.]+\s*\+\s*)?"([^"]+)"/.exec(raw);
    if (uri) {
      const window = lines.slice(Math.max(0, idx - 4), Math.min(lines.length, idx + 5)).join("\n");
      const verb = /\.(get|post|put|delete|patch)\s*\(\s*\)/.exec(window)?.[1]?.toUpperCase()
        ?? /HttpMethod\.(\w+)/.exec(window)?.[1]?.toUpperCase() ?? "ANY";
      const p = uri[2]!;
      if (p.startsWith("/") || p.startsWith("http")) {
        out.calls.push({ method: verb, path: urlPath(p), via: "webclient", caller: callerAt(spans, lineNo), line: lineNo, dynamicBase: uri[1] !== undefined || undefined, absoluteUrl: isAbsoluteUrl(p) || undefined });
      } else {
        out.notes.push(`unresolved WebClient uri at line ${lineNo}`);
      }
    } else if (/\.uri\(\s*(?!")/.test(raw)) {
      out.notes.push(`unresolved WebClient uri at line ${lineNo}`);
    }
    // RestTemplate
    const rt = /\.(getForObject|getForEntity|postForObject|postForEntity|postForLocation|patchForObject|put|delete|exchange)\(\s*([\w.]+\s*\+\s*)?"([^"]+)"/.exec(raw);
    if (rt) {
      let verb = REST_TEMPLATE_METHODS[rt[1]!] ?? "ANY";
      if (rt[1] === "exchange") {
        const window = lines.slice(idx, Math.min(lines.length, idx + 4)).join("\n");
        verb = /HttpMethod\.(\w+)/.exec(window)?.[1]?.toUpperCase() ?? "ANY";
      }
      // A Map/Properties .put("some.key", ...) is not an HTTP call:
      // only URL-shaped first arguments count.
      if (rt[3]!.startsWith("/") || rt[3]!.startsWith("http")) {
        out.calls.push({ method: verb, path: urlPath(rt[3]!), via: "resttemplate", caller: callerAt(spans, lineNo), line: lineNo, dynamicBase: rt[2] !== undefined || undefined, absoluteUrl: isAbsoluteUrl(rt[3]!) || undefined });
      }
    }
    // Kafka produce
    const send = /kafkaTemplate\.send\(\s*(?:"([^"]+)"|(\w+))/.exec(raw)
      ?? /\.send\(\s*new\s+ProducerRecord<[^>]*>\(\s*"([^"]+)"/.exec(raw);
    if (send) {
      const literal = send[1] ?? send[3];
      const topic = literal ?? (send[2] ? consts.get(send[2]) : undefined);
      if (topic) out.topics.push({ topic, direction: "produce", handler: callerAt(spans, lineNo), line: lineNo });
      else out.notes.push(`unresolved Kafka topic at line ${lineNo}`);
    }
  }
}

// --- TS / Python / Go literal HTTP passes -------------------------------

/** A literal immediately concatenated (`"/users/" + id`) is a prefix, not a complete path. */
function concatAfter(raw: string, m: RegExpExecArray): boolean {
  return raw.slice((m.index ?? 0) + m[0].length).trimStart().startsWith("+");
}

function extractTs(path: string, content: string): FileConnections {
  const out = empty(path);
  const lines = content.split("\n");
  // Nest class-level prefix: @Controller("users") or @Controller({ path: "users" }).
  const nestPrefix = /@Controller\(\s*(?:["'`]([^"'`$]+)["'`]|\{[^}]*\bpath\s*:\s*["'`]([^"'`$]+)["'`])/.exec(content);
  const prefix = nestPrefix ? `/${(nestPrefix[1] ?? nestPrefix[2]!).replace(/^\/+|\/+$/g, "")}` : "";
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const lineNo = idx + 1;
    // `api` receivers are usually HTTP clients (axios instances),
    // not servers — only well-known server/router names declare.
    const ep = /\b(?:app|router|server|fastify)\.(get|post|put|delete|patch|all)\s*\(\s*["'`]([^"'`$]+)["'`]/.exec(raw);
    if (ep && concatAfter(raw, ep)) out.notes.push(`unresolved route path (concatenated) at line ${lineNo}`);
    else if (ep) out.endpoints.push({ method: ep[1]!.toUpperCase(), path: ep[2]!, handler: "", line: lineNo });
    const nest = /@(Get|Post|Put|Delete|Patch)\s*\(\s*(?:["'`]([^"'`$]*)["'`])?\s*\)/.exec(raw);
    if (nest) out.endpoints.push({ method: nest[1]!.toUpperCase(), path: joinPaths(prefix, nest[2] ?? ""), handler: "", line: lineNo });
    const f = /\bfetch\(\s*["'`]([^"'`$]+)["'`]/.exec(raw);
    if (f && concatAfter(raw, f)) {
      out.notes.push(`unresolved fetch URL (concatenated) at line ${lineNo}`);
    } else if (f) {
      const win = lines.slice(idx, Math.min(lines.length, idx + 4)).join("\n");
      const verb = /method\s*:\s*["'`](\w+)["'`]/.exec(win)?.[1]?.toUpperCase() ?? "GET";
      out.calls.push({ method: verb, path: urlPath(f[1]!), via: "fetch", caller: "", line: lineNo, absoluteUrl: isAbsoluteUrl(f[1]!) || undefined });
    } else if (/\bfetch\(\s*`[^`]*\$\{/.test(raw)) {
      out.notes.push(`unresolved fetch URL (template) at line ${lineNo}`);
    }
    const ax = /\baxios\.(get|post|put|delete|patch)\s*\(\s*["'`]([^"'`$]+)["'`]/.exec(raw);
    if (ax && concatAfter(raw, ax)) out.notes.push(`unresolved axios URL (concatenated) at line ${lineNo}`);
    else if (ax) out.calls.push({ method: ax[1]!.toUpperCase(), path: urlPath(ax[2]!), via: "fetch", caller: "", line: lineNo, absoluteUrl: isAbsoluteUrl(ax[2]!) || undefined });
  }
  return out;
}

function extractPy(path: string, content: string): FileConnections {
  const out = empty(path);
  const lines = content.split("\n");
  // Django URLconfs are not decorator routes: say so instead of silence.
  if (/django\.urls|django\.conf\.urls/.test(content) || /(^|\/)urls\.py$/.test(path) && /\burlpatterns\b/.test(content)) {
    out.notes.push("Django URLconf detected: endpoints not extracted (unsupported)");
  }
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const lineNo = idx + 1;
    const dec = /@\w+(?:\.\w+)*\.(get|post|put|delete|patch|route|api_route)\s*\(\s*["']([^"']+)["']/.exec(raw);
    if (dec && concatAfter(raw, dec)) {
      out.notes.push(`unresolved route path (concatenated) at line ${lineNo}`);
    } else if (dec) {
      let handler = "";
      for (let j = idx + 1; j < Math.min(lines.length, idx + 5); j++) {
        const d = /^\s*(?:async\s+)?def\s+(\w+)/.exec(lines[j]!);
        if (d) { handler = d[1]!; break; }
      }
      const verb = dec[1] === "route" || dec[1] === "api_route" ? "ANY" : dec[1]!.toUpperCase();
      out.endpoints.push({ method: verb, path: dec[2]!, handler, line: lineNo });
    }
    const req = /\b(?:requests|httpx|session|client)\.(get|post|put|delete|patch)\s*\(\s*["']([^"']+)["']/.exec(raw);
    if (req && concatAfter(raw, req)) out.notes.push(`unresolved HTTP URL (concatenated) at line ${lineNo}`);
    else if (req) out.calls.push({ method: req[1]!.toUpperCase(), path: urlPath(req[2]!), via: "http", caller: "", line: lineNo, absoluteUrl: isAbsoluteUrl(req[2]!) || undefined });
    else if (/\b(?:requests|httpx)\.(?:get|post|put|delete|patch)\s*\(\s*f["']/.test(raw)) {
      out.notes.push(`unresolved HTTP URL (f-string) at line ${lineNo}`);
    }
  }
  return out;
}

function extractGo(path: string, content: string): FileConnections {
  const out = empty(path);
  const lines = content.split("\n");
  for (let idx = 0; idx < lines.length; idx++) {
    const raw = lines[idx]!;
    const lineNo = idx + 1;
    const hf = /\b(?:\w+\.)?HandleFunc\s*\(\s*"([^"]+)"/.exec(raw) ?? /\b(?:\w+\.)?Handle\s*\(\s*"([^"]+)"/.exec(raw);
    if (hf) {
      const pattern = hf[1]!;
      const withVerb = /^(\w+)\s+(\/\S*)$/.exec(pattern.trim());
      out.endpoints.push(
        withVerb && ["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD"].includes(withVerb[1]!)
          ? { method: withVerb[1]!, path: withVerb[2]!, handler: "", line: lineNo }
          : { method: "ANY", path: pattern, handler: "", line: lineNo },
      );
    }
    const gin = /\.(GET|POST|PUT|DELETE|PATCH)\s*\(\s*"([^"]+)"/.exec(raw);
    if (gin && concatAfter(raw, gin)) out.notes.push(`unresolved route path (concatenated) at line ${lineNo}`);
    else if (gin) out.endpoints.push({ method: gin[1]!, path: gin[2]!, handler: "", line: lineNo });
    const get = /\bhttp\.Get\s*\(\s*"([^"]+)"/.exec(raw);
    if (get && concatAfter(raw, get)) out.notes.push(`unresolved HTTP URL (concatenated) at line ${lineNo}`);
    else if (get) out.calls.push({ method: "GET", path: urlPath(get[1]!), via: "http", caller: "", line: lineNo, absoluteUrl: isAbsoluteUrl(get[1]!) || undefined });
    const post = /\bhttp\.Post\s*\(\s*"([^"]+)"/.exec(raw);
    if (post && concatAfter(raw, post)) out.notes.push(`unresolved HTTP URL (concatenated) at line ${lineNo}`);
    else if (post) out.calls.push({ method: "POST", path: urlPath(post[1]!), via: "http", caller: "", line: lineNo, absoluteUrl: isAbsoluteUrl(post[1]!) || undefined });
  }
  return out;
}

