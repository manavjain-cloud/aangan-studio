import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { bookingAttempts, calls, integrationEvents, toolInvocations } from "../db/schema";
import { APPROVED_PRICING_RESPONSE, sanitizeSpokenText } from "../domain/pricing-guard";
import { BOOKING_FAILURE_AGENT_LINE, BORDERLINE_AGENT_LINE, escalationAgentLine } from "../domain/messages";
import { evaluateQualification } from "../domain/qualification";
import { enquiryFactsSchema, type EnquiryFacts, type EscalationKind } from "../domain/types";
import { requireNumber } from "../env";
import { createLogger } from "../logging/logger";
import { redact } from "../logging/redact";
import { checkRateLimit } from "../security/rate-limit";
import { sha256Hex } from "../security/hmac";
import { DEFAULT_TZ, isAfterHours, isoDateInZone, zonedParts } from "../time";
import { bookConsultation, getAvailableSlots, type SlotsOutcome, type TimeOfDay } from "./booking";
import { createEscalation } from "./escalations";
import { currentCallMode, ensureCallContext, findActiveCallByPhone, normalizePhone, type CallContext } from "./ingest";
import { enqueue } from "./outbox";
import { evaluateAndPersist, saveFacts } from "./qualify";
import { getQualificationConfig } from "./settings";
import { advanceThrough, logCallEvent, transitionCall } from "./workflow";

const log = createLogger("voice-tools");

/**
 * Live voice-agent tool endpoint logic: POST /api/voice/tools/aangan-workflow-action.
 * The model only supplies facts and relays what the server returns. All rules, availability, bookings and
 * escalations are decided here, and every spoken line comes from fixed server templates passed through the
 * pricing guard.
 */

export const TOOL_ACTIONS = [
  "get_call_context",
  "save_enquiry_progress",
  "evaluate_qualification",
  "get_available_slots",
  "book_consultation",
  "escalate_to_human",
] as const;
export type ToolAction = (typeof TOOL_ACTIONS)[number];

const envelopeSchema = z
  .object({
    action: z.enum(TOOL_ACTIONS),
    call_id: z.unknown().optional(),
    caller_phone: z.unknown().optional(),
    request_id: z.unknown().optional(),
    args: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

export interface ToolResponseBody {
  ok: boolean;
  status: string;
  /** Wording the agent should say (verbatim where marked) - already passed through the pricing guard. */
  say?: string;
  /** What the agent should do next. */
  next_action?: string;
  /** Extra guidance that is not spoken aloud. */
  instruction?: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

export interface ToolResult {
  httpStatus: number;
  body: ToolResponseBody;
}

const PLACEHOLDER = /^\s*(\{+.*\}+|<.*>|null|undefined|none|n\/a|)\s*$/i;
function cleanId(v: unknown, max = 200): string | undefined {
  if (typeof v !== "string") return typeof v === "number" ? String(v) : undefined;
  return PLACEHOLDER.test(v) || v.length > max ? undefined : v.trim();
}

function reply(body: ToolResponseBody, httpStatus = 200): ToolResult {
  if (body.say) {
    const s = sanitizeSpokenText(body.say);
    body.say = s.text;
    if (s.replaced) body.instruction = `${body.instruction ?? ""} (A line that looked like a price was replaced by the approved pricing response.)`.trim();
  }
  return { httpStatus, body };
}

function sayError(code: string, message: string, say: string, httpStatus = 200): ToolResult {
  return reply({ ok: false, status: code, say, next_action: "continue_conversation", error: { code, message } }, httpStatus);
}

/* ------------------------------------------------------------------ */

export interface ToolRequestMeta {
  ip: string;
  /** Names (never values) of the request headers, for diagnosing what the Vaani tool runner actually sends. */
  headerNames?: string[];
}

export async function handleToolRequest(db: Db, rawBody: unknown, meta: ToolRequestMeta): Promise<ToolResult> {
  const parsed = envelopeSchema.safeParse(rawBody);
  if (!parsed.success) {
    return reply({ ok: false, status: "invalid_request", error: { code: "invalid_request", message: parsed.error.issues[0]?.message ?? "bad payload" } }, 400);
  }
  const { action, args, call_id, caller_phone, request_id, ...rest } = parsed.data;
  const data: Record<string, unknown> = { ...rest, ...(args ?? {}) };
  const vaaniCallId = cleanId(call_id);
  const phone = normalizePhone(cleanId(caller_phone, 40) ?? null);
  const requestId = cleanId(request_id, 120);

  const ipLimit = await checkRateLimit(db, `tool:ip:${meta.ip}`, 240, 60);
  if (!ipLimit.allowed) {
    return reply({ ok: false, status: "rate_limited", error: { code: "rate_limited", message: `Too many requests; retry in ${ipLimit.retryAfterSec}s` } }, 429);
  }

  const mode = currentCallMode();
  const config = await getQualificationConfig(db);

  // Resolve the call. Prefer the explicit Vaani call id; fall back to the caller's number.
  let ctx: CallContext | null = null;
  if (vaaniCallId) {
    ctx = await ensureCallContext(db, { vaaniCallId, fromNumber: phone, mode, businessHours: config.businessHours, source: "tool" });
  } else if (phone) {
    const active = await findActiveCallByPhone(db, phone, mode);
    if (active) ctx = await ensureCallContext(db, { vaaniCallId: active.vaaniCallId, fromNumber: phone, mode, businessHours: config.businessHours, source: "tool" });
  }
  if (!ctx) {
    // Diagnostics for set-up: record WHICH fields/headers arrived (names only) so the Vaani tool mapping can be corrected.
    await db.insert(integrationEvents).values({
      integration: "vaani", direction: "inbound", eventType: "tool_call_without_call_context", status: "rejected",
      error: "Tool call carried neither call_id nor caller_phone",
      payload: { action, bodyKeys: Object.keys(data), headerNames: meta.headerNames ?? [] },
    }).catch(() => undefined);
    return reply(
      { ok: false, status: "missing_call_context", error: { code: "missing_call_context", message: "Provide call_id, or caller_phone for a call that is in progress." } },
      422,
    );
  }
  const callLimit = await checkRateLimit(db, `tool:call:${ctx.call.id}`, 90, 60);
  if (!callLimit.allowed) {
    return reply({ ok: false, status: "rate_limited", error: { code: "rate_limited", message: "Too many tool calls for this call" } }, 429);
  }

  // Idempotency: an identical request replays the stored answer instead of repeating side effects.
  const permanent = action === "book_consultation" || action === "escalate_to_human";
  const bucket = permanent ? "perm" : String(Math.floor(Date.now() / 120_000));
  const requestKey = sha256Hex(`${ctx.call.id}|${action}|${requestId ?? JSON.stringify(sortKeys(data))}|${bucket}`);
  const started = Date.now();
  const inserted = await db
    .insert(toolInvocations)
    .values({ callId: ctx.call.id, action, requestKey, request: redact({ action, ...data }) as Record<string, unknown>, mode })
    .onConflictDoNothing({ target: toolInvocations.requestKey })
    .returning({ id: toolInvocations.id });

  if (inserted.length === 0) {
    for (let i = 0; i < 12; i++) {
      const [prior] = await db.select().from(toolInvocations).where(eq(toolInvocations.requestKey, requestKey)).limit(1);
      if (prior?.response) return { httpStatus: 200, body: { ...(prior.response as unknown as ToolResponseBody), instruction: "(replayed: identical request already handled)" } };
      if (prior?.status === "error") break;
      await new Promise((r) => setTimeout(r, 250));
    }
    return sayError("request_in_progress", "An identical request is still being processed", "One moment please.");
  }
  const invocationId = inserted[0]!.id;

  let result: ToolResult;
  try {
    result = await withDeadline(
      dispatch(db, ctx, action, data, config),
      action === "book_consultation" ? 13_000 : 9_000,
      async () => {
        if (action === "book_consultation") await markBookingUnconfirmed(db, ctx!);
        return sayError(
          "timeout",
          "The action took too long and was not confirmed",
          action === "book_consultation"
            ? "I wasn't able to confirm that booking in time. A colleague will check and confirm it with you shortly."
            : "I'm sorry, that is taking longer than expected. Let me carry on and we'll follow up.",
        );
      },
    );
    await db
      .update(toolInvocations)
      .set({ response: result.body as unknown as Record<string, unknown>, status: result.body.ok ? "ok" : "error", durationMs: Date.now() - started })
      .where(eq(toolInvocations.id, invocationId));
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 300);
    log.error("tool action crashed", { action, callId: ctx.call.id, error: message });
    result = sayError("server_error", "Unexpected error", "I'm having a technical problem on my side. I'll make sure a colleague follows up with you.", 500);
    await db.update(toolInvocations).set({ status: "error", error: message, durationMs: Date.now() - started, response: result.body as unknown as Record<string, unknown> }).where(eq(toolInvocations.id, invocationId));
    await createEscalation(db, {
      enquiryId: ctx.enquiry.id, callId: ctx.call.id, kind: "integration_failure", urgency: "normal", mode: ctx.call.mode,
      reason: `A live tool action ("${action}") crashed during a call: ${message}. The caller was told a colleague will follow up.`,
      requestedResponse: "Call the customer back; check application logs.",
    }).catch(() => undefined);
  }
  return result;
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sortKeys(x)]));
  return v;
}

async function withDeadline<T>(work: Promise<T>, ms: number, onTimeout: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"__timeout">((resolve) => {
    timer = setTimeout(() => resolve("__timeout"), ms);
  });
  work.catch(() => undefined); // the work keeps running; its error is handled by whichever branch wins
  const winner = await Promise.race([work, timeout]);
  clearTimeout(timer);
  return winner === "__timeout" ? onTimeout() : (winner as T);
}

async function markBookingUnconfirmed(db: Db, ctx: CallContext) {
  const [attempt] = await db.select().from(bookingAttempts).where(and(eq(bookingAttempts.callId, ctx.call.id), eq(bookingAttempts.status, "pending"))).orderBy(desc(bookingAttempts.createdAt)).limit(1);
  if (!attempt) return;
  await db.update(bookingAttempts).set({ status: "unconfirmed", error: "tool deadline exceeded", updatedAt: new Date() }).where(eq(bookingAttempts.id, attempt.id));
  await enqueue(db, { type: "booking_reconcile", key: `reconcile:${attempt.id}`, payload: { attemptId: attempt.id }, delaySec: 60, maxAttempts: 5 });
  await createEscalation(db, {
    enquiryId: ctx.enquiry.id, callId: ctx.call.id, kind: "booking_failure", urgency: "high", mode: ctx.call.mode,
    reason: "The booking request did not complete within the live-call time limit, so it is unconfirmed. Check Calendly for an existing event before booking again.",
    requestedResponse: "Verify in Calendly, then confirm or re-book with the customer.",
  });
}

/* ------------------------------------------------------------------ */

async function dispatch(db: Db, ctx: CallContext, action: ToolAction, data: Record<string, unknown>, config: Awaited<ReturnType<typeof getQualificationConfig>>): Promise<ToolResult> {
  switch (action) {
    case "get_call_context":
      return getCallContext(db, ctx, config);
    case "save_enquiry_progress":
      return saveProgress(db, ctx, data);
    case "evaluate_qualification":
      return evaluate(db, ctx, data, config);
    case "get_available_slots":
      return slots(db, ctx, data);
    case "book_consultation":
      return book(db, ctx, data);
    case "escalate_to_human":
      return escalate(db, ctx, data, config);
  }
}

const KNOWN_FIELDS_FOR_AGENT = [
  "caller_name", "project_type", "property_kind", "service_intent", "scope", "bhk", "carpet_area_sqft", "location_text",
  "desired_completion_date", "timeline_flexible", "authority", "caller_email",
] as const;

async function getCallContext(db: Db, ctx: CallContext, config: Awaited<ReturnType<typeof getQualificationConfig>>): Promise<ToolResult> {
  const now = new Date();
  const p = zonedParts(now, DEFAULT_TZ);
  const known = Object.fromEntries(KNOWN_FIELDS_FOR_AGENT.map((k) => [k, ctx.enquiry.facts[k]]).filter(([, v]) => v !== null));
  const repeat = !!ctx.call.relatedCallId;
  await advanceThrough(db, ctx.call.id, ["agent_active"]);
  return reply({
    ok: true,
    status: "context",
    data: {
      today: isoDateInZone(now, DEFAULT_TZ),
      weekday: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][p.weekday],
      local_time: `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
      timezone: DEFAULT_TZ,
      after_hours: isAfterHours(now, config.businessHours),
      repeat_call: repeat,
      already_known: known,
    },
    instruction: repeat
      ? "This caller was disconnected earlier. Welcome them back, do not ask again for anything listed in already_known."
      : "Use `today` to turn phrases like 'by March' into an ISO date (YYYY-MM-DD) when saving progress. Do not mention internal systems.",
  });
}

function stillNeeded(facts: EnquiryFacts): string[] {
  const r = evaluateQualification(facts, {});
  return r.criteria.filter((c) => c.status === "unknown" && ["real_project", "service_area", "timeline"].includes(c.key)).map((c) => c.key);
}

async function saveProgress(db: Db, ctx: CallContext, data: Record<string, unknown>): Promise<ToolResult> {
  const incoming = enquiryFactsSchema.parse(data);
  const { facts, emailRejected } = await saveFacts(db, ctx, incoming);
  const body: ToolResponseBody = {
    ok: true,
    status: "saved",
    data: { still_needed: stillNeeded(facts), email_valid: emailRejected ? false : undefined },
    instruction:
      "Facts saved. Keep the conversation natural: ask only for what is still_needed, one question at a time. Never ask for a budget. Never quote prices.",
  };
  if (emailRejected) body.say = "Could you spell that email address out for me, letter by letter?";
  if (incoming.asked_about_pricing === true) {
    body.data = { ...body.data, pricing_response: APPROVED_PRICING_RESPONSE };
    body.instruction += " The caller asked about pricing: use pricing_response verbatim, never a figure.";
  }
  return reply(body);
}

async function evaluate(db: Db, ctx: CallContext, data: Record<string, unknown>, config: Awaited<ReturnType<typeof getQualificationConfig>>): Promise<ToolResult> {
  const incoming = enquiryFactsSchema.parse(data);
  const hasNew = Object.values(incoming).some((v) => v !== null);
  let current = ctx;
  if (hasNew) {
    const saved = await saveFacts(db, ctx, incoming);
    current = { ...ctx, enquiry: saved.enquiry };
  }
  const out = await evaluateAndPersist(db, current);
  const r = out.result;
  const pricing = current.enquiry.facts.asked_about_pricing === true || incoming.asked_about_pricing === true;
  const pricingData = pricing ? { pricing_response: APPROVED_PRICING_RESPONSE } : {};

  switch (r.disposition) {
    case "qualified":
      return reply({
        ok: true, status: "qualified", next_action: "ask_availability",
        say: pricing ? APPROVED_PRICING_RESPONSE : undefined,
        data: { ...pricingData, notes_for_agent: r.caveats.length ? "Some details are still unconfirmed; do not push the caller for them." : undefined },
        instruction:
          "The enquiry qualifies. Tell the caller it sounds like a good fit, then ask when they are free for a consultation with one of the designers (days and rough times) and confirm their email address for the calendar invitation. Then call get_available_slots. Do not promise anything before the server confirms a booking.",
      });
    case "clarification_required":
      return reply({
        ok: true, status: "clarification_required", next_action: "ask_question", say: r.nextQuestion ?? undefined,
        data: pricingData, instruction: "Ask exactly this one question, then save the answer and evaluate again. Do not offer a consultation yet.",
      });
    case "rejected":
      return reply({
        ok: true, status: "rejected", next_action: "close_call_politely", say: r.closingScript ?? undefined, data: pricingData,
        instruction: "Say the closing line, thank the caller, and end the call kindly. Do NOT offer or book a consultation. Do not suggest what price or budget would work.",
      });
    case "human_escalation": {
      const complaint = r.escalation?.kind === "existing_customer_complaint" || r.escalation?.kind === "frustrated_returning_lead" || r.escalation?.kind === "senior_requested";
      return reply({
        ok: true, status: "human_escalation", next_action: "reassure_and_end_call",
        say: complaint ? escalationAgentLine(config.escalation.callbackPromiseMinutes) : BORDERLINE_AGENT_LINE,
        data: { escalation_id: out.escalationId },
        instruction: "Do not try to resolve the issue or book a consultation. Take any missing contact detail, say the line, and end the call kindly.",
      });
    }
  }
}

function slotsToReply(o: SlotsOutcome): ToolResult {
  switch (o.status) {
    case "slots": {
      const list = o.slots.map((s) => `option ${s.option}: ${s.spoken}`).join("; ");
      return reply({
        ok: true, status: "slots_available", next_action: "offer_slots_and_get_confirmation",
        data: { slots: o.slots.map((s) => ({ option: s.option, spoken: s.spoken })), window_expanded: o.windowExpanded, timezone: o.timezone },
        say: `I can offer ${o.slots.map((s) => s.spoken).join(", or ")}. Which of these works best for you?`,
        instruction: `${o.windowExpanded ? "Nothing matched the requested window, so these are the nearest alternatives; say so. " : ""}Read the options naturally (${list}). Only these times exist - never invent another. Wait for the caller to choose and clearly say yes, repeat the chosen time back, then call book_consultation with that option, customer_confirmed=true and the caller's own words in customer_confirmation_quote.`,
      });
    }
    case "no_slots":
      return reply({
        ok: true, status: "no_slots", next_action: "ask_another_window",
        say: "I don't see an opening in that window. Could you suggest another day or time range that would suit you?",
        instruction: "Ask for a different window, then call get_available_slots again. Do not invent availability.",
      });
    case "not_bookable":
      return reply({
        ok: false, status: "not_bookable", next_action: "do_not_book", error: { code: "not_bookable", message: o.reason },
        instruction: "This enquiry is not qualified for a consultation booking. Do not offer or promise one. Call evaluate_qualification if facts changed.",
      });
    case "no_designer":
      return reply({
        ok: false, status: "no_designer_configured", next_action: "take_preferred_times",
        say: "I'll note your preferred times and a colleague will confirm the consultation with you shortly.",
        error: { code: "no_designer", message: "No designer with a Calendly event type is configured" },
      });
    case "calendar_unavailable":
      return reply({
        ok: false, status: "calendar_unavailable", next_action: "take_preferred_times", data: { escalated: true },
        say: "I'm having trouble reaching the calendar right now. I'll note your preferred days and times, and a colleague will confirm the consultation with you shortly.",
        error: { code: "calendar_unavailable", message: "Calendar could not be reached" },
        instruction: "A human has been alerted. Do not claim a booking exists.",
      });
  }
}

async function slots(db: Db, ctx: CallContext, data: Record<string, unknown>): Promise<ToolResult> {
  const str = (k: string) => (typeof data[k] === "string" ? (data[k] as string) : null);
  const iso = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? v.trim() : null);
  const tod = str("time_of_day")?.toLowerCase();
  const outcome = await getAvailableSlots(db, ctx, {
    dateFrom: iso(str("date_from")), dateTo: iso(str("date_to")),
    timeOfDay: (tod === "morning" || tod === "afternoon" || tod === "evening" ? tod : "any") as TimeOfDay,
    timezone: str("timezone"),
  });
  return slotsToReply(outcome);
}

async function book(db: Db, ctx: CallContext, data: Record<string, unknown>): Promise<ToolResult> {
  const num = requireNumber(typeof data.slot_option === "string" || typeof data.slot_option === "number" ? String(data.slot_option) : undefined);
  const confirmed = ((): boolean | null => {
    const v = data.customer_confirmed;
    if (v === true || v === "true" || v === "yes") return true;
    if (v === false || v === "false" || v === "no") return false;
    return null;
  })();
  const text = (k: string) => (typeof data[k] === "string" && (data[k] as string).trim() ? (data[k] as string).trim().slice(0, 300) : null);

  const out = await bookConsultation(db, ctx, {
    slotOption: num, slotToken: text("slot_token"), customerConfirmed: confirmed, confirmationQuote: text("customer_confirmation_quote"),
    inviteeName: text("invitee_name"), inviteeEmail: text("invitee_email"),
  });

  switch (out.status) {
    case "booked":
      return reply({
        ok: true, status: "booked", next_action: "confirm_and_close",
        data: { booked: true, when: out.spoken, designer: out.designerName, timezone: out.timezone, already_booked: out.alreadyBooked },
        say: `Your consultation with ${out.designerName} is booked for ${out.spoken}. A confirmation and calendar invitation will be sent to your email address.`,
        instruction: "Booking is verified by the calendar system. Confirm it, ask if they have any other question (do not quote prices), and close the call warmly.",
      });
    case "needs_info": {
      const m = out.missing[0];
      const say =
        m === "email" ? "Could you tell me your email address for the calendar invitation? Please spell it out slowly."
        : m === "name" ? "May I have your full name for the booking?"
        : m === "customer_confirmation" ? "Just to be sure — shall I go ahead and book that time for you?"
        : m === "site_address" ? "Could you tell me the address of the property so the designer can plan the visit?"
        : "Which of the times I mentioned would you like?";
      return reply({
        ok: false, status: "needs_info", next_action: "ask_missing_detail", say, data: { missing: out.missing },
        instruction: "Nothing has been booked. Collect the missing item, then call book_consultation again. For email, read it back letter by letter to confirm.",
      });
    }
    case "slot_expired":
      return reply({
        ok: false, status: "slot_expired", next_action: "call_get_available_slots",
        instruction: "Those options have expired or were not offered. Call get_available_slots again before booking. Nothing has been booked.",
      });
    case "slot_unavailable": {
      const alt = slotsToReply(out.alternatives);
      alt.body.status = out.alternatives.status === "slots" ? "slot_taken_alternatives" : alt.body.status;
      alt.body.say = out.alternatives.status === "slots" ? `I'm sorry, that time has just been taken. ${alt.body.say}` : alt.body.say;
      alt.body.data = { ...alt.body.data, booked: false };
      return alt;
    }
    case "not_bookable":
      return reply({
        ok: false, status: "not_bookable", next_action: "do_not_book", error: { code: "not_bookable", message: out.reason },
        instruction: "This enquiry is not qualified for a consultation booking. Nothing has been booked.",
      });
    case "failed":
    case "unconfirmed":
      return reply({
        ok: false, status: out.status === "failed" ? "booking_failed" : "booking_unconfirmed", next_action: "reassure_and_end_call",
        say: BOOKING_FAILURE_AGENT_LINE, data: { booked: false, human_follow_up: true },
        error: { code: out.status === "failed" ? out.code : "unconfirmed", message: "Booking could not be completed" },
        instruction: "Do NOT say the consultation is booked. A human has been alerted and will confirm with the caller.",
      });
  }
}

const ESCALATION_REASONS: Record<string, { kind: EscalationKind; flag: Partial<EnquiryFacts> }> = {
  complaint: { kind: "existing_customer_complaint", flag: { existing_customer_complaint: true } },
  existing_customer_issue: { kind: "existing_customer_complaint", flag: { existing_customer_complaint: true } },
  senior_requested: { kind: "senior_requested", flag: { requests_senior: true } },
  frustrated: { kind: "frustrated_returning_lead", flag: { caller_frustrated: true } },
  missed_followup: { kind: "frustrated_returning_lead", flag: { missed_followup: true, caller_frustrated: true } },
  other: { kind: "borderline_review", flag: {} },
};

async function escalate(db: Db, ctx: CallContext, data: Record<string, unknown>, config: Awaited<ReturnType<typeof getQualificationConfig>>): Promise<ToolResult> {
  const reasonKey = typeof data.reason === "string" ? data.reason.trim().toLowerCase().replace(/[\s-]+/g, "_") : "other";
  const spec = ESCALATION_REASONS[reasonKey] ?? ESCALATION_REASONS.other!;
  const details = typeof data.details === "string" ? data.details.trim().slice(0, 500) : "";
  const incoming = enquiryFactsSchema.parse({ ...data, ...spec.flag });
  await saveFacts(db, ctx, incoming);

  const urgent = spec.kind !== "borderline_review";
  const e = await createEscalation(db, {
    enquiryId: ctx.enquiry.id, callId: ctx.call.id, kind: spec.kind, urgency: urgent ? "high" : "normal", mode: ctx.call.mode,
    reason: `Raised by the voice agent during the call (${reasonKey}).${details ? ` Caller said: "${details}"` : ""}`,
    requestedResponse: urgent ? "Senior person to call the caller back promptly." : "Review and decide.",
  });
  await advanceThrough(db, ctx.call.id, ["agent_active", "human_escalation"]);
  await transitionCall(db, ctx.call.id, "human_escalation");
  await logCallEvent(db, ctx.call.id, "escalated_by_agent", { reason: reasonKey, created: e.created });
  await db.update(calls).set({ updatedAt: new Date() }).where(eq(calls.id, ctx.call.id));

  return reply({
    ok: true, status: "escalated", next_action: "reassure_and_end_call", data: { escalation_id: e.id, created: e.created },
    say: urgent ? escalationAgentLine(config.escalation.callbackPromiseMinutes) : BORDERLINE_AGENT_LINE,
    instruction: "Do not try to resolve the matter, book anything, or quote prices. Confirm the best callback number, say the line, and end kindly.",
  });
}

