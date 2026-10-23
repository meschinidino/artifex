/**
 * Estate floor server: serves the frozen D mapping (boxes as machines,
 * call flows as belts) over the same wire protocol as the repo floor.
 * Static: one snapshot, no watcher/parser/agent. File ops answer the
 * matching honest error; dispatch answers a read-only notice.
 *
 *   bun run server/estate.ts --estate-dir .artifex/estate --port 4531
 */
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { buildEstateFloor, parseGatewayRoutes, type BoxesJson, type EstateFloor, type EstateJson, type EstateStats, type FrontendJson, type GatewayRoute } from "./estate-build.ts";
import { WIRE_VERSION, type ErrorCode, type ServerMessage, type SnapshotMessage } from "../floor-ui/wire.ts";

export const ESTATE_REPO_PREFIX = "estate:";
export const ESTATE_NAME = "tes-um";

const MAX_SOCKETS = 64;
const AUTH_TIMEOUT_MS = 5_000;

type SocketData = { authed: boolean };

/** Loopback Host check, unit-testable (mirrors server/index.ts). */
export function hostAllowedFor(hostHeader: string | null, port: string): boolean {
  if (!hostHeader) return false;
  return hostHeader === `127.0.0.1:${port}` || hostHeader === `localhost:${port}`;
}

/** Same-origin check, unit-testable (mirrors server/index.ts). */
export function originAllowedFor(origin: string | null, port: string): boolean {
  if (!origin) return true;
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/** The one static snapshot: stateVersion 1, no patches ever follow. */
export function estateSnapshot(floor: EstateFloor): SnapshotMessage {
  return {
    v: WIRE_VERSION,
    type: "snapshot",
    stateVersion: 1,
    repo: `${ESTATE_REPO_PREFIX}${ESTATE_NAME}`,
    zones: floor.zones,
    buildings: floor.buildings,
    belts: floor.belts,
    total: floor.buildings.length,
    watcher: "watching",
    ghosts: [],
    agent: { agentId: "estate", state: "idle" },
    runs: [],
    notes: [],
    removed: [],
    removedUnplotted: [],
    footAvailable: [],
    hasLessonsSection: true,
  };
}

export async function loadEstateDir(dir: string): Promise<{ estate: EstateJson; boxes: BoxesJson; gatewayRoutes: GatewayRoute[]; frontend?: FrontendJson }> {
  const read = async (name: string): Promise<unknown> => {
    try {
      return await Bun.file(join(dir, name)).json();
    } catch {
      throw new Error(`${name}: missing or invalid JSON in ${dir}`);
    }
  };
  const [estate, boxes] = await Promise.all([read("estate.json"), read("estate-boxes.json")]);
  // The gateway route table decides which endpoints face frontends.
  // Absent it every endpoint would read internal — fail instead.
  let gatewayRoutes: GatewayRoute[];
  try {
    gatewayRoutes = parseGatewayRoutes(await Bun.file(join(dir, "gateway-bootstrap.yml")).text());
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    if (why.includes("no routes")) throw new Error(`gateway-bootstrap.yml: no routes in ${dir} (refusing to mark every endpoint internal)`);
    throw new Error(`gateway-bootstrap.yml: missing in ${dir} (copy the gateway's bootstrap YAML next to estate.json)`);
  }
  // Frontend calls are an additive layer: older snapshots boot without.
  let frontend: FrontendJson | undefined;
  try {
    frontend = (await Bun.file(join(dir, "frontend-calls.json")).json()) as FrontendJson;
  } catch {
    frontend = undefined;
  }
  return { estate: estate as EstateJson, boxes: boxes as BoxesJson, gatewayRoutes, frontend };
}

function send(ws: ServerWebSocket<SocketData>, msg: ServerMessage): void {
  try {
    ws.send(JSON.stringify(msg));
  } catch {
    /* socket already gone */
  }
}

function err(ws: ServerWebSocket<SocketData>, code: ErrorCode, message: string): void {
  send(ws, { v: WIRE_VERSION, type: "error", code, message });
}

export type EstateServer = {
  port: number;
  url: string;
  token: string;
  stats: EstateStats;
  stop: () => void;
};

export async function createEstateServer(opts: { estateDir: string; port?: number }): Promise<EstateServer> {
  const dir = resolve(opts.estateDir);
  const uiDir = join(import.meta.dir, "..", "floor-ui");
  const [htmlTemplate, css] = await Promise.all([
    Bun.file(join(uiDir, "index.html")).text(),
    Bun.file(join(uiDir, "styles.css")).text(),
  ]);
  const bundleProc = Bun.spawnSync([process.execPath, "build", join(uiDir, "app.ts"), "--target", "browser"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (bundleProc.exitCode !== 0) {
    throw new Error(`floor-ui bundle failed: ${bundleProc.stderr.toString().trim().slice(0, 400)}`);
  }
  const appJs = bundleProc.stdout.toString();
  const token = randomUUID();
  const html = htmlTemplate.replace("%ARTIFEX_TOKEN%", token);
  try {
    const tokenFile = join(dir, "agent-token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    chmodSync(tokenFile, 0o600);
  } catch {
    console.error("warn: could not write agent-token next to the estate data; agent bootstrap via file is unavailable");
  }

  // Fail fast on bad data: a half-built floor must never serve.
  const { estate, boxes, gatewayRoutes, frontend } = await loadEstateDir(dir);
  const floor = buildEstateFloor(estate, boxes, gatewayRoutes, frontend);
  const snapshot = estateSnapshot(floor);

  const sockets = new Set<ServerWebSocket<SocketData>>();
  const authTimers = new Map<ServerWebSocket<SocketData>, ReturnType<typeof setTimeout>>();
  const READONLY = "estate floor is read-only: machines are boxes, not files";

  function handleMessage(ws: ServerWebSocket<SocketData>, raw: string): void {
    let msg: { v?: unknown; type?: unknown; token?: unknown };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      err(ws, "bad-message", "message is not JSON");
      return;
    }
    if (msg.v !== WIRE_VERSION || typeof msg.type !== "string") {
      err(ws, "bad-message", "message needs v: 1 and a string type");
      return;
    }
    if (msg.type === "auth") {
      if (msg.token === token) {
        ws.data.authed = true;
        const timer = authTimers.get(ws);
        if (timer !== undefined) {
          clearTimeout(timer);
          authTimers.delete(ws);
        }
        send(ws, { v: WIRE_VERSION, type: "auth-ok", stateVersion: snapshot.stateVersion });
        send(ws, snapshot);
      } else {
        err(ws, "bad-auth", "wrong token");
      }
      return;
    }
    if (!ws.data.authed) {
      err(ws, "bad-auth", "authenticate first");
      return;
    }
    switch (msg.type) {
      case "resync":
      case "relayout":
        send(ws, snapshot);
        return;
      case "open-file":
      case "get-diff":
      case "export-trace":
        err(ws, "bad-path", READONLY);
        return;
      case "get-lines":
        err(ws, "lines-failed", READONLY);
        return;
      case "get-summary":
        err(ws, "summary-failed", READONLY);
        return;
      case "get-phrases":
        err(ws, "phrases-failed", READONLY);
        return;
      case "dispatch":
      case "stop-agent":
      case "writeback":
        send(ws, { v: WIRE_VERSION, type: "notice", text: "estate floor has no agent" });
        return;
      default:
        err(ws, "bad-message", `unknown message type: ${msg.type}`);
    }
  }

  const isolation = {
    "cross-origin-opener-policy": "same-origin",
    "cross-origin-embedder-policy": "require-corp",
    "content-security-policy": "frame-ancestors 'none'",
    "x-frame-options": "DENY",
  };
  const server = Bun.serve<SocketData>({
    hostname: "127.0.0.1",
    port: opts.port ?? 4531,
    async fetch(req, srv) {
      if (!hostAllowedFor(req.headers.get("host"), new URL(req.url).port)) {
        return new Response("forbidden host", { status: 403 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/ws") {
        if (!originAllowedFor(req.headers.get("origin"), url.port)) return new Response("forbidden origin", { status: 403 });
        if (srv.upgrade(req, { data: { authed: false } })) return undefined;
        return new Response("websocket upgrade failed", { status: 400 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...isolation } });
      }
      if (url.pathname === "/app.js") {
        return new Response(appJs, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store", ...isolation } });
      }
      if (url.pathname === "/styles.css") {
        return new Response(css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "no-store", ...isolation } });
      }
      return new Response("not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: 64 * 1024,
      open(ws) {
        if (sockets.size >= MAX_SOCKETS) {
          ws.close(4002, "too many connections");
          return;
        }
        sockets.add(ws);
        const timer = setTimeout(() => {
          try {
            if (!ws.data.authed) ws.close(4001, "auth timeout");
          } catch {
            /* socket already gone */
          }
        }, AUTH_TIMEOUT_MS);
        if (typeof timer === "object") timer.unref?.();
        authTimers.set(ws, timer);
      },
      message(ws, message) {
        handleMessage(ws, message as string);
      },
      close(ws) {
        sockets.delete(ws);
        const timer = authTimers.get(ws);
        if (timer !== undefined) {
          clearTimeout(timer);
          authTimers.delete(ws);
        }
      },
    },
  });
  if (server.port === undefined) {
    server.stop(true);
    throw new Error("server did not bind a TCP port");
  }
  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}/`,
    token,
    stats: floor.stats,
    stop: () => {
      for (const timer of authTimers.values()) clearTimeout(timer);
      authTimers.clear();
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const estateDir = flag("--estate-dir") ?? join(process.cwd(), ".artifex", "estate");
  const port = Number(flag("--port") ?? "4531");
  createEstateServer({ estateDir, port })
    .then((floor) => {
      const shutdown = () => {
        floor.stop();
        process.exit(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
      console.log(`artifex estate floor at ${floor.url} (${JSON.stringify(floor.stats)})`);
    })
    .catch((e: unknown) => {
      console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    });
}
