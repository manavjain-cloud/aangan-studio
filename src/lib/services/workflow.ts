import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { callEvents, calls } from "../db/schema";
import { createLogger } from "../logging/logger";
import { redact } from "../logging/redact";

const log = createLogger("workflow");

/**
 * Explicit call workflow (spec section 10). Transitions are enumerated; anything else is refused and logged,
 * so a confused voice agent or a replayed webhook can never push a call into an impossible state.
 */

export const CALL_STATES = [
  "call_received",
  "agent_active",
  "capturing_information",
  "checking_qualification",
  "clarification_required",
  "qualified",
  "rejected",
  "human_escalation",
  "asking_availability",
  "checking_calendar",
  "awaiting_customer_confirmation",
  "booking_calendar",
  "booking_confirmed",
  "booking_failed",
  "abandoned",
  "completed",
] as const;
export type CallState = (typeof CALL_STATES)[number];

export const TRANSITIONS: Record<CallState, readonly CallState[]> = {
  call_received: ["agent_active", "capturing_information", "abandoned", "human_escalation"],
  agent_active: ["capturing_information", "checking_qualification", "human_escalation", "abandoned", "completed"],
  capturing_information: ["capturing_information", "checking_qualification", "human_escalation", "abandoned"],
  checking_qualification: ["qualified", "clarification_required", "rejected", "human_escalation"],
  clarification_required: ["capturing_information", "checking_qualification", "human_escalation", "abandoned"],
  qualified: ["asking_availability", "checking_qualification", "capturing_information", "human_escalation", "completed", "abandoned"],
  rejected: ["completed", "human_escalation", "capturing_information", "checking_qualification"],
  human_escalation: ["completed", "capturing_information", "checking_qualification", "abandoned"],
  asking_availability: ["checking_calendar", "human_escalation", "abandoned", "completed"],
  checking_calendar: ["awaiting_customer_confirmation", "asking_availability", "human_escalation", "abandoned"],
  awaiting_customer_confirmation: ["booking_calendar", "checking_calendar", "asking_availability", "human_escalation", "abandoned", "completed"],
  booking_calendar: ["booking_confirmed", "checking_calendar", "awaiting_customer_confirmation", "booking_failed"],
  booking_confirmed: ["completed"],
  booking_failed: ["human_escalation", "completed", "checking_calendar"],
  abandoned: ["completed"],
  completed: [],
};

export function canTransition(from: CallState, to: CallState): boolean {
  return from === to || TRANSITIONS[from].includes(to);
}

export async function logCallEvent(
  db: Db,
  callId: string,
  type: string,
  detail: Record<string, unknown> = {},
  states?: { from?: string; to?: string },
): Promise<void> {
  await db.insert(callEvents).values({
    callId,
    type,
    fromState: states?.from ?? null,
    toState: states?.to ?? null,
    detail: redact(detail) as Record<string, unknown>,
  });
}

export async function transitionCall(
  db: Db,
  callId: string,
  to: CallState,
  detail: Record<string, unknown> = {},
): Promise<{ ok: boolean; from: CallState; to: CallState }> {
  const [row] = await db.select({ state: calls.state }).from(calls).where(eq(calls.id, callId)).limit(1);
  if (!row) throw new Error(`call ${callId} not found`);
  const from = row.state as CallState;
  if (from === to) return { ok: true, from, to };
  if (!canTransition(from, to)) {
    log.warn("illegal call transition refused", { callId, from, to });
    await logCallEvent(db, callId, "illegal_transition_refused", { attempted: to, ...detail }, { from, to: from });
    return { ok: false, from, to };
  }
  await db.update(calls).set({ state: to, updatedAt: new Date() }).where(eq(calls.id, callId));
  await logCallEvent(db, callId, "state_changed", detail, { from, to });
  return { ok: true, from, to };
}

/**
 * Walk a path of states towards the last one. Steps the call has already moved past (not reachable from where
 * it is now) are skipped silently; the walk succeeds only if the final state is reached.
 */
export async function advanceThrough(db: Db, callId: string, path: CallState[]): Promise<{ ok: boolean; state: CallState }> {
  let current: CallState = "call_received";
  const [row] = await db.select({ state: calls.state }).from(calls).where(eq(calls.id, callId)).limit(1);
  if (row) current = row.state as CallState;
  const target = path[path.length - 1];
  for (const step of path) {
    if (current === step) continue;
    if (!canTransition(current, step)) {
      if (step === target) {
        // The destination itself is not reachable: record the refusal once.
        await transitionCall(db, callId, step);
        return { ok: false, state: current };
      }
      continue; // an intermediate step we are already beyond
    }
    const r = await transitionCall(db, callId, step);
    if (!r.ok) return { ok: false, state: current };
    current = step;
  }
  return { ok: current === target, state: current };
}
