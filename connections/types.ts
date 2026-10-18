/**
 * Connection facts extracted from one source file (literal-only:
 * every entry cites the line it was proven from; anything dynamic
 * lands in `notes` as visibly unresolved, never as a guessed fact).
 * These types are the shared contract between the extractor, the
 * graph builder, and (summarized) the floor wire.
 */

export type EndpointDef = {
  method: string; // GET/POST/... or ANY
  /** Normalized full path: {param} segments kept as written. */
  path: string;
  handler: string;
  line: number;
};

export type EndpointCall = {
  method: string;
  path: string;
  /** Feign service name as written (path suffix already split off). */
  targetService?: string;
  via: "feign" | "webclient" | "resttemplate" | "fetch" | "http";
  caller: string; // enclosing method name, "" when class-level/unknown
  line: number;
  /** URL built as `variable + "/literal"`: the host is unproven, so graph matching must not use path alone. */
  dynamicBase?: boolean;
  /** Literal absolute http(s) URL: the host is external to the indexed services, so path alone must not join. */
  absoluteUrl?: boolean;
};

export type TableUse = {
  table: string;
  access: "read" | "write" | "readwrite" | "unknown";
  via: "entity" | "native-sql" | "jpql" | "repository" | "sql-string";
  /** explicit = @Table(name=) or a SQL literal; implicit-name = naming-strategy guess from the class name. */
  derived: "explicit" | "implicit-name";
  line: number;
};

export type TopicUse = {
  topic: string;
  direction: "produce" | "consume";
  handler: string;
  line: number;
};

export type MethodCall = { receiver: string; method: string; line: number };

export type MethodInfo = {
  name: string;
  line: number;
  calls: MethodCall[];
  /** Native-SQL tables proven from this method's own @Query. */
  tables: TableUse[];
  /** Entity simple names from this method's JPQL @Query FROM clause. */
  jpqlEntities: string[];
};

export type FileConnections = {
  path: string;
  className?: string;
  /** True when the tracked top-level type is an interface. */
  isInterface?: boolean;
  /** Simple names from extends/implements (Java) or the supertype list (Kotlin). */
  supertypes: string[];
  /** Stereotype kinds seen: controller, service, repository, entity, feign, component, listener… */
  kinds: string[];
  endpoints: EndpointDef[];
  calls: EndpointCall[];
  /** Direct tables only: this file's own entity mapping + native SQL in this file. */
  tables: TableUse[];
  /** Entity simple names bound via JpaRepository<Entity, …> (and siblings). */
  repoEntities: string[];
  entityName?: string;
  entityTable?: TableUse;
  topics: TopicUse[];
  /** field name -> simple declared type name. */
  injections: { field: string; type: string }[];
  methods: MethodInfo[];
  feign?: { targetService: string; basePath: string; absoluteUrl?: boolean };
  /** Visibly-unresolved dynamics (placeholders, template strings). */
  notes: string[];
};

/** Canonical service key for cross-repo matching: case/dot-insensitive, never org-specific. */
export function canonicalService(raw: string): string {
  return raw.trim().toLowerCase().replace(/[\s._]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Endpoint key: METHOD + path with {param} names collapsed, no trailing slash. */
export function endpointKey(method: string, path: string): string {
  const clean = "/" + path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\{[^}]*\}/g, "{}");
  return `${method.toUpperCase()} ${clean === "" ? "/" : clean}`;
}

export function joinPaths(base: string, sub: string): string {
  const b = base.replace(/\/+$/, "");
  const s = sub.replace(/^\/+/, "");
  if (s === "") return b === "" ? "/" : b;
  return `${b}/${s}`;
}
