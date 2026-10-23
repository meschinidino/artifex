/** Estate map render: boxes + thin services + coupling -> DOT -> PNG. */
import { $ } from "bun";
const b = await Bun.file("/tmp/estate-boxes.json").json();
const boxes = b.boxes as any[];

const esc = (s: string) => s.replace(/"/g, "'");
const shortRepo = (r: string) => r.replace("UM.tesoreria.", "t:").replace("UM.haberes.", "h:").replace("-service", "");
const isBig = (x: any) => x.tableCount >= 2 || x.endpointCount >= 10;
const big = boxes.filter(isBig).sort((a, z) => z.endpointCount - a.endpointCount);
const small = boxes.filter((x) => !isBig(x));

// box-to-box coupling via shared endpoints
const epBox = new Map<string, string[]>();
for (const x of boxes) for (const e of x.endpoints) { if (!epBox.has(e)) epBox.set(e, []); epBox.get(e)!.push(x.id); }
const couple = new Map<string, number>();
for (const ids of epBox.values()) { const u = [...new Set(ids)].sort(); for (let i = 0; i < u.length; i++) for (let j = i + 1; j < u.length; j++) { const k = u[i] + "|" + u[j]; couple.set(k, (couple.get(k) ?? 0) + 1); } }

// thin service -> box consumer edges
const svcEdge = new Map<string, number>();
for (const x of boxes) for (const c of x.consumers) { const svc = shortRepo(c.split(":")[0]); const k = svc + ">" + x.id; svcEdge.set(k, (svcEdge.get(k) ?? 0) + 1); }
const svcs = [...new Set([...svcEdge.keys()].map((k) => k.split(">")[0]))].sort();

// trace: chequera-proxy status flow into box-12 (chequera_serie core)
const traceBoxes = new Set(["box-12"]);
const traceSvcs = new Set(["chequera-proxy"]);

let dot = `digraph estate {\nrankdir=LR; splines=true; overlap=false; nodesep=0.6; ranksep=1.2;\nnode [fontname=Helvetica fontsize=11 style=filled];\nedge [fontname=Helvetica fontsize=9];\n`;
dot += `label="tes-um estate: ${boxes.length} boxes, ${b.unboxed.length} unboxed"; labelloc=t; fontsize=16;\n`;
// thin services (left rank)
dot += `{ rank=same; ${svcs.map((s) => `"svc:${s}"`).join(" ")} }\n`;
for (const s of svcs) {
  const hot = traceSvcs.has(s);
  dot += `"svc:${s}" [label="${s}" shape=box fillcolor="${hot ? "#ff6b6b" : "#cfe8ff"}"];\n`;
}
// big boxes
for (const x of big) {
  const hot = traceBoxes.has(x.id);
  const fs = 10 + Math.min(10, Math.round(x.endpointCount / 15));
  dot += `"${x.id}" [label="${x.id}\\n${esc(x.name)}\\n${x.tableCount}t ${x.endpointCount}e${x.seeded.length ? " *" : ""}" shape=box3d fillcolor="${hot ? "#ff6b6b" : "#ffe8a3"}" fontsize=${fs}];\n`;
}
// small boxes shelf
dot += `subgraph cluster_shelf {\nlabel="reference + read models (${small.length})"; style=dotted;\n`;
for (const x of small) dot += `"${x.id}" [label="${esc(x.name)}\\n${x.tableCount}t ${x.endpointCount}e" fillcolor="#e8e8e8" fontsize=9];\n`;
dot += `}\n`;
// unboxed note
dot += `"unboxed" [label="unboxed (${b.unboxed.length})\\n${b.unboxed.slice(0, 8).join(" ")}${b.unboxed.length > 8 ? "..." : ""}" shape=note fillcolor="#ffd0d0"];\n`;
// consumer edges
for (const [k, n] of [...svcEdge.entries()].sort()) {
  const [s, id] = k.split(">");
  const hot = traceSvcs.has(s) && traceBoxes.has(id);
  dot += `"svc:${s}" -> "${id}" [label="${n}" color="${hot ? "red" : "#888888"}" penwidth=${hot ? 3 : Math.min(3, 1 + n / 10)}];\n`;
}
// coupling edges (shared endpoints), only between big boxes, top 25 at >=8 shared
let drawn = 0;
for (const [k, n] of [...couple.entries()].sort((a, z) => z[1] - a[1])) {
  if (n < 8 || drawn >= 25) continue;
  const [a, c] = k.split("|");
  if (!big.some((x) => x.id === a) || !big.some((x) => x.id === c)) continue;
  dot += `"${a}" -> "${c}" [label="${n} shared" style=dashed color="#44aa44" dir=none];\n`;
  drawn++;
}
dot += `}\n`;
await Bun.write("/tmp/estate-map.dot", dot);
await $`dot -Tpng /tmp/estate-map.dot -o /tmp/estate-map.png -Gdpi=110`.quiet();
const png = Bun.file("/tmp/estate-map.png");
console.log(`png bytes=${png.size} big=${big.length} small=${small.length} svcs=${svcs.join(",")}`);
console.log(`consumer edges=${svcEdge.size} coupling edges>=3: ${[...couple.values()].filter((n) => n >= 3).length}`);
for (const [k, n] of [...couple.entries()].sort((a, z) => z[1] - a[1]).slice(0, 10)) console.log("couple", k, n);
