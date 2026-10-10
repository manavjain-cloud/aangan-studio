import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { EnquiryFacts } from "../domain/types";

/**
 * All timestamps are timestamptz (UTC instants). Scheduling rows additionally keep the IANA timezone of the
 * customer and designer. `mode` ("live" | "mock" | "seed") marks every row produced by a simulated adapter or
 * development seed so it can never be mistaken for real activity.
 */

const id = () => uuid("id").primaryKey().default(sql`gen_random_uuid()`);
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export type DataMode = "live" | "mock" | "seed";

/* ------------------------------------------------------------------ people */

export const contacts = pgTable(
  "contacts",
  {
    id: id(),
    phoneE164: text("phone_e164"),
    email: text("email"),
    name: text("name"),
    hubspotContactId: text("hubspot_contact_id"),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("contacts_phone_mode_uq").on(t.phoneE164, t.mode),
    index("contacts_email_idx").on(t.email),
  ],
);

/** Designers, front desk and senior people. Drives routing, Calendly event types and email recipients. */
export const teamMembers = pgTable(
  "team_members",
  {
    id: id(),
    name: text("name").notNull(),
    email: text("email").notNull(),
    role: text("role").$type<"designer" | "front_desk" | "senior">().notNull(),
    active: boolean("active").notNull().default(true),
    /** Calendly event type URI used to book THIS designer (one event type per designer, or a round-robin type). */
    calendlyEventTypeUri: text("calendly_event_type_uri"),
    handles: text("handles").array().notNull().default(sql`ARRAY['residential','commercial']::text[]`),
    timezone: text("timezone").notNull().default("Asia/Kolkata"),
    routingWeight: integer("routing_weight").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("team_members_email_uq").on(t.email)],
);

/* ------------------------------------------------------------ enquiries */

export const enquiries = pgTable(
  "enquiries",
  {
    id: id(),
    contactId: uuid("contact_id").references(() => contacts.id),
    /** Validated structured facts captured so far (merge-only; see mergeFacts). */
    facts: jsonb("facts").$type<EnquiryFacts>().notNull(),
    disposition: text("disposition").notNull().default("clarification_required"),
    score: integer("score").notNull().default(0),
    summary: text("summary"),
    handoffNote: text("handoff_note"),
    assignedDesignerId: uuid("assigned_designer_id").references(() => teamMembers.id),
    /** Set when a human overrides the automated disposition. */
    overridden: boolean("overridden").notNull().default(false),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("enquiries_contact_idx").on(t.contactId), index("enquiries_disposition_idx").on(t.disposition, t.createdAt)],
);

export const calls = pgTable(
  "calls",
  {
    id: id(),
    /** Vaani call_id / room_name. Unique per mode so seed/mock data can never collide with live calls. */
    vaaniCallId: text("vaani_call_id").notNull(),
    /** Short code the agent receives from the first tool call and echoes in later ones (Vaani passes no call id to tools). */
    callRef: text("call_ref"),
    enquiryId: uuid("enquiry_id").references(() => enquiries.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    direction: text("direction").notNull().default("inbound"),
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    agentId: text("agent_id"),
    state: text("state").notNull().default("call_received"),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationMs: integer("duration_ms"),
    endReason: text("end_reason"),
    afterHours: boolean("after_hours").notNull().default(false),
    /** True once the agent actually spoke with the caller (picked up + conversation happened). */
    answered: boolean("answered").notNull().default(false),
    /** Set when this call follows a dropped call from the same number (disconnect + redial). */
    relatedCallId: uuid("related_call_id"),
    summary: text("summary"),
    vaaniCostCredits: numeric("vaani_cost_credits", { precision: 12, scale: 4 }),
    postProcessedAt: timestamp("post_processed_at", { withTimezone: true }),
    complianceFlags: jsonb("compliance_flags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("calls_vaani_call_mode_uq").on(t.vaaniCallId, t.mode),
    uniqueIndex("calls_call_ref_uq").on(t.callRef),
    index("calls_received_idx").on(t.receivedAt),
    index("calls_enquiry_idx").on(t.enquiryId),
    index("calls_from_idx").on(t.fromNumber, t.receivedAt),
  ],
);

/** Redacted transcripts. Kept separate so access and retention can be controlled independently. */
export const callTranscripts = pgTable("call_transcripts", {
  callId: uuid("call_id").primaryKey().references(() => calls.id, { onDelete: "cascade" }),
  text: text("text"),
  redacted: boolean("redacted").notNull().default(true),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: createdAt(),
});

export const callEvents = pgTable(
  "call_events",
  {
    id: id(),
    callId: uuid("call_id").notNull().references(() => calls.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    fromState: text("from_state"),
    toState: text("to_state"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("call_events_call_idx").on(t.callId, t.occurredAt)],
);

/* -------------------------------------------------------- qualification */

export const qualificationResults = pgTable(
  "qualification_results",
  {
    id: id(),
    enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
    callId: uuid("call_id").references(() => calls.id),
    version: integer("version").notNull(),
    disposition: text("disposition").notNull(),
    score: integer("score").notNull(),
    canBook: boolean("can_book").notNull().default(false),
    nextQuestion: text("next_question"),
    reasonCodes: jsonb("reason_codes").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    caveats: jsonb("caveats").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
    factsSnapshot: jsonb("facts_snapshot").$type<EnquiryFacts>().notNull(),
    policySnapshot: jsonb("policy_snapshot").$type<Record<string, unknown>>().notNull(),
    rulesVersion: text("rules_version").notNull(),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("qual_enquiry_version_uq").on(t.enquiryId, t.version)],
);

export const qualificationCriteria = pgTable(
  "qualification_criteria",
  {
    id: id(),
    resultId: uuid("result_id").notNull().references(() => qualificationResults.id, { onDelete: "cascade" }),
    criterion: text("criterion").notNull(),
    status: text("status").notNull(),
    weight: integer("weight").notNull(),
    points: integer("points").notNull(),
    evidence: text("evidence").notNull(),
    hardExclusion: boolean("hard_exclusion").notNull().default(false),
    reasonCode: text("reason_code"),
    caveat: text("caveat"),
  },
  (t) => [uniqueIndex("qual_criteria_uq").on(t.resultId, t.criterion)],
);

/* --------------------------------------------------------- escalations */

export const escalations = pgTable(
  "escalations",
  {
    id: id(),
    enquiryId: uuid("enquiry_id").references(() => enquiries.id),
    callId: uuid("call_id").references(() => calls.id),
    kind: text("kind").notNull(),
    urgency: text("urgency").notNull().default("normal"),
    status: text("status").$type<"open" | "acknowledged" | "resolved">().notNull().default("open"),
    reason: text("reason").notNull(),
    requestedResponse: text("requested_response"),
    assignedToId: uuid("assigned_to_id").references(() => teamMembers.id),
    /** Idempotency: one open escalation per (call, kind). */
    dedupeKey: text("dedupe_key").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("escalations_dedupe_uq").on(t.dedupeKey), index("escalations_status_idx").on(t.status, t.createdAt)],
);

/** Audit trail for human overrides of an automated disposition. */
export const decisionOverrides = pgTable("decision_overrides", {
  id: id(),
  enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
  fromDisposition: text("from_disposition").notNull(),
  toDisposition: text("to_disposition").notNull(),
  reason: text("reason").notNull(),
  overriddenBy: text("overridden_by").notNull(),
  createdAt: createdAt(),
});

/* ------------------------------------------------------------- booking */

export const offeredSlots = pgTable(
  "offered_slots",
  {
    id: id(),
    token: text("token").notNull(),
    callId: uuid("call_id").notNull().references(() => calls.id, { onDelete: "cascade" }),
    enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
    designerId: uuid("designer_id").notNull().references(() => teamMembers.id),
    eventTypeUri: text("event_type_uri").notNull(),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    customerTimezone: text("customer_timezone").notNull(),
    status: text("status").$type<"offered" | "booked" | "unavailable" | "expired">().notNull().default("offered"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("offered_slots_token_uq").on(t.token), index("offered_slots_call_idx").on(t.callId)],
);

export const bookingAttempts = pgTable(
  "booking_attempts",
  {
    id: id(),
    /** sha256(callId | slot token | invitee email). Same key = same booking, so retries are safe. */
    idempotencyKey: text("idempotency_key").notNull(),
    enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id),
    callId: uuid("call_id").references(() => calls.id),
    designerId: uuid("designer_id").references(() => teamMembers.id),
    slotId: uuid("slot_id").references(() => offeredSlots.id),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    status: text("status")
      .$type<"pending" | "confirmed" | "failed" | "slot_unavailable" | "unconfirmed">()
      .notNull()
      .default("pending"),
    httpStatus: integer("http_status"),
    error: text("error"),
    /** What the caller said to confirm the slot (audit evidence that confirmation happened). */
    customerConfirmationQuote: text("customer_confirmation_quote"),
    attemptCount: integer("attempt_count").notNull().default(1),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("booking_attempts_idem_uq").on(t.idempotencyKey), index("booking_attempts_enquiry_idx").on(t.enquiryId)],
);

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    attemptId: uuid("attempt_id").notNull().references(() => bookingAttempts.id),
    enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id),
    designerId: uuid("designer_id").references(() => teamMembers.id),
    calendlyEventUri: text("calendly_event_uri").notNull(),
    calendlyInviteeUri: text("calendly_invitee_uri"),
    startTime: timestamp("start_time", { withTimezone: true }).notNull(),
    endTime: timestamp("end_time", { withTimezone: true }),
    customerTimezone: text("customer_timezone").notNull(),
    designerTimezone: text("designer_timezone"),
    status: text("status").$type<"confirmed" | "canceled">().notNull().default("confirmed"),
    cancelUrl: text("cancel_url"),
    rescheduleUrl: text("reschedule_url"),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("bookings_event_uq").on(t.calendlyEventUri), uniqueIndex("bookings_attempt_uq").on(t.attemptId)],
);

/* ------------------------------------------------------ outputs: jobs */

export const outboxJobs = pgTable(
  "outbox_jobs",
  {
    id: id(),
    type: text("type").$type<"hubspot_sync" | "send_email" | "postcall_enrich" | "booking_reconcile">().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"pending" | "running" | "done" | "failed" | "dead">().notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("outbox_idem_uq").on(t.idempotencyKey), index("outbox_due_idx").on(t.status, t.nextAttemptAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: id(),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind").notNull(),
    enquiryId: uuid("enquiry_id").references(() => enquiries.id),
    callId: uuid("call_id").references(() => calls.id),
    escalationId: uuid("escalation_id").references(() => escalations.id),
    recipient: text("recipient").notNull(),
    subject: text("subject").notNull(),
    status: text("status").$type<"pending" | "sent" | "failed" | "skipped">().notNull().default("pending"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("notifications_idem_uq").on(t.idempotencyKey), index("notifications_status_idx").on(t.status)],
);

export const hubspotSyncs = pgTable(
  "hubspot_syncs",
  {
    id: id(),
    enquiryId: uuid("enquiry_id").notNull().references(() => enquiries.id, { onDelete: "cascade" }),
    hubspotContactId: text("hubspot_contact_id"),
    hubspotDealId: text("hubspot_deal_id"),
    /** Note ids already written, keyed by call id, so re-syncing never duplicates a call note. */
    noteIds: jsonb("note_ids").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    lastStatus: text("last_status").$type<"pending" | "synced" | "failed">().notNull().default("pending"),
    lastError: text("last_error"),
    payloadHash: text("payload_hash"),
    syncedAt: timestamp("synced_at", { withTimezone: true }),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("hubspot_syncs_enquiry_uq").on(t.enquiryId)],
);

/* -------------------------------------------------------------- ops */

/** Inbound webhooks and outbound integration failures. dedupeKey makes webhook handling idempotent. */
export const integrationEvents = pgTable(
  "integration_events",
  {
    id: id(),
    integration: text("integration").notNull(),
    direction: text("direction").$type<"inbound" | "outbound">().notNull(),
    eventType: text("event_type").notNull(),
    dedupeKey: text("dedupe_key"),
    status: text("status").$type<"received" | "processed" | "failed" | "duplicate" | "rejected">().notNull(),
    httpStatus: integer("http_status"),
    error: text("error"),
    payload: jsonb("payload").$type<Record<string, unknown>>(),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("integration_events_dedupe_uq").on(t.dedupeKey),
    index("integration_events_integration_idx").on(t.integration, t.createdAt),
  ],
);

/** Idempotency + audit log for live tool calls from the voice agent. */
export const toolInvocations = pgTable(
  "tool_invocations",
  {
    id: id(),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "cascade" }),
    action: text("action").notNull(),
    requestKey: text("request_key").notNull(),
    request: jsonb("request").$type<Record<string, unknown>>().notNull(),
    response: jsonb("response").$type<Record<string, unknown>>(),
    status: text("status").$type<"running" | "ok" | "error">().notNull().default("running"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tool_invocations_key_uq").on(t.requestKey), index("tool_invocations_call_idx").on(t.callId, t.createdAt)],
);

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    dedupeKey: text("dedupe_key").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    provider: text("provider").notNull(),
    metric: text("metric").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 4 }).notNull(),
    unit: text("unit").notNull(),
    /** Cost in INR where known. Null = cost not measurable/configured; it is never guessed. */
    costInr: numeric("cost_inr", { precision: 14, scale: 4 }),
    costBasis: text("cost_basis").$type<"measured" | "configured_rate" | "unknown">().notNull(),
    callId: uuid("call_id").references(() => calls.id, { onDelete: "set null" }),
    mode: text("mode").$type<DataMode>().notNull().default("live"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (t) => [uniqueIndex("usage_dedupe_uq").on(t.dedupeKey), index("usage_provider_idx").on(t.provider, t.occurredAt)],
);

/** Fixed monthly costs configured by management (seat fees, number rental...). Prorated, labelled "configured". */
export const fixedCosts = pgTable("fixed_costs", {
  id: id(),
  provider: text("provider").notNull(),
  label: text("label").notNull(),
  monthlyInr: numeric("monthly_inr", { precision: 12, scale: 2 }).notNull(),
  activeFrom: text("active_from").notNull(),
  activeTo: text("active_to"),
  createdAt: createdAt(),
});

export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: updatedAt(),
  updatedBy: text("updated_by"),
});

export const adminUsers = pgTable(
  "admin_users",
  {
    id: id(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    failedAttempts: integer("failed_attempts").notNull().default(0),
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("admin_users_email_uq").on(t.email)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: id(),
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);

export const rateLimitCounters = pgTable(
  "rate_limit_counters",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);
