// Emit frozen frontend calls + match owners for the estate floor (probe).
// match.kind: exact | literal-param | backend-literal; to: backend owner.
// intent: implied backend repo for unmatched calls (prefix-derived, else null).
import { execSync } from "node:child_process";

const estate = await Bun.file("/Users/dinomeschini/Documents/artifex/.artifex/estate/estate.json").json();
const fe = await Bun.file("/tmp/fe-calls.json").json();
const norm = (p: string) => p.replace(/\{[^}]*\}/g, "{}").replace(/\/+/g, "/");
const noSlash = (p: string) => (p.endsWith("/") && p.length > 1 ? p.slice(0, -1) : p);
const deLiteral = (p: string) => p.split("/").map((s) => (/^(true|false|\d+)$/.test(s) ? "{}" : s)).join("/");

type Ep = { method: string; path: string; repo: string; file: string };
const endpoints: Ep[] = [];
const exact = new Map<string, Ep[]>();
for (const [k, v] of Object.entries<any>(estate.byFile)) {
  const [repo, file] = (k as string).split("\0");
  for (const ep of v.endpoints || []) {
    const e = { method: ep.method, path: noSlash(norm(ep.path)), repo: repo as string, file: file as string };
    endpoints.push(e);
    const key = `${e.method} ${e.path}`;
    if (!exact.has(key)) exact.set(key, []);
    exact.get(key)!.push(e);
  }
}
const compat = (a: string, b: string) => {
  const sa = a.split("/"), sb = b.split("/");
  if (sa.length !== sb.length) return false;
  return sa.every((x, i) => x === sb[i] || (x === "{}") !== (sb[i] === "{}"));
};
// Implied repo from gateway prefix: /api/<seg...>/<svc> -> UM repo. Null when unparseable.
function intentRepo(p: string): string | null {
  const m = p.match(/^\/api\/([a-z]+)\/([a-z]+)(\/.*)?$/);
  if (!m) return null;
  if (m[1] === "haberes") {
    const svc = { core: "core-service", etec: "etec-service", report: "report-service" }[m[2]!];
    return svc ? `UM.haberes.${svc}` : null;
  }
  if (m[1] === "afipws") return "UM.tesoreria.pyafipws-service";
  if (m[1] === "chequera") return "UM.tesoreria.chequera-proxy";
  if (m[1] !== "tesoreria") return null;
  const svc = { core: "core-service", report: "report-service", facturador: "facturador-service", sender: "sender-service", mercadopago: "mercadopago-service", guarani: "guarani-service", umhub: "umhub-service", compras: "compras-service", aura: null }[m[2]!];
  return svc === undefined ? null : svc === null ? null : `UM.tesoreria.${svc}`;
}

// Lib -> owning app: single-consumer libs attribute to that app, multi-app
// libs stay shared. From: grep -rho "@tesoreria/[a-z-]*" apps/*/src.
// Apps without direct calls (chequeras, contable, contratados) get no
// machine — their reachability flows through shared libs.
const LIB_APP: Record<string, string> = {
  "feature-administrador": "administrador",
  "feature-permisos": "administrador",
  "feature-pedido-compra": "compras",
  "feature-guarani": "guarani",
  "feature-externo-consulta": "externo-consulta",
};
const out: any[] = [];
for (const c of fe.calls) {
  const appM = c.file.match(/^apps\/([^/]+)\//);
  const libM = c.file.match(/^libs\/([^/]+)\//);
  const app = appM ? appM[1]! : libM && LIB_APP[libM[1]!] ? LIB_APP[libM[1]!]! : "shared";
  const p = noSlash(norm(c.path));
  const rec: any = { method: c.method, path: c.path, file: c.file, line: c.line, app, match: null, intent: null };
  const hit = exact.get(`${c.method} ${p}`) || exact.get(`${c.method} ${noSlash(p)}`);
  if (hit?.length) {
    const o = hit[0]!;
    rec.match = { kind: "exact", repo: o.repo, file: o.file };
  } else {
    const dl = deLiteral(p);
    const lit = dl !== p ? exact.get(`${c.method} ${dl}`) || exact.get(`${c.method} ${noSlash(dl)}`) : undefined;
    if (lit?.length) rec.match = { kind: "literal-param", repo: lit[0]!.repo, file: lit[0]!.file };
    else {
      const found = endpoints.filter((e) => e.method === c.method && (compat(p, e.path) || compat(p, noSlash(e.path))));
      if (found.length) rec.match = { kind: "backend-literal", repo: found[0]!.repo, file: found[0]!.file };
      else rec.intent = intentRepo(p);
    }
  }
  out.push(rec);
}
const sha = execSync("git -C /Users/dinomeschini/Documents/tes-um/UM.tesoreria.frontend-client rev-parse --short HEAD").toString().trim();
await Bun.write("/Users/dinomeschini/Documents/artifex/.artifex/estate/frontend-calls.json", JSON.stringify({
  repo: "UM.tesoreria.frontend-client",
  commit: sha,
  extracted: new Date().toISOString().slice(0, 10),
  calls: out,
}, null, 1));
const kinds: Record<string, number> = {};
for (const c of out) kinds[c.match ? c.match.kind : "unmatched"] = (kinds[c.match ? c.match.kind : "unmatched"] || 0) + 1;
console.log(`emitted ${out.length} calls commit=${sha}`, JSON.stringify(kinds));
console.log("unmatched without intent:", out.filter((c) => !c.match && !c.intent).length);
