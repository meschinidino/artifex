/**
 * Shared floor-event contract (eng review D8). Single source of truth:
 * every Artifex unit imports these types and this validator. Breaking
 * changes bump EVENTS_VERSION here, in one place.
 *
 * Ghost honesty depends on the `provenance` discriminant: "intended"
 * events may only come from a measured intent channel (Muse todo
 * snapshot, Claude Code plan document — see spike/RESULTS.md).
 * Filesystem watcher events and write-time tool events are "observed".
 * The validator rejects provenance that does not match the event type,
 * so an observed change can never be presented as agent intent.
 *
 * Boundary, stated plainly: validateFloorEvent guarantees shape and
 * provenance consistency, NOT origin. Provenance is asserted by the
 * producing adapter (trusted local code; agent output reaches this
 * module only through an adapter). Origin binding — an intended
 * event's planId must reference a `planned` event the floor actually
 * saw on an intent channel — is stateful and is enforced by the
 * floor store before any ghost solidifies (ghost layer, T4), never
 * by this stateless validator alone.
 */

export const EVENTS_VERSION = 1;

export type Provenance = "intended" | "observed";

/**
 * How an intended plan was obtained. Only channels the spike measured
 * with usable lead time (spike/RESULTS.md). Codex app-server plan
 * steps join this list only after an elicited trial measures them.
 */
export type IntentChannel = "todo" | "plan-document";

/** Max chars for free-text payloads rendered on the floor. */
export const MAX_TEXT_CHARS = 8192;

/** Potato-first payload bounds for one plan-shaped event. */
export const MAX_PATHS_PER_EVENT = 10_000;
export const MAX_STEPS_PER_PLAN = 1_000;

type Base = {
  /** Event format version; must equal EVENTS_VERSION. */
  v: typeof EVENTS_VERSION;
  /** Unique event id (ULID/UUID minted by the producer). */
  id: string;
  /** Wall-clock timestamp, ms since epoch. */
  ts: number;
  /** Agent session this event belongs to, when known. */
  sessionId?: string;
  /** Adapter id, e.g. "muse" | "claude-code" | "codex" | "opencode" | "watcher". */
  agentId?: string;
};

/** Agent stated (via an intent channel) that it will create/modify these paths. */
export type PlannedEvent = Base & {
  type: "planned";
  provenance: "intended";
  planId: string;
  channel: IntentChannel;
  /** Repo-relative paths the plan names, extracted deterministically. */
  paths: string[];
  /** Original plan step texts, kept as evidence for the inspector. */
  steps?: string[];
};

/** Agent began executing a planned step (or, observed, began some activity). */
export type StartedEvent = Base & {
  type: "started";
  path?: string;
  step?: string;
} & (
    | { provenance: "intended"; planId: string }
    | { provenance: "observed"; planId?: never }
  );

/**
 * A file was written. "intended" only when it solidifies a planned
 * ghost (planId present); a plain write-time tool event is "observed".
 */
export type FileWrittenEvent = Base & {
  type: "file-written";
  path: string;
} & (
    | {
        provenance: "intended";
        planId: string;
        /** A human write resolves a ghost as superseded, never intended (D20). */
        by?: "agent" | "unknown";
      }
    | {
        provenance: "observed";
        planId?: never;
        by?: "agent" | "human" | "unknown";
      }
  );

export type TestResultEvent = Base & {
  type: "test-result";
  provenance: "observed";
  /** Path of the test file or building the result is attached to. */
  path?: string;
  passed: number;
  failed: number;
  /** Command that produced this result, e.g. "bun test". */
  command?: string;
};

/** Filesystem change with no intent behind it (watcher, observed-only agent). */
export type ObservedChangeEvent = Base & {
  type: "observed-change";
  provenance: "observed";
  path: string;
  change: "created" | "modified" | "deleted" | "renamed";
  /** Previous path, for renames. */
  fromPath?: string;
};

/** A planned ghost saw no activity and expired (D7/D20). */
export type AbandonedPlanEvent = Base & {
  type: "abandoned-plan";
  provenance: "intended";
  planId: string;
  paths: string[];
  /** Ms since the last agent tool/file activity for this plan. */
  idleMs: number;
};

/** Human sent a prompt from the floor (persisted per design D16). */
export type PromptSentEvent = Base & {
  type: "prompt-sent";
  provenance: "observed";
  text: string;
};

/** Agent answered a what/why question (per capability matrix). */
export type WhyAnsweredEvent = Base & {
  type: "why-answered";
  provenance: "observed";
  /** Building the answer is about, when scoped to one. */
  path?: string;
  /** Answer text; producers must secret-mask before emitting (D18). */
  text: string;
};

/** Agent left a why-note on a building via floor.annotate (D19/T5). */
export type AnnotateEvent = Base & {
  type: "annotate";
  provenance: "observed";
  path: string;
  /** Note text; producers must escape + secret-mask before emit (D18). */
  note: string;
};

export type FloorEvent =
  | PlannedEvent
  | StartedEvent
  | FileWrittenEvent
  | TestResultEvent
  | ObservedChangeEvent
  | AbandonedPlanEvent
  | PromptSentEvent
  | WhyAnsweredEvent
  | AnnotateEvent;

export type FloorEventType = FloorEvent["type"];

/** Provenance allowed per event type. The single honesty table. */
const ALLOWED_PROVENANCE: Record<FloorEventType, readonly Provenance[]> = {
  planned: ["intended"],
  started: ["intended", "observed"],
  "file-written": ["intended", "observed"],
  "test-result": ["observed"],
  "observed-change": ["observed"],
  "abandoned-plan": ["intended"],
  "prompt-sent": ["observed"],
  "why-answered": ["observed"],
  annotate: ["observed"],
};

export class FloorEventError extends Error {}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function requireString(x: unknown, field: string): asserts x is string {
  if (typeof x !== "string" || x.length === 0) {
    throw new FloorEventError(`field "${field}" must be a non-empty string`);
  }
}

function requirePathArray(x: unknown, field: string): asserts x is string[] {
  if (!Array.isArray(x) || x.length === 0 || !x.every((p) => typeof p === "string" && p.length > 0)) {
    throw new FloorEventError(`field "${field}" must be a non-empty array of paths`);
  }
  if (x.length > MAX_PATHS_PER_EVENT) {
    throw new FloorEventError(`field "${field}" must contain at most ${MAX_PATHS_PER_EVENT} paths`);
  }
}

function optionalString(x: Record<string, unknown>, field: string): void {
  if (x[field] !== undefined && (typeof x[field] !== "string" || (x[field] as string).length === 0)) {
    throw new FloorEventError(`field "${field}" must be a non-empty string when present`);
  }
}

function requireFinite(x: unknown, field: string): asserts x is number {
  if (typeof x !== "number" || !Number.isFinite(x)) {
    throw new FloorEventError(`field "${field}" must be a finite number`);
  }
}

/** Floor paths are repo-relative: no absolute paths, no `..` escapes. */
function requireRepoPath(x: unknown, field: string): asserts x is string {
  requireString(x, field);
  const p = x as string;
  if (p.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(p) || p.includes("\\")) {
    throw new FloorEventError(`field "${field}" must be a repo-relative POSIX path`);
  }
  if (p.split("/").some((seg) => seg === ".." || seg === "." || seg === "")) {
    throw new FloorEventError(`field "${field}" must not contain "..", "." or empty segments`);
  }
}

function optionalRepoPath(x: Record<string, unknown>, field: string): void {
  if (x[field] !== undefined) requireRepoPath(x[field], field);
}

function requireText(x: unknown, field: string): asserts x is string {
  requireString(x, field);
  if ((x as string).length > MAX_TEXT_CHARS) {
    throw new FloorEventError(`field "${field}" exceeds ${MAX_TEXT_CHARS} chars`);
  }
}

/**
 * Validate an unknown value as a FloorEvent. Throws FloorEventError on
 * any contract violation — in particular, an event whose provenance
 * does not match its type (observed dressed as intended, or vice
 * versa) is rejected.
 */
export function validateFloorEvent(input: unknown): FloorEvent {
  if (!isRecord(input)) throw new FloorEventError("event must be an object");
  // Materialize one plain snapshot up front: every own property
  // (including non-enumerable accessors) is read exactly once, and
  // arrays are copied, so validation and the returned event can never
  // observe different values or later caller mutation.
  const snapshot: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(input)) {
    const value = (input as Record<PropertyKey, unknown>)[key];
    snapshot[key as string] = Array.isArray(value) ? [...value] : value;
  }
  const x: Record<string, unknown> = snapshot;
  if (x.v !== EVENTS_VERSION) {
    throw new FloorEventError(`unsupported event version: ${String(x.v)}`);
  }
  requireString(x.id, "id");
  requireFinite(x.ts, "ts");
  if ((x.ts as number) < 0) throw new FloorEventError('field "ts" must be >= 0');
  const type = x.type as FloorEventType;
  if (typeof type !== "string" || !Object.hasOwn(ALLOWED_PROVENANCE, type)) {
    throw new FloorEventError(`unknown event type: ${String(type)}`);
  }
  optionalString(x, "sessionId");
  optionalString(x, "agentId");
  const provenance = x.provenance as Provenance;
  if (!ALLOWED_PROVENANCE[type].includes(provenance)) {
    throw new FloorEventError(
      `event "${type}" cannot have provenance "${String(provenance)}"`,
    );
  }

  if (provenance === "observed" && x.planId !== undefined && type !== "planned") {
    throw new FloorEventError(`observed "${type}" must not carry a planId`);
  }

  switch (type) {
    case "planned": {
      requireString(x.planId, "planId");
      if (x.channel !== "todo" && x.channel !== "plan-document") {
        throw new FloorEventError("planned.channel must name a measured intent channel");
      }
      requirePathArray(x.paths, "paths");
      for (const p of x.paths as string[]) requireRepoPath(p, "paths[]");
      if (x.steps !== undefined) {
        if (!Array.isArray(x.steps)) {
          throw new FloorEventError('field "steps" must be an array of strings');
        }
        if (x.steps.length > MAX_STEPS_PER_PLAN) {
          throw new FloorEventError(`field "steps" must contain at most ${MAX_STEPS_PER_PLAN} steps`);
        }
        for (const step of x.steps) requireText(step, "steps[]");
      }
      break;
    }
    case "file-written": {
      requireRepoPath(x.path, "path");
      optionalString(x, "planId");
      if (x.by !== undefined && x.by !== "agent" && x.by !== "human" && x.by !== "unknown") {
        throw new FloorEventError('field "by" must be agent|human|unknown');
      }
      if (provenance === "intended") {
        requireString(x.planId, "planId (intended file-written must solidify a plan)");
        if (x.by === "human") {
          throw new FloorEventError("a human write is never intended (D20: superseded)");
        }
      }
      break;
    }
    case "test-result": {
      requireFinite(x.passed, "passed");
      requireFinite(x.failed, "failed");
      if (!Number.isInteger(x.passed) || !Number.isInteger(x.failed) || (x.passed as number) < 0 || (x.failed as number) < 0) {
        throw new FloorEventError("test-result counts must be non-negative integers");
      }
      optionalRepoPath(x, "path");
      optionalString(x, "command");
      break;
    }
    case "observed-change": {
      requireRepoPath(x.path, "path");
      if (typeof x.change !== "string" || !["created", "modified", "deleted", "renamed"].includes(x.change)) {
        throw new FloorEventError("observed-change.change is invalid");
      }
      optionalRepoPath(x, "fromPath");
      if (x.change === "renamed") requireRepoPath(x.fromPath, "fromPath (renamed)");
      break;
    }
    case "abandoned-plan": {
      requireString(x.planId, "planId");
      requirePathArray(x.paths, "paths");
      for (const p of x.paths as string[]) requireRepoPath(p, "paths[]");
      requireFinite(x.idleMs, "idleMs");
      if ((x.idleMs as number) < 0) throw new FloorEventError('field "idleMs" must be >= 0');
      break;
    }
    case "prompt-sent": {
      requireText(x.text, "text");
      break;
    }
    case "why-answered": {
      requireText(x.text, "text");
      optionalRepoPath(x, "path");
      break;
    }
    case "annotate": {
      requireRepoPath(x.path, "path");
      requireText(x.note, "note");
      break;
    }
    case "started": {
      optionalRepoPath(x, "path");
      optionalString(x, "step");
      optionalString(x, "planId");
      if (provenance === "intended") {
        requireString(x.planId, "planId (intended started must reference a plan)");
      }
      break;
    }
  }
  // Return a decoupled frozen copy: canonical scalar fields come from
  // the validated reads (spread drops non-enumerable accessors), and
  // array fields are copied and frozen so caller mutation after
  // validation cannot change the event. Planned paths are deduped.
  const validated = x as Record<string, unknown>;
  const out: Record<string, unknown> = { ...validated, type, provenance };
  if (Array.isArray(validated.paths)) {
    out.paths = Object.freeze([...new Set(validated.paths as string[])]);
  }
  if (Array.isArray(validated.steps)) {
    out.steps = Object.freeze([...(validated.steps as string[])]);
  }
  return Object.freeze(out) as FloorEvent;
}

/** True when the event is agent intent (may create/move a ghost). */
export function isIntended(e: FloorEvent): boolean {
  return e.provenance === "intended";
}
