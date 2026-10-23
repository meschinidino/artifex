/** Estate table clustering probe: endpoint co-occurrence -> capability boxes. */
const e = await Bun.file("/tmp/estate.json").json();

type Ep = { id: string; repo: string; file: string; method: string; path: string; tables: Map<string, string> };
const endpoints: Ep[] = [];
for (const [k, v] of Object.entries<any>(e.byFile)) {
  const [, file] = (k as string).split("\0");
  for (const ep of v.endpoints ?? []) {
    const tables = new Map<string, string>();
    for (const t of ep.tables ?? []) tables.set(t.table, t.access);
    endpoints.push({ id: `${v.repo}:${file}:${ep.method} ${ep.path}`, repo: v.repo, file, method: ep.method, path: ep.path, tables });
  }
}
// table -> endpoint idx set
const t2e = new Map<string, Set<number>>();
endpoints.forEach((ep, i) => { for (const t of ep.tables.keys()) { if (!t2e.has(t)) t2e.set(t, new Set()); t2e.get(t)!.add(i); } });
console.log(`endpoints=${endpoints.length} tables=${t2e.size}`);
// table -> files (skip facade files touching >6 tables)
const fileTables = new Map<string, Set<string>>();
for (const ep of endpoints) { const k = `${ep.repo}:${ep.file}`; if (!fileTables.has(k)) fileTables.set(k, new Set()); for (const t of ep.tables.keys()) fileTables.get(k)!.add(t); }
const t2f = new Map<string, Set<string>>();
for (const ep of endpoints) { const k = `${ep.repo}:${ep.file}`; if (fileTables.get(k)!.size > 6) continue; for (const t of ep.tables.keys()) { if (!t2f.has(t)) t2f.set(t, new Set()); t2f.get(t)!.add(k); } }
const seeded = new Map<string, string>(); // table -> heuristic reason

// Two-phase: tight cosine cores (no chaining), then satellite attach (no box-box merge).
type Cluster = Set<string>;
let clusters: Cluster[] = [...t2e.keys()].map((t) => new Set([t]));
const epsOf = (c: Cluster): Set<number> => { const s = new Set<number>(); for (const t of c) for (const i of t2e.get(t)!) s.add(i); return s; };
const cosine = <T,>(a: Set<T>, b: Set<T>): [number, number] => { let inter = 0; for (const i of a) if (b.has(i)) inter++; return [a.size && b.size ? inter / Math.sqrt(a.size * b.size) : 0, inter]; };
const CORE_TH = 0.5;
// Phase 0: file cores (same-controller siblings).
{
  const fOf = (c: Cluster): Set<string> => { const s = new Set<string>(); for (const t of c) for (const f of t2f.get(t) ?? []) s.add(f); return s; };
  for (;;) {
    let best: { sim: number; a: number; b: number; k: string } | null = null;
    const fs = clusters.map(fOf);
    for (let a = 0; a < clusters.length; a++) for (let b = a + 1; b < clusters.length; b++) {
      const [sim, inter] = cosine(fs[a]!, fs[b]!);
      if (inter < 2 || sim < 0.5) continue;
      const k = [...clusters[a]!].sort()[0]! + [...clusters[b]!].sort()[0]!;
      if (!best || sim > best.sim || (sim === best.sim && k < best.k)) best = { sim, a, b, k };
    }
    if (!best) break;
    for (const t of clusters[best.b]!) clusters[best.a]!.add(t);
    clusters.splice(best.b, 1);
  }
}
for (;;) {
  let best: { sim: number; a: number; b: number; k: string } | null = null;
  const eps = clusters.map(epsOf);
  for (let a = 0; a < clusters.length; a++) for (let b = a + 1; b < clusters.length; b++) {
    const [sim, inter] = cosine(eps[a]!, eps[b]!);
    if (inter < 2 || sim < CORE_TH) continue;
    const k = [...clusters[a]!].sort()[0]! + [...clusters[b]!].sort()[0]!;
    if (!best || sim > best.sim || (sim === best.sim && k < best.k)) best = { sim, a, b, k };
  }
  if (!best) break;
  for (const t of clusters[best.b]!) clusters[best.a]!.add(t);
  clusters.splice(best.b, 1);
}
// Satellite attach: singleton/small cluster joins the box holding most of its
// endpoints if >=50% overlap AND cosine>=0.3. Boxes never merge here.
const SAT_COS = 0.3;
{
  const isBox = clusters.map((c) => c.size > 1);
  const boxEps = clusters.map(epsOf);
  const attachTo = new Map<number, number>();
  clusters.forEach((c, i) => {
    if (isBox[i]) return;
    const mine = boxEps[i]!;
    if (mine.size >= 40) return; // hub tables anchor their own box
    let bt = -1, bshare = 0;
    for (let j = 0; j < clusters.length; j++) {
      if (!isBox[j]) continue;
      let inter = 0; for (const x of mine) if (boxEps[j]!.has(x)) inter++;
      const share = mine.size ? inter / mine.size : 0;
      const [cos] = cosine(mine, boxEps[j]!);
      if (share >= 0.5 && cos >= SAT_COS && share > bshare) { bshare = share; bt = j; }
    }
    if (bt >= 0) attachTo.set(i, bt);
  });
  for (const [from, to] of [...attachTo.entries()].sort((x, y) => y[0] - x[0])) {
    for (const t of clusters[from]!) clusters[to]!.add(t);
    clusters.splice(from, 1);
  }
}
// View collapse: singleton vw_* attaches via file siblings, else name tokens.
{
  const toks = (s: string) => s.replace(/^vw_/, "").split(/_/).filter((w) => w.length > 2 && !["key", "the", "search", "full"].includes(w));
  const boxEps = clusters.map(epsOf);
  const fOf = (c: Cluster): Set<string> => { const s = new Set<string>(); for (const t of c) for (const f of t2f.get(t) ?? []) s.add(f); return s; };
  const boxFiles = clusters.map(fOf);
  const isBox = clusters.map((c) => c.size > 1 || epsOf(c).size >= 2);
  const attachTo = new Map<number, { to: number; why: string }>();
  clusters.forEach((c, i) => {
    if (c.size !== 1) return;
    const t = [...c][0]!;
    if (!t.startsWith("vw_") || isBox[i]) return;
    const mine = boxEps[i]!;
    const myFiles = boxFiles[i]!;
    let bt = -1, bscore = 0, why = "";
    for (let j = 0; j < clusters.length; j++) {
      if (j === i || !isBox[j]) continue;
      let einter = 0; for (const x of mine) if (boxEps[j]!.has(x)) einter++;
      if (mine.size && einter / mine.size < 0.5) continue;
      let finter = 0; for (const f of myFiles) if (boxFiles[j]!.has(f)) finter++;
      if (finter > bscore) { bscore = finter; bt = j; why = "file-sibling"; }
    }
    if (bt < 0) { // name-token fallback
      const vt = new Set(toks(t));
      for (let j = 0; j < clusters.length; j++) {
        if (j === i || !isBox[j]) continue;
        const btoks = new Set([...clusters[j]!].flatMap(toks));
        let ov = 0; for (const w of vt) if (btoks.has(w)) ov++;
        if (ov > bscore) { bscore = ov; bt = j; why = "name-seed"; }
      }
    }
    if (bt >= 0 && bscore > 0) attachTo.set(i, { to: bt, why });
  });
  for (const [from, a] of [...attachTo.entries()].sort((x, y) => y[0] - x[0])) {
    for (const t of clusters[from]!) { clusters[a.to]!.add(t); seeded.set(t, a.why); }
    clusters.splice(from, 1);
  }
}
const TH = CORE_TH;

// Split thin singletons -> unboxed; stable box ids by first table name.
clusters.sort((x, y) => [...x].sort()[0]!.localeCompare([...y].sort()[0]!));
const boxes: any[] = []; const unboxed: string[] = [];
let n = 0;
clusters.forEach((c) => {
  const tables = [...c].sort();
  const eps = epsOf(c);
  if (c.size === 1 && eps.size < 2) { unboxed.push(tables[0]!); return; }
  n++;
  // name = table with max internal co-occurrence
  let name = tables[0]!; let nameScore = -1;
  for (const t of tables) { let s = 0; for (const j of t2e.get(t)!) { const ep = endpoints[j]!; for (const u of ep.tables.keys()) if (c.has(u) && u !== t) s++; } if (s > nameScore) { nameScore = s; name = t; } }
  const files = new Set<string>(); const repos = new Set<string>(); const writes = new Set<string>();
  for (const j of eps) { const ep = endpoints[j]!; files.add(`${ep.repo}:${ep.file}`); repos.add(ep.repo); for (const [t, a] of ep.tables) if (c.has(t) && (a === "write" || a === "readwrite")) writes.add(t); }
  boxes.push({ id: `box-${String(n).padStart(2, "0")}`, name, tables, tableCount: tables.length, endpointCount: eps.size, fileCount: files.size, repos: [...repos].sort(), writes: [...writes].sort(), seeded: tables.filter((t) => seeded.has(t)).map((t) => `${t}:${seeded.get(t)}`), endpoints: [...eps].map((j) => endpoints[j]!.id).sort(), files: [...files].sort() });
});

// Thin-service consumers: non-core/guarani files reaching box tables via calls.
const coreRepos = new Set(["UM.tesoreria.core-service", "UM.tesoreria.guarani-service"]);
const t2box = new Map<string, string>(); for (const b of boxes) for (const t of b.tables) t2box.set(t, b.id);
const consumers = new Map<string, Set<string>>();
for (const [k, v] of Object.entries<any>(e.byFile)) {
  if (coreRepos.has(v.repo)) continue;
  for (const t of v.tables ?? []) { const b = t2box.get(t.table); if (b) { if (!consumers.has(b)) consumers.set(b, new Set()); consumers.get(b)!.add(`${v.repo}:${(k as string).split("\0")[1]}:${t.via}`); } }
}
for (const b of boxes) b.consumers = [...(consumers.get(b.id) ?? [])].sort();

await Bun.write("/tmp/estate-boxes.json", JSON.stringify({ boxes, unboxed, threshold: TH }, null, 1));
console.log(`boxes=${boxes.length} unboxed=${unboxed.length}`);
for (const b of boxes) console.log(`${b.id} ${b.name} tables=${b.tableCount} eps=${b.endpointCount} files=${b.fileCount} consumers=${b.consumers.length} repos=${b.repos.map((r: string) => r.replace("UM.tesoreria.", "")).join(",")}`);
console.log("UNBOXED:", unboxed.join(" "));
