import { desc, eq, ne } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { calls, integrationEvents } from "../db/schema";
import { createLogger } from "../logging/logger";
import { redact } from "../logging/redact";
import { createEscalation } from "./escalations";
import { currentCallMode, ensureCallContext, type CallContext } from "./ingest";
import { enqueue } from "./outbox";
import { storeTranscript } from "./postcall";
import { getQualificationConfig } from "./settings";
import { logCallEvent, transitionCall, type CallState } from "./workflow";

const log = createLogger("vaani-webhook");

/**
 * Vaani call-lifecycle webhooks (docs.vaanivoice.ai/guides/webhook-setup). Payloads are normalised leniently
 * because the docs show slightly different shapes per event (flat fields vs a nested `data` object).
 */
const eventSchema = z
  .object({
    event: z.string(),
    room_name: z.string().optional(),
    call_id: z.string().optional(),
    status: z.string().optional(),
    phone_number: z.string().optional(),
    from_number: z.string().optional(),
    to_number: z.string().optional(),
    direction: z.string().optional(),
    agent_id: z.string().optional(),
    timestamp: z.string().optional(),
    call_duration: z.number().optional(),
    end_reason: z.string().optional(),
    transfer_type: z.string().optional(),
    reason: z.string().optional(),
    data: z
      .object({
        room_name: z.string().optional(),
        call_id: z.string().optional(),
        call_duration: z.number().optional(),
        end_reason: z.string().optional(),
        summary: z.string().nullable().optional(),
        transcript: z.string().nullable().optional(),
        entities: z.record(z.string(), z.unknown()).nullable().optional(),
        dispositions: z.record(z.string(), z.unknown()).nullable().optional(),
        from_number: z.string().optional(),
        phone_number: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type VaaniEvent = z.infer<typeof eventSchema>;

export type WebhookResult =
  | { status: "processed"; event: string; callId?: string }
  | { status: "duplicate"; event: string }
  | { status: "ignored"; event: string; reason: string }
  | { status: "invalid"; error: string };

const EARLY_STATES: CallState[] = [
  "call_received", "agent_active", "capturing_information", "clarification_required", "asking_availability",
  "checking_calendar", "awaiting_customer_confirmation", "booking_calendar",
];

export async function handleVaaniEvent(db: Db, raw: unknown): Promise<WebhookResult> {
  const parsed = eventSchema.safeParse(raw);
  if (!parsed.success) return { status: "invalid", error: parsed.error.issues[0]?.message ?? "bad payload" };
  const ev = parsed.data;
  const vaaniCallId = ev.call_id ?? ev.data?.call_id ?? ev.room_name ?? ev.data?.room_name;
  if (!vaaniCallId) return { status: "invalid", error: "no call_id or room_name" };

  if (ev.direction && /outbound/i.test(ev.direction)) {
    return { status: "ignored", event: ev.event, reason: "outbound calls are out of scope for this build" };
  }

  const mode = currentCallMode();
  const dedupeKey = `vaani:${ev.event}:${vaaniCallId}:${ev.timestamp ?? ev.transfer_type ?? ""}:${ev.reason ?? ""}`;
  const inserted = await db
    .insert(integrationEvents)
    .values({ integration: "vaani", direction: "inbound", eventType: ev.event, dedupeKey, status: "received", payload: redact(ev) as Record<string, unknown>, mode })
    .onConflictDoNothing({ target: integrationEvents.dedupeKey })
    .returning({ id: integrationEvents.id });
  if (inserted.length === 0) return { status: "duplicate", event: ev.event };
  const eventRowId = inserted[0]!.id;

  try {
    const config = await getQualificationConfig(db);
    const fromNumber = ev.from_number ?? ev.phone_number ?? ev.data?.from_number ?? ev.data?.phone_number ?? null;
    const receivedAt = ev.timestamp && !Number.isNaN(Date.parse(ev.timestamp)) ? new Date(ev.timestamp) : new Date();
    const ctx: CallContext = await ensureCallContext(db, {
      vaaniCallId, fromNumber, toNumber: ev.to_number ?? null, agentId: ev.agent_id ?? null, receivedAt, mode,
      businessHours: config.businessHours, source: "webhook",
    });
    const result = await applyEvent(db, ctx, ev);
    await db.update(integrationEvents).set({ status: "processed" }).where(eq(integrationEvents.id, eventRowId));
    return result;
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 400);
    await db.update(integrationEvents).set({ status: "failed", error: message }).where(eq(integrationEvents.id, eventRowId));
    log.error("webhook processing failed", { event: ev.event, error: message });
    throw err;
  }
}

function eventTime(ev: VaaniEvent): Date {
  return ev.timestamp && !Number.isNaN(Date.parse(ev.timestamp)) ? new Date(ev.timestamp) : new Date();
}

async function applyEvent(db: Db, ctx: CallContext, ev: VaaniEvent): Promise<WebhookResult> {
  const callId = ctx.call.id;
  switch (ev.event) {
    case "call_started": {
      await transitionCall(db, callId, "agent_active", { event: ev.event });
      if (ctx.createdNow || !ctx.call.fromNumber) {
        const num = ev.from_number ?? ev.phone_number;
        if (num && !ctx.call.fromNumber) await logCallEvent(db, callId, "caller_number_late_bound", {});
      }
      return { status: "processed", event: ev.event, callId };
    }
    case "user_picked_up_at": {
      await db.update(calls).set({ answeredAt: eventTime(ev), answered: true, updatedAt: new Date() }).where(eq(calls.id, callId));
      await transitionCall(db, callId, "agent_active", { event: ev.event });
      return { status: "processed", event: ev.event, callId };
    }
    case "call_ended": {
      const durationMs = ev.call_duration !== undefined ? Math.round(ev.call_duration * 1000) : null; // seconds in this event
      const answered = ctx.call.answered || (durationMs !== null && durationMs >= 5_000);
      await db.update(calls).set({ endedAt: eventTime(ev), durationMs, endReason: ev.end_reason ?? null, answered, updatedAt: new Date() }).where(eq(calls.id, callId));
      const [fresh] = await db.select({ state: calls.state }).from(calls).where(eq(calls.id, callId)).limit(1);
      const state = fresh!.state as CallState;
      // Safety net: if Vaani's post-processing webhook never arrives, still enrich and hand off this call later.
      await enqueue(db, { type: "postcall_enrich", key: `postcall-fallback:${callId}`, payload: { callId, fallback: true }, delaySec: 900, maxAttempts: 6 });
      if (EARLY_STATES.includes(state)) {
        await transitionCall(db, callId, "abandoned", { endReason: ev.end_reason ?? null });
        // A caller who got cut off must not be lost: ask the front desk to call back (skipped if they redial).
        if (ctx.call.fromNumber && answered) {
          await enqueue(db, { type: "send_email", key: `email:dropped:${callId}`, payload: { kind: "dropped_call", callId }, delaySec: 600 });
        }
      }
      return { status: "processed", event: ev.event, callId };
    }
    case "call_postprocessing": {
      const d = ev.data ?? {};
      await db
        .update(calls)
        .set({ durationMs: d.call_duration !== undefined ? Math.round(d.call_duration) : ctx.call.durationMs, endReason: d.end_reason ?? ctx.call.endReason, updatedAt: new Date() })
        .where(eq(calls.id, callId));
      await storeTranscript(db, callId, d.transcript ?? null);
      await enqueue(db, { type: "postcall_enrich", key: `postcall:${callId}`, payload: { callId, vaaniSummaryPresent: !!d.summary }, maxAttempts: 6 });
      return { status: "processed", event: ev.event, callId };
    }
    case "human_transfer_initiated":
    case "human_transfer_successful": {
      await logCallEvent(db, callId, ev.event, { transferType: ev.transfer_type ?? null });
      return { status: "processed", event: ev.event, callId };
    }
    case "human_transfer_failed": {
      await logCallEvent(db, callId, ev.event, { reason: ev.reason ?? null });
      await createEscalation(db, {
        enquiryId: ctx.enquiry.id, callId, kind: "senior_requested", urgency: "high", mode: ctx.call.mode,
        reason: `A warm transfer to a human failed (${ev.reason ?? "no reason given"}). The caller still needs a callback.`,
        requestedResponse: "Call the customer back immediately.",
      });
      return { status: "processed", event: ev.event, callId };
    }
    default:
      await logCallEvent(db, callId, `vaani_event:${ev.event}`, {});
      return { status: "ignored", event: ev.event, reason: "event type not used by this workflow" };
  }
}

export async function latestCalls(db: Db, limit = 20) {
  return db.select().from(calls).where(ne(calls.state, "completed")).orderBy(desc(calls.receivedAt)).limit(limit);
}

