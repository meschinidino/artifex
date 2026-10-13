import { EVENTS_VERSION, type FileWrittenEvent, type StartedEvent } from "./index.ts";

const base = { v: EVENTS_VERSION, id: "typecheck", ts: 0 } as const;

export const intendedWrite: FileWrittenEvent = {
  ...base,
  type: "file-written",
  provenance: "intended",
  path: "src/a.ts",
  planId: "plan-1",
  by: "agent",
};

export const observedWrite: FileWrittenEvent = {
  ...base,
  type: "file-written",
  provenance: "observed",
  path: "src/a.ts",
  by: "human",
};

export const intendedStarted: StartedEvent = {
  ...base,
  type: "started",
  provenance: "intended",
  planId: "plan-1",
};

// @ts-expect-error intended file-written events must solidify a named plan
export const intendedWriteWithoutPlan: FileWrittenEvent = {
  ...base,
  type: "file-written",
  provenance: "intended",
  path: "src/a.ts",
};

// @ts-expect-error a human write can never be agent intent
export const humanIntendedWrite: FileWrittenEvent = {
  ...base,
  type: "file-written",
  provenance: "intended",
  path: "src/a.ts",
  planId: "plan-1",
  by: "human",
};

// @ts-expect-error observed file-written events cannot reference a plan
export const observedWriteWithPlan: FileWrittenEvent = {
  ...base,
  type: "file-written",
  provenance: "observed",
  path: "src/a.ts",
  planId: "plan-1",
};

// @ts-expect-error intended started events must reference a named plan
export const intendedStartedWithoutPlan: StartedEvent = {
  ...base,
  type: "started",
  provenance: "intended",
};

// @ts-expect-error observed started events cannot reference a plan
export const observedStartedWithPlan: StartedEvent = {
  ...base,
  type: "started",
  provenance: "observed",
  planId: "plan-1",
};
