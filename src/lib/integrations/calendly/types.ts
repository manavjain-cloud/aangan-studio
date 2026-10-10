export interface AvailableSlot {
  /** UTC ISO instant. */
  startTime: string;
  invitesRemaining: number;
  schedulingUrl: string;
}

export interface EventTypeInfo {
  uri: string;
  name: string;
  durationMinutes: number | null;
  poolingType: string | null;
  active: boolean;
  schedulingUrl: string | null;
  locations: Array<{ kind: string; location?: string | null }>;
}

export interface CreateInviteeInput {
  eventTypeUri: string;
  /** UTC ISO instant; must match an open slot exactly. */
  startTime: string;
  invitee: { name: string; email: string; timezone: string; textReminderNumber?: string };
  location?: { kind: string; location?: string };
  questionsAndAnswers?: Array<{ question: string; answer: string; position: number }>;
  tracking?: { utmSource?: string; utmCampaign?: string; utmMedium?: string };
}

export interface CreatedBooking {
  inviteeUri: string;
  eventUri: string;
  status: string;
  email: string;
  timezone: string;
  cancelUrl: string | null;
  rescheduleUrl: string | null;
  startTime: string;
  endTime: string | null;
  hostName: string | null;
  hostEmail: string | null;
}

export interface ScheduledEventLite {
  eventUri: string;
  startTime: string;
  endTime: string | null;
  status: string;
  inviteeUri: string | null;
}

export type CalendlyErrorCode =
  | "slot_unavailable"
  | "forbidden"
  | "unauthorized"
  | "invalid_request"
  | "not_found"
  | "rate_limited"
  | "timeout"
  | "server_error"
  | "not_configured"
  | "unknown";

export class CalendlyError extends Error {
  constructor(
    public readonly code: CalendlyErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "CalendlyError";
  }
  /** True when the booking might have been created even though we saw an error (timeout / 5xx). */
  get outcomeUnknown(): boolean {
    return this.code === "timeout" || this.code === "server_error";
  }
}

export interface CalendlyClient {
  readonly mode: "live" | "mock";
  getEventType(uri: string): Promise<EventTypeInfo>;
  listAvailableTimes(input: { eventTypeUri: string; start: Date; end: Date }): Promise<AvailableSlot[]>;
  createInvitee(input: CreateInviteeInput): Promise<CreatedBooking>;
  /** Used after an unknown outcome (timeout / 5xx) to find out whether the booking really exists. */
  findScheduledEvent(input: { inviteeEmail: string; startTime: string }): Promise<ScheduledEventLite | null>;
  health(): Promise<{ ok: boolean; detail: string }>;
}
