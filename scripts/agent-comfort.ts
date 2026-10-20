/**
 * Agent comfort trial (T5 verify): drives the agent interface over
 * HTTP only — what exists, what is planned, what changed, plus an
 * annotate round-trip and the negative probes. No screen-scraping,
 * no bespoke client: the same curl-able calls an agent would make.
 *
 * Usage: bun run scripts/agent-comfort.ts --repo <floor-root> --port <port>
 * Exit 0 only when every step passes; otherwise non-zero naming the
 * first failure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

type RpcBody = { v: number; id: unknown; result?: any; error?: { code: number; message: string } };

const steps: { name: string; ok: boolean; detail: string }[] = [];
let failed = false;

function report(name: string, ok: boolean, detail: string): void {
  steps.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"}  ${name} — ${detail}`);
  if (!ok) failed = true;
}

function args(): { repo: string; port: number } {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const repo = flag("--repo");
  const port = Number(flag("--port") ?? NaN);
  if (!repo || !Number.isInteger(port) || port <= 0) {
    console.error("usage: bun run scripts/agent-comfort.ts --repo <floor-root> --port <port>");
    process.exit(2);
  }
  return { repo, port };
}

async function main(): Promise<void> {
  const { repo, port } = args();
  const url = `http://127.0.0.1:${port}/agent`;
  let token: string;
  try {
    token = readFileSync(join(repo, ".artifex", "agent-token"), "utf8").trim();
  } catch {
    report("bootstrap", false, "could not read .artifex/agent-token (is the floor running with this root?)");
    process.exit(1);
  }
  if (token.length === 0) {
    report("bootstrap", false, "token file is empty");
    process.exit(1);
  }
  report("bootstrap", true, "token file read (length hidden)");

  let id = 0;
  const call = async (method: string, params: unknown = {}): Promise<{ status: number; json: RpcBody }> => {
    id += 1;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ method, params, id }),
    });
    return { status: res.status, json: (await res.json()) as RpcBody };
  };

  // What exists.
  const list = await call("floor.listBuildings");
  const buildings = list.json.result?.buildings as { path: string }[] | undefined;
  if (list.status !== 200 || !Array.isArray(buildings)) {
    report("listBuildings", false, `status=${list.status} body=${JSON.stringify(list.json).slice(0, 200)}`);
    process.exit(1);
  }
  report("listBuildings", true, `total=${list.json.result.total}`);
  if (buildings.length === 0) {
    report("getBuilding", false, "floor is empty; nothing to inspect");
    process.exit(1);
  }
  const first = buildings[0]!.path;

  // What is planned.
  const plan = await call("floor.getPlan");
  const agentState = plan.json.result?.agent?.state;
  if (plan.status !== 200 || typeof agentState !== "string") {
    report("getPlan", false, `status=${plan.status}`);
    process.exit(1);
  }
  report("getPlan", true, `worker=${plan.json.result.agent.agentId}/${agentState} ghosts=${plan.json.result.ghosts?.length ?? "?"}`);

  // What changed + test state for one building.
  const detail = await call("floor.getBuilding", { path: first });
  const testState = detail.json.result?.testState?.status;
  if (detail.status !== 200 || typeof testState !== "string") {
    report("getBuilding", false, `status=${detail.status}`);
    process.exit(1);
  }
  report(
    "getBuilding",
    true,
    `${first}: imports=${detail.json.result.imports?.length ?? "?"} dependents=${detail.json.result.dependents?.length ?? "?"} changes=${detail.json.result.recentChanges?.length ?? "?"} test=${testState}`,
  );

  // Annotate + read-back, with a secret that must come back masked.
  const secret = `trial-${Date.now()}`;
  const noted = await call("floor.annotate", {
    building: first,
    note: `comfort trial why\nconst TRIAL_TOKEN = "${secret}"`,
    agent: "comfort-trial",
  });
  if (noted.status !== 200 || noted.json.result?.masked !== true) {
    report("annotate", false, `status=${noted.status} body=${JSON.stringify(noted.json).slice(0, 200)}`);
    process.exit(1);
  }
  const reread = await call("floor.getBuilding", { path: first });
  const notes = reread.json.result?.notes as { note: string }[] | undefined;
  const found = notes?.some((n) => n.note.includes("comfort trial why")) ?? false;
  const leaked = notes?.some((n) => n.note.includes(secret)) ?? true;
  if (!found || leaked) {
    report("annotate", false, `read-back found=${found} leaked=${leaked}`);
    process.exit(1);
  }
  report("annotate", true, "note stored masked and read back");

  // Reachability.
  const schema = await call("floor.getDbSchema");
  if (schema.status !== 200 || !Array.isArray(schema.json.result?.tables)) {
    report("getDbSchema", false, `status=${schema.status}`);
    process.exit(1);
  }
  report(
    "getDbSchema",
    true,
    `tables=${schema.json.result.tables.length} endpoints=${schema.json.result.endpoints.length} zone=${schema.json.result.schemaZoneBuilt}`,
  );

  // Structural trace export: anchored markdown, byte-identical on
  // repeat, carrying neither the note above nor its secret.
  const trace1 = await call("floor.getTrace", { path: first });
  const md1 = trace1.json.result?.markdown as string | undefined;
  if (trace1.status !== 200 || trace1.json.result?.path !== first || typeof md1 !== "string" || !md1.startsWith(`# trace: ${first}\n`)) {
    report("getTrace", false, `status=${trace1.status} body=${JSON.stringify(trace1.json).slice(0, 200)}`);
    process.exit(1);
  }
  const trace2 = await call("floor.getTrace", { path: first });
  if ((trace2.json.result?.markdown as string | undefined) !== md1) {
    report("getTrace", false, "second call differed (nondeterministic output)");
    process.exit(1);
  }
  if (md1.includes(secret) || md1.includes("comfort trial why")) {
    report("getTrace", false, "note text leaked into the structural export");
    process.exit(1);
  }
  if (!md1.includes("## imports (") || !md1.includes("## imported by (")) {
    report("getTrace", false, "export is missing its import sections");
    process.exit(1);
  }
  report("getTrace", true, `${first}: ${md1.length} chars, deterministic, note-free`);

  // Negative probes: unknown building, empty note, forged token.
  const unknown = await call("floor.getBuilding", { path: "src/does-not-exist-xyz.ts" });
  report(
    "negative:unknown-building",
    unknown.json.error?.code === -32602,
    unknown.json.error?.message ?? `status=${unknown.status}`,
  );
  const unknownTrace = await call("floor.getTrace", { path: "src/does-not-exist-xyz.ts" });
  report(
    "negative:unknown-trace",
    unknownTrace.json.error?.code === -32602,
    unknownTrace.json.error?.message ?? `status=${unknownTrace.status}`,
  );
  const empty = await call("floor.annotate", { building: first, note: "   " });
  report("negative:empty-note", empty.json.error?.code === -32602, empty.json.error?.message ?? `status=${empty.status}`);
  const forged = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer forged" },
    body: JSON.stringify({ method: "floor.listBuildings", params: {}, id: 999 }),
  });
  report("negative:forged-token", forged.status === 401, `status=${forged.status}`);

  if (failed) process.exit(1);
  console.log(`comfort trial: ${steps.length}/${steps.length} steps passed`);
}

await main();
