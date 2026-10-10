import "server-only";
import { HttpError, NetworkError, httpJson } from "../http";
import {
  CalendlyError,
  type AvailableSlot,
  type CalendlyClient,
  type CreateInviteeInput,
  type CreatedBooking,
  type EventTypeInfo,
  type ScheduledEventLite,
} from "../calendly/types";

/**
 * Cal.com API v2 client (https://cal.com/docs/api-reference/v2, OpenAPI read 2026-10-10). Implements the same
 * calendar interface as the Calendly client, so booking logic is provider-independent.
 *
 *  - Auth: `Authorization: Bearer <API key>` (key from Settings -> Security; free plans can create one).
 *  - GET  /v2/slots            (cal-api-version 2024-09-04)  -> { data: { "YYYY-MM-DD": [{ start }] } }
 *  - POST /v2/bookings         (cal-api-version 2026-02-25)  -> creates the booking; Cal.com emails attendee and host
 *  - GET  /v2/bookings?attendeeEmail=...  (2026-05-01)       -> look-up used to resolve unknown outcomes
 *  - GET  /v2/event-types/{id} (2026-06-12), GET /v2/me (health)
 * The "event type reference" we store per designer is `calcom:<eventTypeId>` (a bare number is also accepted).
 * Cal.com documents no idempotency key for bookings, so, as with Calendly, a booking is NEVER blindly re-sent.
 */

const BASE = "https://api.cal.com";
const V_SLOTS = "2024-09-04";
const V_BOOKINGS = "2026-02-25";
const V_BOOKINGS_LIST = "2026-05-01";
const V_EVENT_TYPES = "2026-06-12";

export function parseEventTypeId(ref: string): number {
  const m = /^(?:calcom:)?(\d+)$/.exec(ref.trim());
  if (!m) throw new CalendlyError("invalid_request", `Not a Cal.com event type reference: ${ref}`);
  return Number(m[1]);
}

function mapError(err: unknown, what: string): CalendlyError {
  if (err instanceof CalendlyError) return err;
  if (err instanceof NetworkError) return new CalendlyError(err.timedOut ? "timeout" : "server_error", `${what}: ${err.message}`);
  if (err instanceof HttpError) {
    const body = err.body.toLowerCase();
    switch (err.status) {
      case 400:
      case 409:
        if (/no longer|not available|unavailable|already (has|booked)|conflict|busy|slot/.test(body)) {
          return new CalendlyError("slot_unavailable", `${what}: the requested time is no longer available`, err.status);
        }
        return new CalendlyError("invalid_request", `${what}: ${err.body.slice(0, 200)}`, err.status);
      case 401:
        return new CalendlyError("unauthorized", `${what}: Cal.com rejected the API key`, err.status);
      case 403:
        return new CalendlyError("forbidden", `${what}: forbidden (check the API key's permissions)`, err.status);
      case 404:
        return new CalendlyError("not_found", `${what}: event type or booking not found`, err.status);
      case 429:
        return new CalendlyError("rate_limited", `${what}: rate limited (120 requests/minute per API key)`, err.status);
      default:
        return new CalendlyError(err.status >= 500 ? "server_error" : "unknown", `${what}: HTTP ${err.status}`, err.status);
    }
  }
  return new CalendlyError("unknown", `${what}: ${String((err as Error)?.message ?? err)}`);
}

interface Envelope<T> {
  status?: string;
  data: T;
}

interface CalBooking {
  uid: string;
  status: string;
  start: string;
  end?: string;
  hosts?: Array<{ name?: string; email?: string }>;
  attendees?: Array<{ email?: string }>;
}

export class LiveCalcomClient implements CalendlyClient {
  readonly mode = "live" as const;
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers(version: string) {
    return { Authorization: `Bearer ${this.apiKey}`, "cal-api-version": version };
  }

  async getEventType(ref: string): Promise<EventTypeInfo> {
    const id = parseEventTypeId(ref);
    try {
      const { data } = await httpJson<Envelope<{ id: number; title?: string; lengthInMinutes?: number; locations?: Array<{ type?: string }>; schedulingType?: string | null }>>({
        integration: "calcom", url: `${BASE}/v2/event-types/${id}`, headers: this.headers(V_EVENT_TYPES), retries: 2, timeoutMs: 6_000, fetchImpl: this.fetchImpl,
      });
      const e = data.data;
      // Only locations that need the CALLER's input matter for booking; the rest are owned by the host and applied by Cal.com.
      const locations = (e.locations ?? []).flatMap((l) =>
        l.type === "attendeeAddress" ? [{ kind: "ask_invitee" }] : l.type === "attendeePhone" ? [{ kind: "outbound_call" }] : [],
      );
      return { uri: ref, name: e.title ?? `Event type ${id}`, durationMinutes: e.lengthInMinutes ?? null, poolingType: e.schedulingType ?? null, active: true, schedulingUrl: null, locations };
    } catch (err) {
      throw mapError(err, "get event type");
    }
  }

  async listAvailableTimes(input: { eventTypeUri: string; start: Date; end: Date }): Promise<AvailableSlot[]> {
    const id = parseEventTypeId(input.eventTypeUri);
    const start = new Date(Math.max(input.start.getTime(), Date.now() + 60_000));
    if (input.end <= start) return [];
    try {
      const { data } = await httpJson<Envelope<Record<string, Array<{ start: string }>>>>({
        integration: "calcom", url: `${BASE}/v2/slots`, headers: this.headers(V_SLOTS),
        query: { eventTypeId: id, start: start.toISOString(), end: input.end.toISOString(), timeZone: "UTC" },
        retries: 2, timeoutMs: 6_000, fetchImpl: this.fetchImpl,
      });
      const out: AvailableSlot[] = [];
      for (const day of Object.values(data.data ?? {})) {
        for (const s of day) {
          const t = new Date(s.start);
          if (!Number.isNaN(t.getTime())) out.push({ startTime: t.toISOString(), invitesRemaining: 1, schedulingUrl: "" });
        }
      }
      return out.sort((a, b) => a.startTime.localeCompare(b.startTime));
    } catch (err) {
      throw mapError(err, "list available times");
    }
  }

  async createInvitee(input: CreateInviteeInput): Promise<CreatedBooking> {
    const eventTypeId = parseEventTypeId(input.eventTypeUri);
    let location: Record<string, string> | undefined;
    if (input.location?.kind === "ask_invitee" && input.location.location) location = { type: "attendeeAddress", address: input.location.location };
    if (input.location?.kind === "outbound_call" && input.location.location) location = { type: "attendeePhone", phone: input.location.location };

    const body = {
      start: new Date(input.startTime).toISOString(),
      eventTypeId,
      attendee: {
        name: input.invitee.name,
        email: input.invitee.email,
        timeZone: input.invitee.timezone,
        language: "en",
        ...(input.invitee.textReminderNumber ? { phoneNumber: input.invitee.textReminderNumber } : {}),
      },
      ...(location ? { location } : {}),
      metadata: { source: "aangan-voice-agent" },
    };
    try {
      const { data } = await httpJson<Envelope<CalBooking>>({
        integration: "calcom", url: `${BASE}/v2/bookings`, method: "POST", headers: this.headers(V_BOOKINGS), body,
        retries: 0, timeoutMs: 9_000, fetchImpl: this.fetchImpl,
      });
      const b = data.data;
      if (!b?.uid) throw new CalendlyError("server_error", "create booking: response had no booking uid");
      if (b.status !== "accepted") {
        // e.g. "pending": the event type requires host confirmation, so it is NOT a confirmed consultation.
        throw new CalendlyError("invalid_request", `create booking: Cal.com created booking ${b.uid} with status "${b.status}" (turn off "requires confirmation" on the event type)`);
      }
      const host = b.hosts?.[0];
      return {
        inviteeUri: `calcom:booking:${b.uid}`,
        eventUri: `calcom:booking:${b.uid}`,
        status: b.status,
        email: input.invitee.email,
        timezone: input.invitee.timezone,
        cancelUrl: `https://cal.com/booking/${b.uid}`,
        rescheduleUrl: `https://cal.com/reschedule/${b.uid}`,
        startTime: b.start ?? input.startTime,
        endTime: b.end ?? null,
        hostName: host?.name ?? null,
        hostEmail: host?.email ?? null,
      };
    } catch (err) {
      throw mapError(err, "create booking");
    }
  }

  async findScheduledEvent(input: { inviteeEmail: string; startTime: string }): Promise<ScheduledEventLite | null> {
    const start = new Date(input.startTime);
    try {
      const { data } = await httpJson<Envelope<CalBooking[]>>({
        integration: "calcom", url: `${BASE}/v2/bookings`, headers: this.headers(V_BOOKINGS_LIST),
        query: {
          attendeeEmail: input.inviteeEmail, status: "upcoming",
          afterStart: new Date(start.getTime() - 60_000).toISOString(), beforeEnd: new Date(start.getTime() + 24 * 3600_000).toISOString(), limit: 20,
        },
        retries: 2, timeoutMs: 6_000, fetchImpl: this.fetchImpl,
      });
      const hit = (Array.isArray(data.data) ? data.data : []).find((b) => Math.abs(Date.parse(b.start) - start.getTime()) < 60_000 && b.status === "accepted");
      return hit ? { eventUri: `calcom:booking:${hit.uid}`, startTime: hit.start, endTime: hit.end ?? null, status: "active", inviteeUri: `calcom:booking:${hit.uid}` } : null;
    } catch (err) {
      throw mapError(err, "find booking");
    }
  }

  async health() {
    try {
      const { data } = await httpJson<Envelope<{ username?: string; email?: string }>>({
        integration: "calcom", url: `${BASE}/v2/me`, headers: this.headers(V_EVENT_TYPES), retries: 1, timeoutMs: 6_000, fetchImpl: this.fetchImpl,
      });
      return { ok: true, detail: `authenticated as ${data.data?.username ?? "Cal.com user"}` };
    } catch (err) {
      return { ok: false, detail: mapError(err, "health check").message };
    }
  }
}
