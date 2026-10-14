/**
 * Intent binding gate (TODOS.md, intent-binding item). The shared
 * events validator proves shape and provenance consistency, NOT
 * origin — so before an intended `started` or `file-written` event
 * may solidify a ghost, its planId must match a `planned` event
 * previously ingested from a measured intent channel in the same
 * session. Unknown, abandoned, idle-expired, or unpersisted plan
 * references come back unbound; the caller (ghost layer) demotes
 * them to observed or rejects them. This module never mutates
 * events and never touches the events validator's contract.
 *
 * Two trust boundaries, stated plainly:
 * - The durable log is writable by anything with repo access, so a
 *   loaded intended event is unbound until it passes the same check
 *   a live one does. `rebuild` replays the loaded log oldest-first
 *   through that check; a plan recorded from disk still binds
 *   post-restart writes, but an intended event never gets a free
 *   pass for merely being on disk.
 * - Single events past the line cap live in memory only (store.ts).
 *   Live intake must pass the `appendEventLog` result as
 *   `persisted`: an over-cap plan records but never binds, so a
 *   restart cannot strand a solidified ghost with no plan history.
 *
 * The gate checks plan identity only (session + planId), never
 * path membership: a bound write may name a path outside the
 * plan's paths. Path-vs-plan attribution at solidify time belongs
 * to the ghost layer, which sees both the ghost and the building.
 */
import type { FloorEvent } from "../events/index.ts";

/**
 * D7/D20 default: a plan with no session activity past this window
 * no longer binds. Configurable per gate; the ghost layer owns
 * emitting the matching `abandoned-plan` event.
 */
export const PLAN_IDLE_TIMEOUT_MS = 10 * 60 * 1000;

export type UnboundReason =
  /** No `planned` event was ever ingested for this planId. */
  | "unknown-plan"
  /** The planId is known, but under a different sessionId. */
  | "wrong-session"
  /** The plan was abandoned (`abandoned-plan` ingested). */
  | "abandoned-plan"
  /** No session activity within the idle window (D7/D20). */
  | "expired-plan"
  /** The plan never reached disk (over the line cap); see store.ts. */
  | "unpersisted-plan";

export type BindingVerdict =
  /** Intended `started` / `file-written`: the plan reference holds. */
  | { verdict: "bound" }
  /** Intended `started` / `file-written`: demote to observed or reject. */
  | { verdict: "unbound"; reason: UnboundReason }
  /** `planned`: accepted into the index (bindable only if persisted). */
  | { verdict: "recorded" }
  /** `abandoned-plan`: accepted; the plan no longer binds. */
  | { verdict: "abandoned" }
  /** Observed event: passes through, refreshing session activity. */
  | { verdict: "observed" };

type PlanRecord = {
  /** Last wall-clock activity for this plan's session (event ts). */
  lastActivityTs: number;
  abandoned: boolean;
  persisted: boolean;
};

export type IntentGate = {
  /**
   * Ingest one validated event in log order. `persisted` is the
   * `appendEventLog` result for live intake (default true — pass
   * false for over-cap / refused writes); `rebuild` passes true.
   */
  ingest(event: FloorEvent, opts?: { persisted?: boolean }): BindingVerdict;
  /**
   * Rebuild the index from the durable log after a reboot, oldest
   * first. Returns one verdict per event: loaded intended events
   * are checked, never trusted. Verdicts are for inspection only —
   * do not re-append these events; they are already on disk.
   */
  rebuild(events: readonly FloorEvent[]): BindingVerdict[];
  /** Whether (sessionId, planId) would bind right now. No side effects. */
  isBound(sessionId: string | undefined, planId: string): boolean;
  /** Drop abandoned and idle-expired records. Returns the count dropped. */
  prune(): number;
  /** Live plan records, for tests and debugging. */
  planCount(): number;
};

export function createIntentGate(opts?: {
  /** Clock for idle expiry; inject a manual clock in tests. */
  now?: () => number;
  /** Idle window before a plan stops binding (D7/D20). */
  idleTimeoutMs?: number;
}): IntentGate {
  const now = opts?.now ?? Date.now;
  const idleTimeoutMs = opts?.idleTimeoutMs ?? PLAN_IDLE_TIMEOUT_MS;
  // sessionId ("" when absent) -> planId -> record. Absent-session
  // plans are recorded but never bind: the task requires the same
  // session on both sides, and an unknown session is not a match.
  const plans = new Map<string, Map<string, PlanRecord>>();

  const sessionKey = (sessionId: string | undefined): string => sessionId ?? "";

  function getRecord(sessionId: string | undefined, planId: string): PlanRecord | undefined {
    return plans.get(sessionKey(sessionId))?.get(planId);
  }

  function planKnownElsewhere(sessionId: string | undefined, planId: string): boolean {
    const here = sessionKey(sessionId);
    for (const [session, byPlan] of plans) {
      if (session !== here && byPlan.has(planId)) return true;
    }
    return false;
  }

  function expired(record: PlanRecord): boolean {
    return now() - record.lastActivityTs > idleTimeoutMs;
  }

  // Session activity (D20: agent tool or file events) keeps every
  // live plan in that session from expiring. The ghost layer's own
  // `abandoned-plan` is terminal, not activity; unbound attempts
  // must not extend a plan's life, so callers refresh only on
  // verdicts that represent genuine session activity.
  function refreshSession(sessionId: string | undefined, ts: number): void {
    if (sessionId === undefined) return;
    const byPlan = plans.get(sessionId);
    if (!byPlan) return;
    for (const record of byPlan.values()) {
      if (!record.abandoned) record.lastActivityTs = Math.max(record.lastActivityTs, ts);
    }
  }

  function check(sessionId: string | undefined, planId: string): BindingVerdict {
    // Fail closed: without a session there is no "same session"
    // to match, so the pair is unknown by definition.
    if (sessionId === undefined) return { verdict: "unbound", reason: "unknown-plan" };
    const record = getRecord(sessionId, planId);
    if (!record) {
      return {
        verdict: "unbound",
        reason: planKnownElsewhere(sessionId, planId) ? "wrong-session" : "unknown-plan",
      };
    }
    if (record.abandoned) return { verdict: "unbound", reason: "abandoned-plan" };
    if (!record.persisted) return { verdict: "unbound", reason: "unpersisted-plan" };
    if (expired(record)) return { verdict: "unbound", reason: "expired-plan" };
    return { verdict: "bound" };
  }

  function ingest(event: FloorEvent, opts?: { persisted?: boolean }): BindingVerdict {
    // Activity timestamps drive expiry, so a far-future event ts
    // must not extend a plan's life: clamp to the gate clock.
    const ts = Math.min(event.ts, now());
    switch (event.type) {
      case "planned": {
        refreshSession(event.sessionId, ts);
        let byPlan = plans.get(sessionKey(event.sessionId));
        if (!byPlan) {
          byPlan = new Map();
          plans.set(sessionKey(event.sessionId), byPlan);
        }
        // A re-ingested plan (replay, double delivery, re-plan
        // after abandonment) replaces the record; timestamps stay
        // monotonic so replays never move activity backwards, and
        // unpersisted is sticky: an over-cap plan never reaches
        // disk, so no later delivery can make it persisted.
        const prev = byPlan.get(event.planId);
        byPlan.set(event.planId, {
          lastActivityTs: Math.max(prev?.lastActivityTs ?? -Infinity, ts),
          abandoned: false,
          persisted: (opts?.persisted ?? true) && (prev?.persisted ?? true),
        });
        return { verdict: "recorded" };
      }
      case "abandoned-plan": {
        const record = getRecord(event.sessionId, event.planId);
        if (record) record.abandoned = true;
        return { verdict: "abandoned" };
      }
      case "started":
      case "file-written": {
        if (event.provenance === "observed") {
          refreshSession(event.sessionId, ts);
          return { verdict: "observed" };
        }
        const decision = check(event.sessionId, event.planId);
        if (decision.verdict === "bound") refreshSession(event.sessionId, ts);
        return decision;
      }
      default: {
        refreshSession(event.sessionId, ts);
        return { verdict: "observed" };
      }
    }
  }

  return {
    ingest,

    rebuild(events: readonly FloorEvent[]): BindingVerdict[] {
      return events.map((event) => ingest(event, { persisted: true }));
    },

    isBound(sessionId: string | undefined, planId: string): boolean {
      return check(sessionId, planId).verdict === "bound";
    },

    prune(): number {
      let dropped = 0;
      for (const [session, byPlan] of plans) {
        for (const [planId, record] of byPlan) {
          if (record.abandoned || expired(record)) {
            byPlan.delete(planId);
            dropped++;
          }
        }
        if (byPlan.size === 0) plans.delete(session);
      }
      return dropped;
    },

    planCount(): number {
      let n = 0;
      for (const byPlan of plans.values()) n += byPlan.size;
      return n;
    },
  };
}
