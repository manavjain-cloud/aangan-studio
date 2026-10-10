import { and, desc, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { bookingAttempts, bookings, calls as callsT, contacts as contactsT, enquiries, integrationEvents, offeredSlots, teamMembers } from "../db/schema";
import { getCalendly } from "../integrations";
import { CalendlyError, type AvailableSlot, type CalendlyClient } from "../integrations/calendly/types";
import { getEnv } from "../env";
import { createLogger } from "../logging/logger";
import { randomToken, sha256Hex } from "../security/hmac";
import { addDaysIso, isoDateInZone, speakableSlot, startOfDayUtc, zonedParts, DEFAULT_TZ } from "../time";
import { createEscalation } from "./escalations";
import { normalizeEmail, type CallContext } from "./ingest";
import { queueEmail } from "./notifications";
import { enqueue } from "./outbox";
import { eligibleDesigners, type TeamMember } from "./team";
import { advanceThrough, logCallEvent, transitionCall } from "./workflow";
import { latestResult } from "./qualify";

const log = createLogger("booking");

export type TimeOfDay = "morning" | "afternoon" | "evening" | "any";

export interface SlotQuery {
  dateFrom?: string | null;
  dateTo?: string | null;
  timeOfDay?: TimeOfDay | null;
  timezone?: string | null;
}

export interface OfferedSlot {
  option: number;
  token: string;
  spoken: string;
  startTimeUtc: string;
}

export type SlotsOutcome =
  | { status: "slots"; slots: OfferedSlot[]; designerName: string; windowExpanded: boolean; timezone: string }
  | { status: "no_slots"; timezone: string }
  | { status: "not_bookable"; reason: string }
  | { status: "no_designer" }
  | { status: "calendar_unavailable"; error: string; escalationId: string | null };

export type BookingOutcome =
  | { status: "booked"; spoken: string; designerName: string; startTimeUtc: string; timezone: string; alreadyBooked: boolean; inviteeEmail: string }
  | { status: "needs_info"; missing: Array<"email" | "name" | "customer_confirmation" | "slot_selection" | "site_address"> }
  | { status: "slot_expired" }
  | { status: "slot_unavailable"; alternatives: SlotsOutcome }
  | { status: "not_bookable"; reason: string }
  | { status: "failed"; code: string; escalationId: string | null }
  | { status: "unconfirmed"; escalationId: string | null };

const SLOT_TTL_MS = 20 * 60_000;
const MIN_LEAD_MS = 2 * 3600_000;

/* ----------------------------------------------------------------- gate */

/** A booking may only proceed for a lead that the rules (or a recorded human override) have qualified. */
export async function bookableGate(db: Db, ctx: CallContext): Promise<{ ok: true } | { ok: false; reason: string }> {
  const [enq] = await db.select().from(enquiries).where(eq(enquiries.id, ctx.enquiry.id)).limit(1);
  if (!enq) return { ok: false, reason: "enquiry_missing" };
  const latest = await latestResult(db, enq.id);
  if (enq.overridden && enq.disposition === "qualified") return { ok: true };
  if (!latest) return { ok: false, reason: "not_yet_evaluated" };
  if (latest.disposition !== "qualified" || !latest.canBook) return { ok: false, reason: `disposition_${latest.disposition}` };
  if (enq.disposition !== "qualified") return { ok: false, reason: `disposition_${enq.disposition}` };
  return { ok: true };
}

/* ---------------------------------------------------------------- slots */

function timeOfDayOk(start: Date, tod: TimeOfDay, tz: string): boolean {
  if (tod === "any") return true;
  const h = zonedParts(start, tz).hour;
  return tod === "morning" ? h < 12 : tod === "afternoon" ? h >= 12 && h < 17 : h >= 17;
}

function pickSpread(slots: AvailableSlot[], tz: string, max = 3): AvailableSlot[] {
  const picked: AvailableSlot[] = [];
  const seenDays = new Set<string>();
  for (const s of slots) {
    const day = isoDateInZone(new Date(s.startTime), tz);
    if (seenDays.has(day)) continue;
    seenDays.add(day);
    picked.push(s);
    if (picked.length === max) return picked;
  }
  for (const s of slots) {
    if (picked.length === max) break;
    if (!picked.includes(s)) picked.push(s);
  }
  return picked.sort((a, b) => a.startTime.localeCompare(b.startTime));
}

async function fetchWindow(cal: CalendlyClient, designer: TeamMember, from: Date, to: Date): Promise<AvailableSlot[]> {
  return cal.listAvailableTimes({ eventTypeUri: designer.calendlyEventTypeUri!, start: from, end: to });
}

export async function getAvailableSlots(db: Db, ctx: CallContext, q: SlotQuery, now: Date = new Date()): Promise<SlotsOutcome> {
  const gate = await bookableGate(db, ctx);
  if (!gate.ok) return { status: "not_bookable", reason: gate.reason };

  await advanceThrough(db, ctx.call.id, ["qualified", "asking_availability", "checking_calendar"]);

  const tz = q.timezone && /^[A-Za-z_]+\/[A-Za-z_\-/]+$/.test(q.timezone) ? q.timezone : DEFAULT_TZ;
  const todayIso = isoDateInZone(now, tz);
  const fromIso = q.dateFrom && q.dateFrom >= todayIso ? q.dateFrom : todayIso;
  const toIso = q.dateTo && q.dateTo >= fromIso ? q.dateTo : addDaysIso(fromIso, 7);
  const tod: TimeOfDay = q.timeOfDay ?? "any";

  const designers = await eligibleDesigners(db, ctx.enquiry.facts.project_type);
  if (designers.length === 0) return { status: "no_designer" };

  let cal: CalendlyClient;
  try {
    cal = getCalendly();
  } catch (err) {
    return calendarDown(db, ctx, String((err as Error).message));
  }

  const earliest = new Date(now.getTime() + MIN_LEAD_MS);
  let chosen: { designer: TeamMember; slots: AvailableSlot[] } | null = null;
  let expanded = false;

  try {
    for (const widen of [false, true]) {
      const fromD = startOfDayUtc(fromIso, tz);
      const toD = startOfDayUtc(addDaysIso(widen ? addDaysIso(toIso, 7) : toIso, 1), tz);
      for (const d of designers.slice(0, 3)) {
        const raw = await fetchWindow(cal, d, new Date(Math.max(fromD.getTime(), earliest.getTime())), toD);
        const ok = raw
          .filter((s) => new Date(s.startTime) >= earliest && timeOfDayOk(new Date(s.startTime), tod, tz))
          .sort((a, b) => a.startTime.localeCompare(b.startTime));
        if (ok.length) {
          chosen = { designer: d, slots: ok };
          expanded = widen;
          break;
        }
      }
      if (chosen) break;
    }
  } catch (err) {
    const msg = err instanceof CalendlyError ? `${err.code}: ${err.message}` : String((err as Error)?.message ?? err);
    log.warn("calendly availability failed", { callId: ctx.call.id, error: msg });
    return calendarDown(db, ctx, msg);
  }

  if (!chosen) {
    await transitionCall(db, ctx.call.id, "asking_availability", { reason: "no_matching_slots" });
    return { status: "no_slots", timezone: tz };
  }

  const picks = pickSpread(chosen.slots, tz, 3);
  // Retire any previous offer for this call so an old option number can never be booked by mistake.
  await db.update(offeredSlots).set({ status: "expired" }).where(and(eq(offeredSlots.callId, ctx.call.id), eq(offeredSlots.status, "offered")));
  const offered: OfferedSlot[] = [];
  for (const [i, s] of picks.entries()) {
    const token = randomToken(4).replace(/[-_]/g, "x").slice(0, 5).toUpperCase();
    await db.insert(offeredSlots).values({
      token, callId: ctx.call.id, enquiryId: ctx.enquiry.id, designerId: chosen.designer.id, eventTypeUri: chosen.designer.calendlyEventTypeUri!,
      startTime: new Date(s.startTime), customerTimezone: tz, expiresAt: new Date(now.getTime() + SLOT_TTL_MS), mode: cal.mode === "live" ? "live" : "mock",
    });
    offered.push({ option: i + 1, token, spoken: speakableSlot(new Date(s.startTime), tz, now), startTimeUtc: s.startTime });
  }
  await db.update(enquiries).set({ assignedDesignerId: chosen.designer.id, updatedAt: new Date() }).where(eq(enquiries.id, ctx.enquiry.id));
  await advanceThrough(db, ctx.call.id, ["awaiting_customer_confirmation"]);
  await logCallEvent(db, ctx.call.id, "slots_offered", { count: offered.length, designerId: chosen.designer.id, windowExpanded: expanded, mode: cal.mode });

  return { status: "slots", slots: offered, designerName: chosen.designer.name, windowExpanded: expanded, timezone: tz };
}

async function calendarDown(db: Db, ctx: CallContext, error: string): Promise<SlotsOutcome> {
  await logCallEvent(db, ctx.call.id, "calendar_unavailable", { error });
  const e = await createEscalation(db, {
    enquiryId: ctx.enquiry.id, callId: ctx.call.id, kind: "booking_failure", urgency: "normal", mode: ctx.call.mode,
    reason: `The calendar could not be reached while offering consultation times (${error}). The caller was qualified; arrange the consultation manually.`,
    requestedResponse: "Call the customer back to arrange a consultation time.",
  });
  await db.insert(integrationEvents).values({
    integration: "calendly", direction: "outbound", eventType: "availability_failed", status: "failed", error: error.slice(0, 400),
  });
  return { status: "calendar_unavailable", error, escalationId: e.id };
}

/* -------------------------------------------------------------- booking */

export interface BookInput {
  slotOption?: number | null;
  slotToken?: string | null;
  customerConfirmed: boolean | null;
  confirmationQuote: string | null;
  inviteeName?: string | null;
  inviteeEmail?: string | null;
  now?: Date;
}

async function resolveSlot(db: Db, ctx: CallContext, input: BookInput, now: Date) {
  const rows = await db
    .select()
    .from(offeredSlots)
    .where(and(eq(offeredSlots.callId, ctx.call.id), ne(offeredSlots.status, "expired")))
    .orderBy(offeredSlots.startTime);
  const live = rows.filter((r) => r.status === "offered" || r.status === "booked");
  const tok = input.slotToken?.trim().toUpperCase();
  let slot = tok ? live.find((r) => r.token === tok) : undefined;
  if (!slot && input.slotOption && input.slotOption >= 1) slot = live[input.slotOption - 1];
  if (!slot && !input.slotToken && !input.slotOption && live.length === 1) slot = live[0];
  return { slot, expired: slot ? slot.status === "offered" && slot.expiresAt < now : false, anyOffered: live.length > 0 };
}

async function resolveLocation(cal: CalendlyClient, eventTypeUri: string, ctx: CallContext, phone: string | null) {
  const info = await cal.getEventType(eventTypeUri);
  if (info.poolingType === "round_robin") return { loc: undefined as undefined | { kind: string; location?: string } };
  const l = info.locations[0];
  if (!l) return { loc: undefined };
  switch (l.kind) {
    case "physical":
    case "custom":
      return { loc: { kind: l.kind, location: l.location ?? getEnv().CALENDLY_LOCATION_TEXT ?? undefined } };
    case "ask_invitee": {
      const site = ctx.enquiry.facts.location_text;
      return site ? { loc: { kind: l.kind, location: site } } : { needs: "site_address" as const };
    }
    case "outbound_call":
      return phone ? { loc: { kind: l.kind, location: phone } } : { needs: "site_address" as const };
    default:
      return { loc: { kind: l.kind, ...(l.location ? { location: l.location } : {}) } };
  }
}

async function finalizeConfirmed(
  db: Db,
  ctx: CallContext,
  attemptId: string,
  slot: typeof offeredSlots.$inferSelect,
  designer: TeamMember | null,
  created: { eventUri: string; inviteeUri: string | null; startTime: string; endTime: string | null; cancelUrl: string | null; rescheduleUrl: string | null },
  mode: "live" | "mock",
) {
  const [row] = await db
    .insert(bookings)
    .values({
      attemptId, enquiryId: ctx.enquiry.id, designerId: slot.designerId, calendlyEventUri: created.eventUri, calendlyInviteeUri: created.inviteeUri,
      startTime: new Date(created.startTime), endTime: created.endTime ? new Date(created.endTime) : null, customerTimezone: slot.customerTimezone,
      designerTimezone: designer?.timezone ?? null, cancelUrl: created.cancelUrl, rescheduleUrl: created.rescheduleUrl, mode,
    })
    .onConflictDoNothing()
    .returning();
  await db.update(bookingAttempts).set({ status: "confirmed", error: null, updatedAt: new Date() }).where(eq(bookingAttempts.id, attemptId));
  await db.update(offeredSlots).set({ status: "booked" }).where(eq(offeredSlots.id, slot.id));
  await db.update(enquiries).set({ assignedDesignerId: slot.designerId, updatedAt: new Date() }).where(eq(enquiries.id, ctx.enquiry.id));
  await advanceThrough(db, ctx.call.id, ["booking_confirmed"]);
  await logCallEvent(db, ctx.call.id, "booking_confirmed", { eventUri: created.eventUri, mode });
  const key = row?.id ?? created.eventUri;
  await queueEmail(db, `handoff:${ctx.enquiry.id}:${key}`, { kind: "qualified_handoff", enquiryId: ctx.enquiry.id, callId: ctx.call.id });
  await enqueue(db, { type: "hubspot_sync", key: `hubspot:${ctx.enquiry.id}:booking:${key}`, payload: { enquiryId: ctx.enquiry.id } });
}

export async function bookConsultation(db: Db, ctx: CallContext, input: BookInput): Promise<BookingOutcome> {
  const now = input.now ?? new Date();

  const gate = await bookableGate(db, ctx);
  if (!gate.ok) return { status: "not_bookable", reason: gate.reason };

  // Hard server-side guard against the model skipping the customer's explicit yes.
  if (input.customerConfirmed !== true || !input.confirmationQuote || input.confirmationQuote.trim().length < 2) {
    return { status: "needs_info", missing: ["customer_confirmation"] };
  }
  const { slot, expired, anyOffered } = await resolveSlot(db, ctx, input, now);
  if (!slot) return anyOffered ? { status: "needs_info", missing: ["slot_selection"] } : { status: "slot_expired" };
  if (expired) return { status: "slot_expired" };

  const facts = ctx.enquiry.facts;
  const email = normalizeEmail(input.inviteeEmail ?? facts.caller_email);
  const name = (input.inviteeName ?? facts.caller_name ?? ctx.contact?.name ?? "").trim();
  const missing: Array<"email" | "name"> = [];
  if (!email) missing.push("email");
  if (!name) missing.push("name");
  if (missing.length) return { status: "needs_info", missing };

  const [designer] = await db.select().from(teamMembers).where(eq(teamMembers.id, slot.designerId)).limit(1);
  const idemKey = sha256Hex(`${ctx.call.id}|${slot.id}|${email}`);

  // Insert-or-load the attempt: the unique key makes a repeated request resolve to the same attempt.
  const inserted = await db
    .insert(bookingAttempts)
    .values({
      idempotencyKey: idemKey, enquiryId: ctx.enquiry.id, callId: ctx.call.id, designerId: slot.designerId, slotId: slot.id, startTime: slot.startTime,
      customerConfirmationQuote: input.confirmationQuote.slice(0, 300), mode: slot.mode,
    })
    .onConflictDoNothing({ target: bookingAttempts.idempotencyKey })
    .returning();
  let attempt = inserted[0];
  if (!attempt) {
    const [existing] = await db.select().from(bookingAttempts).where(eq(bookingAttempts.idempotencyKey, idemKey)).limit(1);
    attempt = existing!;
    if (attempt.status === "confirmed") {
      const [b] = await db.select().from(bookings).where(eq(bookings.attemptId, attempt.id)).limit(1);
      return {
        status: "booked", alreadyBooked: true, inviteeEmail: email!, designerName: designer?.name ?? "your designer",
        startTimeUtc: (b?.startTime ?? slot.startTime).toISOString(), timezone: slot.customerTimezone,
        spoken: speakableSlot(b?.startTime ?? slot.startTime, slot.customerTimezone, now),
      };
    }
    if (attempt.status === "slot_unavailable") {
      return { status: "slot_unavailable", alternatives: await getAvailableSlots(db, ctx, { timezone: slot.customerTimezone }, now) };
    }
    await db.update(bookingAttempts).set({ attemptCount: attempt.attemptCount + 1, status: "pending", updatedAt: new Date() }).where(eq(bookingAttempts.id, attempt.id));
  }

  let cal: CalendlyClient;
  try {
    cal = getCalendly();
  } catch (err) {
    return fail(db, ctx, attempt.id, "not_configured", String((err as Error).message), null);
  }

  // A previous attempt may have timed out after Calendly created the event: check before sending again.
  if (attempt.status === "unconfirmed" || attempt.status === "pending") {
    const found = await cal.findScheduledEvent({ inviteeEmail: email!, startTime: slot.startTime.toISOString() }).catch(() => null);
    if (found) {
      await finalizeConfirmed(db, ctx, attempt.id, slot, designer ?? null, { eventUri: found.eventUri, inviteeUri: found.inviteeUri, startTime: found.startTime, endTime: found.endTime, cancelUrl: null, rescheduleUrl: null }, cal.mode);
      return confirmedOutcome(slot, designer, email!, now, true);
    }
  }

  await advanceThrough(db, ctx.call.id, ["booking_calendar"]);

  let location: { kind: string; location?: string } | undefined;
  try {
    const r = await resolveLocation(cal, slot.eventTypeUri, ctx, ctx.call.fromNumber);
    if ("needs" in r && r.needs) return { status: "needs_info", missing: ["site_address"] };
    location = "loc" in r ? r.loc : undefined;
  } catch (err) {
    return fail(db, ctx, attempt.id, err instanceof CalendlyError ? err.code : "unknown", String((err as Error).message), err instanceof CalendlyError ? err.httpStatus ?? null : null);
  }

  try {
    const created = await cal.createInvitee({
      eventTypeUri: slot.eventTypeUri,
      startTime: slot.startTime.toISOString(),
      invitee: { name, email: email!, timezone: slot.customerTimezone },
      location,
      tracking: { utmSource: "aangan-voice-agent", utmCampaign: "phone-qualification" },
    });
    await finalizeConfirmed(db, ctx, attempt.id, slot, designer ?? null, { eventUri: created.eventUri, inviteeUri: created.inviteeUri, startTime: created.startTime, endTime: created.endTime, cancelUrl: created.cancelUrl, rescheduleUrl: created.rescheduleUrl }, cal.mode);
    return confirmedOutcome(slot, designer, email!, now, false);
  } catch (err) {
    const ce = err instanceof CalendlyError ? err : new CalendlyError("unknown", String((err as Error)?.message ?? err));

    if (ce.code === "slot_unavailable") {
      await db.update(bookingAttempts).set({ status: "slot_unavailable", error: ce.message, httpStatus: ce.httpStatus ?? null, updatedAt: new Date() }).where(eq(bookingAttempts.id, attempt.id));
      await db.update(offeredSlots).set({ status: "unavailable" }).where(eq(offeredSlots.id, slot.id));
      await logCallEvent(db, ctx.call.id, "slot_unavailable_at_booking", { slotId: slot.id });
      await transitionCall(db, ctx.call.id, "checking_calendar");
      return { status: "slot_unavailable", alternatives: await getAvailableSlots(db, ctx, { timezone: slot.customerTimezone }, now) };
    }

    if (ce.outcomeUnknown) {
      // Timeout / 5xx: the event may exist. Look before concluding anything, and NEVER blindly re-send.
      for (let i = 0; i < 2; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 700));
        const found = await cal.findScheduledEvent({ inviteeEmail: email!, startTime: slot.startTime.toISOString() }).catch(() => null);
        if (found) {
          await finalizeConfirmed(db, ctx, attempt.id, slot, designer ?? null, { eventUri: found.eventUri, inviteeUri: found.inviteeUri, startTime: found.startTime, endTime: found.endTime, cancelUrl: null, rescheduleUrl: null }, cal.mode);
          return confirmedOutcome(slot, designer, email!, now, true);
        }
      }
      await db.update(bookingAttempts).set({ status: "unconfirmed", error: ce.message, httpStatus: ce.httpStatus ?? null, updatedAt: new Date() }).where(eq(bookingAttempts.id, attempt.id));
      await transitionCall(db, ctx.call.id, "booking_failed", { code: ce.code });
      const esc = await createEscalation(db, {
        enquiryId: ctx.enquiry.id, callId: ctx.call.id, kind: "booking_failure", urgency: "high", mode: ctx.call.mode,
        reason: `Booking outcome could not be confirmed (${ce.code}) for ${slot.startTime.toISOString()}. Check Calendly for an existing event for this customer BEFORE booking again, to avoid a duplicate.`,
        requestedResponse: "Verify in Calendly, then confirm or re-book with the customer.",
      });
      await enqueue(db, { type: "booking_reconcile", key: `reconcile:${attempt.id}`, payload: { attemptId: attempt.id }, delaySec: 120, maxAttempts: 5 });
      await transitionCall(db, ctx.call.id, "human_escalation");
      return { status: "unconfirmed", escalationId: esc.id };
    }

    return fail(db, ctx, attempt.id, ce.code, ce.message, ce.httpStatus ?? null);
  }
}

function confirmedOutcome(slot: typeof offeredSlots.$inferSelect, designer: TeamMember | undefined | null, email: string, now: Date, already: boolean): BookingOutcome {
  return {
    status: "booked", alreadyBooked: already, inviteeEmail: email, designerName: designer?.name ?? "your designer",
    startTimeUtc: slot.startTime.toISOString(), timezone: slot.customerTimezone, spoken: speakableSlot(slot.startTime, slot.customerTimezone, now),
  };
}

async function fail(db: Db, ctx: CallContext, attemptId: string, code: string, message: string, httpStatus: number | null): Promise<BookingOutcome> {
  await db.update(bookingAttempts).set({ status: "failed", error: message.slice(0, 400), httpStatus, updatedAt: new Date() }).where(eq(bookingAttempts.id, attemptId));
  await transitionCall(db, ctx.call.id, "booking_failed", { code });
  const esc = await createEscalation(db, {
    enquiryId: ctx.enquiry.id, callId: ctx.call.id, kind: "booking_failure", urgency: "high", mode: ctx.call.mode,
    reason: `Consultation booking failed (${code}): ${message.slice(0, 200)}. The caller was qualified and expects a confirmation.`,
    requestedResponse: "Call the customer back and arrange the consultation manually.",
  });
  await transitionCall(db, ctx.call.id, "human_escalation");
  return { status: "failed", code, escalationId: esc.id };
}

/** Job handler: resolves a booking whose outcome was unknown by looking the event up in Calendly. */
export async function reconcileAttempt(db: Db, attemptId: string): Promise<"confirmed" | "still_unknown" | "skipped"> {
  const [attempt] = await db.select().from(bookingAttempts).where(eq(bookingAttempts.id, attemptId)).limit(1);
  if (!attempt || attempt.status === "confirmed") return "skipped";
  if (attempt.status !== "unconfirmed") return "skipped";
  const [slot] = attempt.slotId ? await db.select().from(offeredSlots).where(eq(offeredSlots.id, attempt.slotId)).limit(1) : [];
  const [enq] = await db.select().from(enquiries).where(eq(enquiries.id, attempt.enquiryId)).limit(1);
  if (!slot || !enq) return "skipped";
  const email = normalizeEmail(enq.facts.caller_email);
  if (!email) return "skipped";
  const cal = getCalendly();
  const found = await cal.findScheduledEvent({ inviteeEmail: email, startTime: slot.startTime.toISOString() });
  if (!found) return "still_unknown";
  const [call] = attempt.callId ? await db.select().from(callsT).where(eq(callsT.id, attempt.callId)).limit(1) : [];
  if (!call) return "skipped";
  const [contact] = call.contactId ? await db.select().from(contactsT).where(eq(contactsT.id, call.contactId)).limit(1) : [];
  const [designer] = await db.select().from(teamMembers).where(eq(teamMembers.id, slot.designerId)).limit(1);
  const ctx: CallContext = { call, enquiry: enq, contact: contact ?? null, createdNow: false };
  await finalizeConfirmed(db, ctx, attempt.id, slot, designer ?? null, { eventUri: found.eventUri, inviteeUri: found.inviteeUri, startTime: found.startTime, endTime: found.endTime, cancelUrl: null, rescheduleUrl: null }, cal.mode);
  return "confirmed";
}

export async function latestBookingFor(db: Db, enquiryId: string) {
  const [b] = await db.select().from(bookings).where(and(eq(bookings.enquiryId, enquiryId), eq(bookings.status, "confirmed"))).orderBy(desc(bookings.createdAt)).limit(1);
  return b ?? null;
}

