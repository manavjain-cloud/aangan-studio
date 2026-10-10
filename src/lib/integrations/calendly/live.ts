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
} from "./types";

/**
 * Real Calendly v2 client, written against the official OpenAPI spec (developer.calendly.com/openapi).
 *
 *  - GET  /event_type_available_times  (scope availability:read; range <= 31 days; start must not be in the past)
 *  - POST /invitees                    (Scheduling API; scope scheduled_events:write; PAID plan only, else 403)
 *  - GET  /scheduled_events            (needs user or organization; used to resolve unknown outcomes)
 *
 * Calendly documents no idempotency key for POST /invitees, so this client NEVER retries a booking by itself.
 * The booking service verifies via findScheduledEvent() before it ever re-sends one.
 */

const BASE = "https://api.calendly.com";

function mapError(err: unknown, what: string): CalendlyError {
  if (err instanceof CalendlyError) return err;
  if (err instanceof NetworkError) {
    return new CalendlyError(err.timedOut ? "timeout" : "server_error", `${what}: ${err.message}`);
  }
  if (err instanceof HttpError) {
    const body = err.body.toLowerCase();
    switch (err.status) {
      case 400:
      case 409:
        if (/available|no longer|already|conflict|taken|booked/.test(body)) {
          return new CalendlyError("slot_unavailable", `${what}: the requested time is no longer available`, err.status);
        }
        return new CalendlyError("invalid_request", `${what}: ${err.body.slice(0, 200)}`, err.status);
      case 401:
        return new CalendlyError("unauthorized", `${what}: Calendly rejected the access token`, err.status);
      case 403:
        return new CalendlyError("forbidden", `${what}: forbidden - the account is probably not on a paid plan, or the token lacks scopes`, err.status);
      case 404:
        return new CalendlyError("not_found", `${what}: event type or time not found`, err.status);
      case 429:
        return new CalendlyError("rate_limited", `${what}: rate limited`, err.status);
      default:
        return new CalendlyError(err.status >= 500 ? "server_error" : "unknown", `${what}: HTTP ${err.status}`, err.status);
    }
  }
  return new CalendlyError("unknown", `${what}: ${String((err as Error)?.message ?? err)}`);
}

interface Resource<T> {
  resource: T;
}

export class LiveCalendlyClient implements CalendlyClient {
  readonly mode = "live" as const;
  private orgUri: string | null = null;
  private eventTypeCache = new Map<string, { at: number; info: EventTypeInfo }>();

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private headers() {
    return { Authorization: `Bearer ${this.token}` };
  }

  private async organizationUri(): Promise<string> {
    if (this.orgUri) return this.orgUri;
    const { data } = await httpJson<Resource<{ current_organization: string }>>({
      integration: "calendly", url: `${BASE}/users/me`, headers: this.headers(), retries: 2, fetchImpl: this.fetchImpl,
    });
    this.orgUri = data.resource.current_organization;
    return this.orgUri;
  }

  async getEventType(uri: string): Promise<EventTypeInfo> {
    const cached = this.eventTypeCache.get(uri);
    if (cached && Date.now() - cached.at < 10 * 60_000) return cached.info;
    try {
      const { data } = await httpJson<
        Resource<{
          uri: string; name: string; duration: number | null; pooling_type: string | null; active: boolean;
          scheduling_url: string | null; locations?: Array<{ kind: string; location?: string | null }> | null;
        }>
      >({ integration: "calendly", url: uri, headers: this.headers(), retries: 2, fetchImpl: this.fetchImpl });
      const r = data.resource;
      const info: EventTypeInfo = {
        uri: r.uri, name: r.name, durationMinutes: r.duration ?? null, poolingType: r.pooling_type ?? null, active: r.active,
        schedulingUrl: r.scheduling_url ?? null, locations: (r.locations ?? []).map((l) => ({ kind: l.kind, location: l.location ?? null })),
      };
      this.eventTypeCache.set(uri, { at: Date.now(), info });
      return info;
    } catch (err) {
      throw mapError(err, "get event type");
    }
  }

  async listAvailableTimes(input: { eventTypeUri: string; start: Date; end: Date }): Promise<AvailableSlot[]> {
    const maxMs = 31 * 86_400_000;
    // Calendly rejects start times in the past and ranges over 31 days.
    const start = new Date(Math.max(input.start.getTime(), Date.now() + 60_000));
    const end = new Date(Math.min(input.end.getTime(), start.getTime() + maxMs - 60_000));
    if (end <= start) return [];
    try {
      const { data } = await httpJson<{ collection: Array<{ status: string; start_time: string; invitees_remaining: number; scheduling_url: string }> }>({
        integration: "calendly", url: `${BASE}/event_type_available_times`, headers: this.headers(),
        query: { event_type: input.eventTypeUri, start_time: start.toISOString(), end_time: end.toISOString() },
        retries: 2, timeoutMs: 6_000, fetchImpl: this.fetchImpl,
      });
      return (data.collection ?? [])
        .filter((s) => s.status === "available")
        .map((s) => ({ startTime: s.start_time, invitesRemaining: s.invitees_remaining, schedulingUrl: s.scheduling_url }));
    } catch (err) {
      throw mapError(err, "list available times");
    }
  }

  async createInvitee(input: CreateInviteeInput): Promise<CreatedBooking> {
    const body = {
      event_type: input.eventTypeUri,
      start_time: input.startTime,
      invitee: {
        name: input.invitee.name,
        email: input.invitee.email,
        timezone: input.invitee.timezone,
        ...(input.invitee.textReminderNumber ? { text_reminder_number: input.invitee.textReminderNumber } : {}),
      },
      ...(input.location ? { location: input.location } : {}),
      ...(input.questionsAndAnswers?.length ? { questions_and_answers: input.questionsAndAnswers } : {}),
      ...(input.tracking
        ? { tracking: { utm_source: input.tracking.utmSource, utm_campaign: input.tracking.utmCampaign, utm_medium: input.tracking.utmMedium } }
        : {}),
    };
    try {
      const { data } = await httpJson<
        Resource<{ uri: string; email: string; status: string; timezone: string; event: string; cancel_url?: string; reschedule_url?: string }>
      >({
        integration: "calendly", url: `${BASE}/invitees`, method: "POST", headers: this.headers(), body,
        retries: 0, timeoutMs: 9_000, fetchImpl: this.fetchImpl,
      });
      const r = data.resource;
      const ev = await this.getScheduledEvent(r.event).catch(() => null);
      return {
        inviteeUri: r.uri,
        eventUri: r.event,
        status: r.status,
        email: r.email,
        timezone: r.timezone,
        cancelUrl: r.cancel_url ?? null,
        rescheduleUrl: r.reschedule_url ?? null,
        startTime: ev?.startTime ?? input.startTime,
        endTime: ev?.endTime ?? null,
        hostName: ev?.hostName ?? null,
        hostEmail: ev?.hostEmail ?? null,
      };
    } catch (err) {
      throw mapError(err, "create invitee");
    }
  }

  private async getScheduledEvent(eventUri: string) {
    const { data } = await httpJson<
      Resource<{ start_time: string; end_time: string; event_memberships?: Array<{ user_name?: string; user_email?: string }> }>
    >({ integration: "calendly", url: eventUri, headers: this.headers(), retries: 1, timeoutMs: 5_000, fetchImpl: this.fetchImpl });
    const host = data.resource.event_memberships?.[0];
    return {
      startTime: data.resource.start_time,
      endTime: data.resource.end_time,
      hostName: host?.user_name ?? null,
      hostEmail: host?.user_email ?? null,
    };
  }

  async findScheduledEvent(input: { inviteeEmail: string; startTime: string }): Promise<ScheduledEventLite | null> {
    try {
      const org = await this.organizationUri();
      const start = new Date(input.startTime);
      const { data } = await httpJson<{ collection: Array<{ uri: string; start_time: string; end_time: string; status: string }> }>({
        integration: "calendly", url: `${BASE}/scheduled_events`, headers: this.headers(),
        query: {
          organization: org,
          invitee_email: input.inviteeEmail,
          status: "active",
          min_start_time: new Date(start.getTime() - 60_000).toISOString(),
          max_start_time: new Date(start.getTime() + 60_000).toISOString(),
          count: 10,
        },
        retries: 2, timeoutMs: 6_000, fetchImpl: this.fetchImpl,
      });
      const hit = (data.collection ?? []).find((e) => Math.abs(Date.parse(e.start_time) - start.getTime()) < 60_000);
      return hit ? { eventUri: hit.uri, startTime: hit.start_time, endTime: hit.end_time, status: hit.status, inviteeUri: null } : null;
    } catch (err) {
      throw mapError(err, "find scheduled event");
    }
  }

  async health() {
    try {
      const { data } = await httpJson<Resource<{ name: string; current_organization: string }>>({
        integration: "calendly", url: `${BASE}/users/me`, headers: this.headers(), retries: 1, timeoutMs: 6_000, fetchImpl: this.fetchImpl,
      });
      return { ok: true, detail: `authenticated as ${data.resource.name}` };
    } catch (err) {
      return { ok: false, detail: mapError(err, "health check").message };
    }
  }
}
