import { randomUUID } from "node:crypto";
import { startOfDayUtc, addDaysIso, isoDateInZone, zonedParts } from "../../time";
import {
  CalendlyError,
  type AvailableSlot,
  type CalendlyClient,
  type CreateInviteeInput,
  type CreatedBooking,
  type EventTypeInfo,
  type ScheduledEventLite,
} from "./types";

export type MockBookingFailure = "slot_unavailable" | "timeout_not_created" | "timeout_but_created" | "forbidden" | "server_error";

interface MockBooking {
  eventUri: string;
  inviteeUri: string;
  eventTypeUri: string;
  startTime: string;
  email: string;
}

interface MockState {
  bookings: MockBooking[];
  failNext: MockBookingFailure | null;
  createCalls: number;
  listCalls: number;
}

const g = globalThis as unknown as { __mockCalendly?: MockState };
const state = (): MockState => (g.__mockCalendly ??= { bookings: [], failNext: null, createCalls: 0, listCalls: 0 });

/** Simulated Calendly. Slots are generated, not real; every response is labelled by mode "mock" upstream. */
export class MockCalendlyClient implements CalendlyClient {
  readonly mode = "mock" as const;

  static reset() {
    g.__mockCalendly = { bookings: [], failNext: null, createCalls: 0, listCalls: 0 };
  }
  static failNext(kind: MockBookingFailure | null) {
    state().failNext = kind;
  }
  static get stats() {
    const s = state();
    return { bookings: [...s.bookings], createCalls: s.createCalls, listCalls: s.listCalls };
  }
  /** Simulate another customer grabbing a slot between "offer" and "book". */
  static takeSlot(eventTypeUri: string, startTime: string) {
    state().bookings.push({ eventUri: `https://api.calendly.com/scheduled_events/${randomUUID()}`, inviteeUri: "x", eventTypeUri, startTime, email: "other@example.invalid" });
  }

  async getEventType(uri: string): Promise<EventTypeInfo> {
    return { uri, name: "Design consultation (simulated)", durationMinutes: 45, poolingType: null, active: true, schedulingUrl: null, locations: [] };
  }

  async listAvailableTimes(input: { eventTypeUri: string; start: Date; end: Date }): Promise<AvailableSlot[]> {
    const s = state();
    s.listCalls++;
    const out: AvailableSlot[] = [];
    const tz = "Asia/Kolkata";
    const first = isoDateInZone(new Date(Math.max(input.start.getTime(), Date.now())), tz);
    // Offered local hours (IST): 11:00, 12:00, 15:00, 16:30, 17:30. Sundays closed.
    const hours: Array<[number, number]> = [[11, 0], [12, 0], [15, 0], [16, 30], [17, 30]];
    for (let d = 0; d < 31; d++) {
      const day = addDaysIso(first, d);
      const base = startOfDayUtc(day, tz);
      if (zonedParts(new Date(base.getTime() + 6 * 3600_000), tz).weekday === 0) continue;
      for (const [h, m] of hours) {
        const t = new Date(base.getTime() + (h * 60 + m) * 60_000);
        if (t < input.start || t > input.end || t.getTime() < Date.now() + 3600_000) continue;
        const iso = t.toISOString();
        if (s.bookings.some((b) => b.eventTypeUri === input.eventTypeUri && Date.parse(b.startTime) === t.getTime())) continue;
        out.push({ startTime: iso, invitesRemaining: 1, schedulingUrl: "https://calendly.example.invalid/simulated" });
      }
    }
    return out;
  }

  async createInvitee(input: CreateInviteeInput): Promise<CreatedBooking> {
    const s = state();
    s.createCalls++;
    const fail = s.failNext;
    s.failNext = null;
    const make = (): CreatedBooking => {
      const booking: MockBooking = {
        eventUri: `https://api.calendly.com/scheduled_events/${randomUUID()}`,
        inviteeUri: `https://api.calendly.com/invitees/${randomUUID()}`,
        eventTypeUri: input.eventTypeUri, startTime: input.startTime, email: input.invitee.email,
      };
      s.bookings.push(booking);
      return {
        inviteeUri: booking.inviteeUri, eventUri: booking.eventUri, status: "active", email: input.invitee.email,
        timezone: input.invitee.timezone, cancelUrl: "https://calendly.example.invalid/cancel", rescheduleUrl: "https://calendly.example.invalid/reschedule",
        startTime: input.startTime, endTime: new Date(Date.parse(input.startTime) + 45 * 60_000).toISOString(),
        hostName: "Simulated Designer", hostEmail: null,
      };
    };

    if (fail === "slot_unavailable") throw new CalendlyError("slot_unavailable", "mock: requested time is no longer available", 409);
    if (fail === "forbidden") throw new CalendlyError("forbidden", "mock: forbidden (paid plan required)", 403);
    if (fail === "server_error") throw new CalendlyError("server_error", "mock: Calendly 500", 500);
    if (fail === "timeout_not_created") throw new CalendlyError("timeout", "mock: request timed out");
    if (fail === "timeout_but_created") {
      make();
      throw new CalendlyError("timeout", "mock: request timed out after Calendly created the event");
    }
    if (s.bookings.some((b) => b.eventTypeUri === input.eventTypeUri && Date.parse(b.startTime) === Date.parse(input.startTime))) {
      throw new CalendlyError("slot_unavailable", "mock: requested time is no longer available", 409);
    }
    return make();
  }

  async findScheduledEvent(input: { inviteeEmail: string; startTime: string }): Promise<ScheduledEventLite | null> {
    const hit = state().bookings.find((b) => b.email === input.inviteeEmail && Date.parse(b.startTime) === Date.parse(input.startTime));
    return hit ? { eventUri: hit.eventUri, startTime: hit.startTime, endTime: null, status: "active", inviteeUri: hit.inviteeUri } : null;
  }

  async health() {
    return { ok: true, detail: "mock client (simulated availability; no real bookings are created)" };
  }
}
