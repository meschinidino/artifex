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
import type { EndpointCall, FileConnections, MethodInfo, TableDecl, TableUse, TopicUse } from "./types.ts";
import { joinPaths } from "./types.ts";

type Lang = "java" | "kotlin" | "ts" | "py" | "go" | "sql";

export function connectionsLang(path: string): Lang | undefined {
  if (/\.java$/.test(path)) return "java";
  if (/\.(kt|kts)$/.test(path)) return "kotlin";
  if (/\.(tsx?|jsx?|mts|cts|mjs|cjs)$/.test(path)) return "ts";
  if (/\.py$/.test(path)) return "py";
  if (/\.go$/.test(path)) return "go";
  if (/\.sql$/.test(path)) return "sql";
  return undefined;
}

export function extractConnections(path: string, content: string): FileConnections | undefined {
  const lang = connectionsLang(path);
  if (!lang) return undefined;
  if (lang === "java" || lang === "kotlin") return extractJvm(path, content, lang);
  if (lang === "ts") return extractTs(path, content);
  if (lang === "py") return extractPy(path, content);
  if (lang === "go") return extractGo(path, content);
  return extractSql(path, content);
}

function empty(path: string): FileConnections {
  return {
    path, kinds: [], supertypes: [], endpoints: [], calls: [], tables: [], declaredTables: [], repoEntities: [],
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

// --- `.sql` script pass --------------------------------------------------------

type SqlStatement = {
  /** Raw statement slice (quoted names recover from here). */
  text: string;
  /** Same length: comments/strings/dollar bodies/meta masked with spaces, newlines kept. */
  masked: string;
  startLine: number;
  /** 1-based opening lines of dollar-quoted bodies in this statement. */
  dollarLines: number[];
};

type SqlNote = { line: number; text: string };

/**
 * Statement splitter: `;` outside string literals (`'...'`, `"..."`,
 * backticks, `$$...$$`/`$tag$...$tag$`), line (`--`, and `#` per
 * the Postgres operator carve-out) and block (`/* ... *\/`)
 * comments, and psql meta-command lines. Masked text keeps every
 * offset (facts cite true token lines) while comment and string
 * contents can never match a keyword. An unterminated dollar
 * quote still masks to EOF, but notes itself (never silent).
 */
function splitSql(content: string): { statements: SqlStatement[]; notes: SqlNote[] } {
  const statements: SqlStatement[] = [];
  const notes: SqlNote[] = [];
  const raw: string[] = [];
  const masked: string[] = [];
  const dollarLines: number[] = [];
  let line = 1;
  let stmtStartLine = 1;
  let i = 0;
  const n = content.length;
  const push = (c: string, mask: boolean): void => {
    raw.push(c);
    masked.push(mask && c !== "\n" ? " " : c);
  };
  const flush = (): void => {
    if (masked.join("").trim() !== "") {
      statements.push({ text: raw.join(""), masked: masked.join(""), startLine: stmtStartLine, dollarLines: [...dollarLines] });
    }
    raw.length = 0;
    masked.length = 0;
    dollarLines.length = 0;
  };
  while (i < n) {
    const c = content[i]!;
    if (c === "-" && content[i + 1] === "-") {
      push(c, true);
      push(content[i + 1]!, true);
      i += 2;
      while (i < n && content[i] !== "\n") {
        push(content[i]!, true);
        i++;
      }
      continue;
    }
    if (c === "#") {
      // Postgres operators, not comments: `#>`/`#>>` (json path),
      // `#-` (json delete), and `#` glued to code (`a#b` xor). A
      // `#` opens a comment only after whitespace/line-start and
      // before anything but `>`, `-`, `#`.
      const next = content[i + 1];
      const prev = i === 0 ? "\n" : content[i - 1]!;
      if (next === ">" || next === "-" || next === "#" || !/\s/.test(prev)) {
        push(c, false);
        i++;
        continue;
      }
      while (i < n && content[i] !== "\n") {
        push(content[i]!, true);
        i++;
      }
      continue;
    }
    if (c === "/" && content[i + 1] === "*") {
      // Block comments nest (Postgres): the comment runs until the
      // matching close, so inner keyword text never leaks as facts.
      let depth = 1;
      push(c, true);
      push(content[i + 1]!, true);
      i += 2;
      while (i < n && depth > 0) {
        if (content[i] === "/" && content[i + 1] === "*") {
          depth++;
          push(content[i]!, true);
          push(content[i + 1]!, true);
          i += 2;
          continue;
        }
        if (content[i] === "*" && content[i + 1] === "/") {
          depth--;
          push(content[i]!, true);
          push(content[i + 1]!, true);
          i += 2;
          continue;
        }
        if (content[i] === "\n") line++;
        push(content[i]!, true);
        i++;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === "`") {
      const q = c;
      push(c, false);
      i++;
      while (i < n) {
        const d = content[i]!;
        if (d === q) {
          if (content[i + 1] === q) {
            push(d, true);
            push(content[i + 1]!, true);
            i += 2;
            continue;
          }
          push(d, false);
          i++;
          break;
        }
        if (d === "\\" && i + 1 < n) {
          push(d, true);
          i++;
          const e = content[i]!;
          if (e === "\n") line++;
          push(e, true);
          i++;
          continue;
        }
        if (d === "\n") line++;
        push(d, true);
        i++;
      }
      continue;
    }
    if (c === "$") {
      let j = i + 1;
      if (j < n && /[A-Za-z_]/.test(content[j]!)) {
        j++;
        while (j < n && /\w/.test(content[j]!)) j++;
      }
      if (content[j] === "$") {
        const tag = content.slice(i, j + 1);
        dollarLines.push(line);
        const openLine = line;
        for (let k = i; k <= j; k++) push(content[k]!, true);
        i = j + 1;
        const end = content.indexOf(tag, i);
        if (end === -1) notes.push({ line: openLine, text: `unresolved unterminated dollar-quote at line ${openLine}` });
        const bodyEnd = end === -1 ? n : end + tag.length;
        while (i < bodyEnd) {
          if (content[i] === "\n") line++;
          push(content[i]!, true);
          i++;
        }
        continue;
      }
    }
    if (c === "\\") {
      const eol = content.indexOf("\n", i);
      if (/^\\(include|ir|i|gexec)\b/.test(content.slice(i, eol === -1 ? n : eol))) {
        notes.push({ line, text: `unresolved psql meta-command at line ${line}` });
      }
      while (i < n && content[i] !== "\n") {
        push(content[i]!, true);
        i++;
      }
      continue;
    }
    if (c === ";") {
      flush();
      stmtStartLine = line;
      i++;
      continue;
    }
    if (c === "\n") line++;
    push(c, false);
    i++;
  }
  flush();
  return { statements, notes };
}

/** One identifier part: double-quoted, backticked, bracketed, printf placeholder, or a bare run (placeholders detected later). */
const SQL_NAME_PART_SRC = "\"[^\"]*\"|`[^`]*`|\\[[^\\]]*\\]|%\\([^)]*\\)s|[^\\s().,;]+";
const SQL_NAME_RE = new RegExp(`^\\s*((?:${SQL_NAME_PART_SRC})(?:\\s*\\.\\s*(?:${SQL_NAME_PART_SRC}))*)`);

/** Placeholder shapes in a table-name position: template, bind, numeric, printf, JDBC, and T-SQL variable. */
const SQL_PLACEHOLDER_RE = /\$\{|\$[0-9]|:[A-Za-z_]|%\([^)]*\)s|\?|@[A-Za-z_]/;

type SqlName = {
  /** Lowercased dotted name (unquoted). */
  full: string;
  parts: { text: string; quoted: boolean }[];
  /** Offsets of the name in the scanned text. */
  start: number;
  end: number;
  /** The raw candidate contains a placeholder shape. */
  placeholder: boolean;
  /** Every part is a plausible identifier (bare parts are word chars). */
  valid: boolean;
};

function unquotePart(raw: string): { text: string; quoted: boolean } {
  if (raw.startsWith('"')) return { text: raw.slice(1, -1).replace(/""/g, '"'), quoted: true };
  if (raw.startsWith("`")) return { text: raw.slice(1, -1).replace(/``/g, "`"), quoted: true };
  if (raw.startsWith("[")) return { text: raw.slice(1, -1).replace(/\]\]/g, "]"), quoted: true };
  return { text: raw, quoted: false };
}

/** Table-name candidate at `at` in masked text; the name itself recovers from raw (same offsets). */
function sqlNameAt(work: string, raw: string, at: number): SqlName | undefined {
  const m = SQL_NAME_RE.exec(work.slice(at));
  if (!m || !m[1]) return undefined;
  const base = at + (m[0].length - m[1].length);
  const rawName = raw.slice(base, base + m[1].length);
  // Dots surviving in masked text are structural (dots inside quotes
  // are spaces there), so spans cut names without breaking `"a.b"`.
  const spans: [number, number][] = [];
  let start = 0;
  for (let k = 0; k <= m[1].length; k++) {
    if (k === m[1].length || m[1][k] === ".") {
      spans.push([start, k]);
      start = k + 1;
    }
  }
  const parts = spans.map(([a, b]) => unquotePart(rawName.slice(a, b).trim()));
  return {
    full: parts.map((p) => p.text.toLowerCase()).join("."),
    parts,
    start: base,
    end: at + m[0].length,
    placeholder: SQL_PLACEHOLDER_RE.test(rawName),
    valid: parts.every((p) => p.text.length > 0 && (p.quoted || /^[\w$]+$/.test(p.text))),
  };
}

/** Statement-verb access for script references: the sqlAccess rules plus WITH-led and CTAS/view shapes. */
function scriptVerb(masked: string): TableUse["access"] {
  const head = masked.trimStart().slice(0, 8).toUpperCase();
  if (head.startsWith("SELECT")) return "read";
  if (head.startsWith("UPDATE") || head.startsWith("INSERT") || head.startsWith("DELETE")) return "write";
  if (/^\s*WITH\b/i.test(masked)) return /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(masked) ? "write" : "read";
  if (/^\s*CREATE\b/i.test(masked) && /\bSELECT\b/i.test(masked)) return "read";
  return "unknown";
}

/** Noise words between a reference keyword and its table (documented Postgres SELECT-INTO / ONLY / LATERAL shapes). */
function skipTableNoise(work: string, kw: string, at: number): number {
  if (kw === "INTO") return at + (/^\s*(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?(?:TABLE\s+)?/i.exec(work.slice(at))?.[0].length ?? 0);
  return at + (/^\s*(?:ONLY\s+)?(?:LATERAL\s+)?/i.exec(work.slice(at))?.[0].length ?? 0);
}

/** Line of a statement-anchored keyword match (leading trivia skipped, never the statement start). */
function keywordLine(lineAt: (rel: number) => number, m: RegExpExecArray): number {
  return lineAt(m.index + /^\s*/.exec(m[0])![0].length);
}

type SqlStmtCtx = {
  raw: string;
  masked: string;
  /** Evolving copy: consumed DDL spans blank out so later matchers cannot re-read them. */
  work: string;
  notes: SqlNote[];
  declaredTables: TableDecl[];
  tables: TableUse[];
  lineAt: (rel: number) => number;
};

function blankWork(ctx: SqlStmtCtx, from: number, to: number): void {
  ctx.work = ctx.work.slice(0, from) + ctx.work.slice(from, to).replace(/[^\n]/g, " ") + ctx.work.slice(to);
}

function extractSqlCreate(ctx: SqlStmtCtx): void {
  const { raw, masked, notes, declaredTables, lineAt } = ctx;
  const createTable = /^\s*CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?(?:(?:TEMP|TEMPORARY)\s+)?(?:UNLOGGED\s+)?(?:FOREIGN\s+)?TABLE\b/i.exec(masked);
  const createView = createTable ? undefined : /^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:TEMP(?:ORARY)?\s+)?(?:MATERIALIZED\s+)?VIEW\b/i.exec(masked);
  const kind = createTable ? "TABLE" : createView ? "VIEW" : undefined;
  const decl = createTable ?? createView;
  if (!kind || !decl) return;
  const kwEnd = decl.index + decl[0].length;
  const nameAt = kwEnd + (/^\s*(?:IF\s+NOT\s+EXISTS\s+)?/i.exec(masked.slice(kwEnd))![0].length);
  const name = sqlNameAt(ctx.work, raw, nameAt);
  const cline = keywordLine(lineAt, decl);
  if (!name) {
    notes.push({ line: cline, text: `unresolved CREATE ${kind} name at line ${cline}` });
    blankWork(ctx, decl.index, kwEnd);
    return;
  }
  if (name.placeholder) {
    notes.push({ line: cline, text: `unresolved placeholder table name at line ${cline}` });
    blankWork(ctx, decl.index, name.end);
    return;
  }
  if (!name.valid || name.parts.length > 2) {
    notes.push({ line: cline, text: `unresolved CREATE ${kind} name at line ${cline}` });
    blankWork(ctx, decl.index, name.end);
    return;
  }
  const temporary = /(GLOBAL|LOCAL|TEMPORARY|TEMP)\b/i.test(decl[0]);
  const table = name.parts[name.parts.length - 1]!.text.toLowerCase();
  const schema = name.parts.length === 2 ? name.parts[0]!.text.toLowerCase() : undefined;
  const out: TableDecl = schema ? { table, line: cline, schema } : { table, line: cline };
  if (temporary) out.temporary = true;
  declaredTables.push(out);
  blankWork(ctx, decl.index, name.end);
}

function extractSqlAlter(ctx: SqlStmtCtx): void {
  const { raw, masked, notes, tables, lineAt } = ctx;
  const alter = /^\s*ALTER\s+TABLE\b/i.exec(masked);
  if (!alter) return;
  const kwEnd = alter.index + alter[0].length;
  const nameAt = kwEnd + (/^\s*(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?/i.exec(masked.slice(kwEnd))![0].length);
  const name = sqlNameAt(ctx.work, raw, nameAt);
  const aline = keywordLine(lineAt, alter);
  if (!name) {
    notes.push({ line: aline, text: `unresolved ALTER TABLE name at line ${aline}` });
    blankWork(ctx, alter.index, kwEnd);
    return;
  }
  if (name.placeholder) {
    notes.push({ line: aline, text: `unresolved placeholder table name at line ${aline}` });
    blankWork(ctx, alter.index, name.end);
    return;
  }
  if (!name.valid || SQL_STOPWORDS.has(name.full)) {
    notes.push({ line: aline, text: `unresolved ALTER TABLE name at line ${aline}` });
    blankWork(ctx, alter.index, name.end);
    return;
  }
  tables.push({ table: name.full, access: "write", via: "ddl", derived: "explicit", line: aline });
  blankWork(ctx, alter.index, name.end);
}

function extractSqlDrop(ctx: SqlStmtCtx): void {
  const { raw, masked, notes, tables, lineAt } = ctx;
  const drop = /^\s*DROP\s+TABLE\b/i.exec(masked);
  if (!drop) return;
  const kwEnd = drop.index + drop[0].length;
  let at = kwEnd + (/^\s*(?:IF\s+EXISTS\s+)?/i.exec(masked.slice(kwEnd))![0].length);
  const dline = keywordLine(lineAt, drop);
  let found = 0;
  for (;;) {
    const name = sqlNameAt(ctx.work, raw, at);
    if (!name) break;
    // A bare CASCADE/RESTRICT ends the list (never a table); a quoted one is deliberate.
    if (!name.parts[0]!.quoted && (name.full === "cascade" || name.full === "restrict")) break;
    at = name.end;
    if (name.placeholder) {
      notes.push({ line: dline, text: `unresolved placeholder table name at line ${dline}` });
      found++;
    } else if (name.valid && !SQL_STOPWORDS.has(name.full)) {
      tables.push({ table: name.full, access: "write", via: "ddl", derived: "explicit", line: dline });
      found++;
    }
    const comma = /^\s*,/i.exec(ctx.work.slice(at));
    if (!comma) break;
    at += comma[0].length;
  }
  if (found === 0) notes.push({ line: dline, text: `unresolved DROP TABLE name at line ${dline}` });
  blankWork(ctx, drop.index, found === 0 ? kwEnd : at);
}

function extractSqlIndex(ctx: SqlStmtCtx): void {
  const { raw, masked, notes, tables, lineAt } = ctx;
  if (!/^\s*CREATE\s+(?:UNIQUE\s+)?(?:CONCURRENTLY\s+)?INDEX\b/i.test(masked)) return;
  const onAt = ctx.work.search(/\bON\b/i);
  if (onAt === -1) {
    const cline = lineAt(/^\s*/.exec(masked)![0].length);
    notes.push({ line: cline, text: `unresolved CREATE INDEX name at line ${cline}` });
    return;
  }
  const nameAt = onAt + 2 + (/^\s*(?:ONLY\s+)?/i.exec(ctx.work.slice(onAt + 2))![0].length);
  const name = sqlNameAt(ctx.work, raw, nameAt);
  const oline = lineAt(onAt);
  if (!name) {
    notes.push({ line: oline, text: `unresolved CREATE INDEX name at line ${oline}` });
    blankWork(ctx, onAt, onAt + 2);
    return;
  }
  if (name.placeholder) {
    notes.push({ line: oline, text: `unresolved placeholder table name at line ${oline}` });
    blankWork(ctx, onAt, name.end);
    return;
  }
  if (!name.valid || SQL_STOPWORDS.has(name.full)) {
    notes.push({ line: oline, text: `unresolved CREATE INDEX name at line ${oline}` });
    blankWork(ctx, onAt, name.end);
    return;
  }
  tables.push({ table: name.full, access: "unknown", via: "ddl", derived: "explicit", line: oline });
  blankWork(ctx, onAt, name.end);
}

/** Comma-continued tables after a FROM/JOIN/UPDATE match (`FROM a, b`); each cites its own name line. */
function extractSqlCommas(ctx: SqlStmtCtx, access: TableUse["access"], at: number): number {
  const { raw, notes, tables, lineAt } = ctx;
  let cur = at;
  for (;;) {
    const comma = /^\s*,/i.exec(ctx.work.slice(cur));
    if (!comma) return cur;
    const name = sqlNameAt(ctx.work, raw, skipTableNoise(ctx.work, "FROM", cur + comma[0].length));
    if (!name) return cur;
    cur = name.end;
    if (name.placeholder) {
      notes.push({ line: lineAt(name.start), text: `unresolved placeholder table name at line ${lineAt(name.start)}` });
    } else if (name.valid && !SQL_STOPWORDS.has(name.full)) {
      tables.push({ table: name.full, access, via: "sql-script", derived: "explicit", line: lineAt(name.start) });
    }
  }
}

function extractSqlRefs(ctx: SqlStmtCtx): void {
  const { raw, masked, notes, tables, lineAt } = ctx;
  const insertMode = /\bINSERT\s+INTO\b/i.test(masked);
  const selectInto = !insertMode && /^\s*(SELECT|WITH|CREATE)\b/i.test(masked);
  const selectAt = masked.search(/\bSELECT\b/i);
  const verb = scriptVerb(masked);
  for (const m of ctx.work.matchAll(/\b(FROM|JOIN|UPDATE|INTO|TABLE)\b/gi)) {
    const kw = m[1]!.toUpperCase();
    const at = m.index ?? 0;
    // Matches computed before blanking: a keyword blanked by an
    // earlier span (TABLE inside SELECT..INTO TEMP TABLE) is spent.
    if (ctx.work.slice(at, at + m[0].length).trim() === "") continue;
    // FK `ON UPDATE CASCADE`: the UPDATE takes no table (CASCADE is never one).
    if (kw === "UPDATE" && /\bON\s+$/i.test(ctx.work.slice(0, at))) {
      blankWork(ctx, at, at + m[0].length);
      continue;
    }
    const name = sqlNameAt(ctx.work, raw, skipTableNoise(ctx.work, kw, at + m[0].length));
    const kline = lineAt(at);
    if (!name) {
      blankWork(ctx, at, at + m[0].length);
      continue;
    }
    if (name.placeholder) {
      notes.push({ line: kline, text: `unresolved placeholder table name at line ${kline}` });
      blankWork(ctx, at, name.end);
      continue;
    }
    // `UPDATE ON` only happens in CREATE TRIGGER headers (the target
    // follows ON): a bare `on` there is never a table.
    if (!name.valid || SQL_STOPWORDS.has(name.full) || (kw === "UPDATE" && !name.parts[0]!.quoted && name.full === "on")) {
      blankWork(ctx, at, name.end);
      continue;
    }
    if (kw === "INTO" && selectInto) {
      // SELECT ... INTO creates without a CREATE TABLE token: a use, not a declaration.
      tables.push({ table: name.full, access: "write", via: "ddl", derived: "explicit", line: kline });
      blankWork(ctx, at, name.end);
      continue;
    }
    let access: TableUse["access"] = insertMode ? (kw === "INTO" ? "write" : "read") : verb;
    if (!insertMode && kw === "FROM" && selectAt !== -1 && at > selectAt) access = "read";
    tables.push({ table: name.full, access, via: "sql-script", derived: "explicit", line: kline });
    blankWork(ctx, at, kw === "INTO" || kw === "TABLE" ? name.end : extractSqlCommas(ctx, access, name.end));
  }
}

function extractSqlReferences(ctx: SqlStmtCtx): void {
  const { raw, masked, notes, tables, lineAt } = ctx;
  if (!/^\s*CREATE\s+/i.test(masked) && !/^\s*ALTER\s+TABLE\b/i.test(masked)) return;
  for (const m of ctx.work.matchAll(/\bREFERENCES\s*/gi)) {
    const at = m.index ?? 0;
    if (ctx.work.slice(at, at + m[0].length).trim() === "") continue;
    const name = sqlNameAt(ctx.work, raw, at + m[0].length);
    const rline = lineAt(at);
    if (!name) {
      blankWork(ctx, at, at + m[0].length);
      continue;
    }
    if (name.placeholder) {
      notes.push({ line: rline, text: `unresolved placeholder table name at line ${rline}` });
      blankWork(ctx, at, name.end);
      continue;
    }
    if (!name.valid || SQL_STOPWORDS.has(name.full)) {
      blankWork(ctx, at, name.end);
      continue;
    }
    tables.push({ table: name.full, access: "unknown", via: "ddl", derived: "explicit", line: rline });
    blankWork(ctx, at, name.end);
  }
}

/**
 * Noise blanking before the keyword loop (the `cleanSql` precedent,
 * balanced): function calls whose inner `FROM` is syntax, not a
 * table (`EXTRACT(YEAR FROM d)`, `TRIM(x FROM y)`, `SUBSTRING(x
 * FROM 1)`, `OVERLAY(x PLACING y FROM 1)`, `POSITION(x IN y)`),
 * plus the `IS DISTINCT FROM` predicate. Same length (newlines
 * kept): offsets still cite true token lines.
 */
function blankSqlScriptNoise(work: string): string {
  const chars = work.split("");
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (chars[k] !== "\n") chars[k] = " ";
  };
  for (const m of work.matchAll(/\b(EXTRACT|TRIM|SUBSTRING|OVERLAY|POSITION)\s*\(/gi)) {
    let depth = 0;
    let k = (m.index ?? 0) + m[0].length - 1; // at the opening paren
    for (; k < work.length; k++) {
      if (work[k] === "(") depth++;
      else if (work[k] === ")") {
        depth--;
        if (depth === 0) {
          k++;
          break;
        }
      }
    }
    blank(m.index ?? 0, Math.min(k, work.length));
  }
  for (const m of work.matchAll(/\bDISTINCT\s+FROM\b/gi)) blank(m.index ?? 0, (m.index ?? 0) + m[0].length);
  return chars.join("");
}

/**
 * Literal-only `.sql` extraction: CREATE TABLE/VIEW declarations plus
 * file-level table uses, every fact citing its own token line. Scripts
 * have no methods, so endpoints/calls/topics/injections stay empty and
 * dynamics land in notes, never as facts.
 */
export function extractSql(path: string, content: string): FileConnections {
  const out = empty(path);
  out.kinds = ["sql"];
  const { statements, notes } = splitSql(content);
  for (const st of statements) {
    const ctx: SqlStmtCtx = {
      raw: st.text,
      masked: st.masked,
      work: blankSqlScriptNoise(st.masked),
      notes,
      declaredTables: out.declaredTables,
      tables: out.tables,
      lineAt: (rel: number): number => {
        let l = st.startLine;
        for (let k = 0; k < rel; k++) if (st.masked.charCodeAt(k) === 10) l++;
        return l;
      },
    };
    // Dynamic DDL proves nothing: EXEC(UTE) statements yield a note, never facts.
    const exec = /^\s*EXEC(UTE)?\b/i.exec(st.masked);
    if (exec) {
      const at = exec.index + /^\s*/.exec(exec[0])![0].length;
      const word = exec[1] ? "EXECUTE" : "EXEC";
      notes.push({ line: ctx.lineAt(at), text: `unresolved ${word} statement at line ${ctx.lineAt(at)}` });
      continue;
    }
    // Function/procedure bodies are opaque in v1: one note per dollar-quoted body.
    if (st.dollarLines.length > 0 && (/^\s*CREATE\b/i.test(st.masked) && /\b(FUNCTION|PROCEDURE)\b/i.test(st.masked) || /^\s*DO\b/i.test(st.masked))) {
      for (const dl of st.dollarLines) notes.push({ line: dl, text: `unresolved dollar-quoted body at line ${dl}` });
    }
    extractSqlCreate(ctx);
    extractSqlAlter(ctx);
    extractSqlDrop(ctx);
    extractSqlIndex(ctx);
    extractSqlRefs(ctx);
    extractSqlReferences(ctx);
  }
  notes.sort((a, b) => a.line - b.line);
  out.notes.push(...notes.map((n) => n.text));
  return out;
}

