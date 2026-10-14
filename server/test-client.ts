/** Shared WebSocket test client for floor server integration tests. */
import type { Building, ServerMessage, SnapshotMessage } from "../floor-ui/wire.ts";
import type { FloorServer } from "./index.ts";

export type Client = {
  ws: WebSocket;
  messages: ServerMessage[];
  waitFor: (
    pred: (m: ServerMessage) => boolean,
    label: string,
    timeoutMs?: number,
    fromIndex?: number,
  ) => Promise<ServerMessage>;
  send: (msg: unknown) => void;
};

const sockets: WebSocket[] = [];

export function closeAllClients() {
  for (const ws of sockets) try { ws.close(); } catch { /* already closed */ }
  sockets.length = 0;
}

export function connectClient(port: number): Promise<Client> {
  return new Promise((resolveClient, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    sockets.push(ws);
    const messages: ServerMessage[] = [];
    const waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void }[] = [];
    // fromIndex scopes the history scan to messages received after
    // the caller recorded client.messages.length: without it, a
    // negative predicate ("patch without edge X") matches a stale
    // earlier patch and the test passes without testing anything.
    const waitFor: Client["waitFor"] = (pred, label, timeoutMs = 5_000, fromIndex = 0) =>
      new Promise((resolveWait, rejectWait) => {
        const found = messages.slice(fromIndex).find(pred);
        if (found) return resolveWait(found);
        const timer = setTimeout(() => rejectWait(new Error(`timed out waiting for ${label}; got: ${messages.map((m) => m.type).join(",")}`)), timeoutMs);
        waiters.push({ pred, resolve: (m) => { clearTimeout(timer); resolveWait(m); } });
      });
    ws.onmessage = (event) => {
      const msg = JSON.parse(String(event.data)) as ServerMessage;
      messages.push(msg);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i]!.pred(msg)) {
          waiters[i]!.resolve(msg);
          waiters.splice(i, 1);
        }
      }
    };
    ws.onopen = () => resolveClient({ ws, messages, waitFor, send: (msg) => ws.send(JSON.stringify(msg)) });
    ws.onerror = () => reject(new Error("websocket error"));
  });
}

export async function authedClient(f: FloorServer): Promise<{ client: Client; snapshot: SnapshotMessage }> {
  const client = await connectClient(f.port);
  client.send({ v: 1, type: "auth", token: f.token });
  const snapshot = (await client.waitFor((m) => m.type === "snapshot", "snapshot")) as SnapshotMessage;
  return { client, snapshot };
}

export const byPath = (buildings: Building[]) => new Map(buildings.map((b) => [b.path, b]));
