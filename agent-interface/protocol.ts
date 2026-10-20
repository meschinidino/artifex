/**
 * Agent-interface transport (T5): JSON-RPC over `POST /agent`.
 * Pure dispatch: the server supplies the launch token, a model
 * factory, and the annotate sink; this module owns envelopes, auth
 * checks, and per-method param validation. Sync throughout — the
 * server's model reads and annotate sink never block.
 */
import { getBuilding, getDbSchema, getPlan, getTrace, listBuildings, prepareNote, type QueryModel } from "./queries.ts";

export const AGENT_API_VERSION = 1;
/** Request-body cap, matching the WebSocket frame cap (64 KiB). */
export const MAX_AGENT_BODY_BYTES = 64 * 1024;

export const AGENT_ERRORS = {
  methodNotFound: -32601,
  invalidParams: -32602,
  badAuth: -32001,
} as const;

export type AnnotateStore = {
  model(): QueryModel;
  /**
   * Persist a prepared (masked, length-checked) note. Returns the
   * event timestamp, or a store-side error (a building path the
   * event validator refuses — e.g. a backslash name — can never
   * be annotated, explicitly).
   */
  annotate(path: string, note: string, agentId: string | undefined): { ts: number } | { error: string };
};

export type AgentResponse = { status: number; body: string };

/**
 * The launch token rides on the store (rather than a separate
 * argument) so the server cannot wire dispatch to one token and
 * bootstrap to another.
 */
export type TokenStore = AnnotateStore & { token: string };

type RpcRequest = { method?: unknown; params?: unknown; id?: unknown };

function envelope(id: unknown, result: unknown): string {
  return JSON.stringify({ v: AGENT_API_VERSION, id: id ?? null, result });
}

function envelopeError(status: number, id: unknown, code: number, message: string): AgentResponse {
  return { status, body: JSON.stringify({ v: AGENT_API_VERSION, id: id ?? null, error: { code, message } }) };
}

function paramsObject(params: unknown): Record<string, unknown> | undefined {
  if (params === undefined) return {};
  if (typeof params === "object" && params !== null && !Array.isArray(params)) {
    return params as Record<string, unknown>;
  }
  return undefined;
}

function nonEmptyString(x: unknown): x is string {
  return typeof x === "string" && x.length > 0;
}

/**
 * Handle one raw request body. authHeader is the literal
 * `Authorization` header value (or null when absent); the token
 * comparison is a plain equality like the WebSocket auth — the
 * threat model is the local user, not a network attacker.
 */
export function handleAgentRequest(store: TokenStore, authHeader: string | null, bodyText: string): AgentResponse {
  if (Buffer.byteLength(bodyText, "utf8") > MAX_AGENT_BODY_BYTES) {
    return envelopeError(413, null, AGENT_ERRORS.invalidParams, "request body too large");
  }
  let req: RpcRequest;
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
    req = parsed as RpcRequest;
  } catch {
    return envelopeError(400, null, AGENT_ERRORS.invalidParams, "request body must be JSON");
  }
  if (authHeader !== `Bearer ${store.token}`) {
    return envelopeError(401, req.id, AGENT_ERRORS.badAuth, "missing or invalid bearer token");
  }
  const params = paramsObject(req.params);
  if (params === undefined) {
    return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, "params must be an object");
  }
  switch (req.method) {
    case "floor.listBuildings":
      return { status: 200, body: envelope(req.id, listBuildings(store.model())) };
    case "floor.getBuilding": {
      if (!nonEmptyString(params.path)) {
        return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, "getBuilding requires a non-empty path");
      }
      const got = getBuilding(store.model(), params.path);
      if ("error" in got) return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, got.error.message);
      return { status: 200, body: envelope(req.id, got.result) };
    }
    case "floor.getTrace": {
      if (!nonEmptyString(params.path)) {
        return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, "getTrace requires a non-empty path");
      }
      const got = getTrace(store.model(), params.path);
      if ("error" in got) return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, got.error.message);
      return { status: 200, body: envelope(req.id, got.result) };
    }
    case "floor.getPlan":
      return { status: 200, body: envelope(req.id, getPlan(store.model())) };
    case "floor.getDbSchema":
      return { status: 200, body: envelope(req.id, getDbSchema(store.model())) };
    case "floor.annotate": {
      if (!nonEmptyString(params.building)) {
        return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, "annotate requires a non-empty building");
      }
      if (typeof params.note !== "string") {
        return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, "annotate requires a note string");
      }
      if (params.agent !== undefined && !nonEmptyString(params.agent)) {
        return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, "annotate agent must be a non-empty string when present");
      }
      const prepared = prepareNote(params.note);
      if ("error" in prepared) return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, prepared.error.message);
      const stored = store.annotate(params.building, prepared.prepared.note, params.agent as string | undefined);
      if ("error" in stored) return envelopeError(200, req.id, AGENT_ERRORS.invalidParams, stored.error);
      return {
        status: 200,
        body: envelope(req.id, { path: params.building, ts: stored.ts, masked: prepared.prepared.masked }),
      };
    }
    default:
      return envelopeError(200, req.id, AGENT_ERRORS.methodNotFound, `unknown method: ${String(req.method)}`);
  }
}
