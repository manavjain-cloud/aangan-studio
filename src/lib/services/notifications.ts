import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { calls, escalations, integrationEvents, notifications } from "../db/schema";
import { getEnv } from "../env";
import { getEmail } from "../integrations";
import { createLogger } from "../logging/logger";
import { formatDateTimeInZone } from "../time";
import { loadEnquiryBundle } from "./enquiry-data";
import { droppedCallEmail, escalationEmail, handoffEmail, opsAlertEmail, type EmailContent } from "./email-templates";
import { PermanentJobError, enqueue, type JobHandler } from "./outbox";
import { recipients } from "./team";

const log = createLogger("notifications");

export type EmailKind = "qualified_handoff" | "escalation" | "dropped_call" | "ops_alert";

export interface EmailJobPayload extends Record<string, unknown> {
  kind: EmailKind;
  enquiryId?: string;
  callId?: string;
  escalationId?: string;
  /** For ops_alert */
  title?: string;
  detail?: string;
  /** Distinguishes e.g. a handoff before vs after a booking. */
  variant?: string;
}

export async function queueEmail(db: Db, key: string, payload: EmailJobPayload): Promise<void> {
  await enqueue(db, { type: "send_email", key: `email:${key}`, payload });
}

/** Sends one message at most once: the notification row's unique idempotency key is the guard. */
async function deliver(
  db: Db,
  input: { key: string; kind: string; to: string; content: EmailContent; enquiryId?: string; callId?: string; escalationId?: string },
): Promise<"sent" | "duplicate"> {
  const existing = await db.select().from(notifications).where(eq(notifications.idempotencyKey, input.key)).limit(1);
  if (existing[0]?.status === "sent") return "duplicate";

  const testTo = getEnv().EMAIL_TEST_RECIPIENT;
  const actualTo = testTo ?? input.to;
  const subject = testTo && testTo !== input.to ? `[TEST - intended for ${input.to}] ${input.content.subject}` : input.content.subject;

  const client = getEmail();
  const mode = client.mode === "live" ? "live" : "mock";
  let notificationId = existing[0]?.id;
  if (!notificationId) {
    const [row] = await db
      .insert(notifications)
      .values({
        idempotencyKey: input.key, kind: input.kind, enquiryId: input.enquiryId, callId: input.callId, escalationId: input.escalationId,
        recipient: input.to, subject, mode,
      })
      .onConflictDoNothing({ target: notifications.idempotencyKey })
      .returning({ id: notifications.id });
    notificationId = row?.id;
    if (!notificationId) {
      const [again] = await db.select().from(notifications).where(eq(notifications.idempotencyKey, input.key)).limit(1);
      if (again?.status === "sent") return "duplicate";
      notificationId = again?.id;
    }
  }

  try {
    const { id } = await client.send({ to: actualTo, subject, html: input.content.html, text: input.content.text, idempotencyKey: input.key });
    await db.update(notifications).set({ status: "sent", providerMessageId: id, sentAt: new Date(), error: null, mode }).where(eq(notifications.id, notificationId!));
    return "sent";
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 400);
    await db.update(notifications).set({ status: "failed", error: message }).where(eq(notifications.id, notificationId!));
    log.warn("email delivery failed", { kind: input.kind, error: message });
    throw err;
  }
}

async function sendToAll(
  db: Db,
  base: { kind: string; keyPrefix: string; content: EmailContent; enquiryId?: string; callId?: string; escalationId?: string },
  to: string[],
  fallbackLabel: string,
) {
  if (to.length === 0) {
    // A routing gap must be visible, not silent.
    await db.insert(integrationEvents).values({
      integration: "email", direction: "outbound", eventType: "no_recipient_configured", status: "failed",
      error: `No ${fallbackLabel} recipient is configured for "${base.kind}" notifications. Set the team table or env addresses.`,
    });
    throw new PermanentJobError(`no ${fallbackLabel} recipient configured`);
  }
  let firstError: unknown;
  for (const recipient of to) {
    try {
      await deliver(db, { ...base, key: `${base.keyPrefix}:${recipient}`, to: recipient });
    } catch (err) {
      firstError ??= err; // keep delivering to the others, then fail the job so it is retried
    }
  }
  if (firstError) throw firstError;
}

export const sendEmailJob: JobHandler = async ({ db, job }) => {
  const p = job.payload as EmailJobPayload;
  const r = await recipients(db);

  switch (p.kind) {
    case "qualified_handoff": {
      if (!p.enquiryId) throw new PermanentJobError("qualified_handoff requires enquiryId");
      const b = await loadEnquiryBundle(db, p.enquiryId);
      if (!b) throw new PermanentJobError("enquiry not found");
      const to = b.designer ? [b.designer.email] : r.frontDesk;
      await sendToAll(
        db,
        { kind: "qualified_handoff", keyPrefix: `handoff:${p.enquiryId}:${p.variant ?? (b.booking ? b.booking.id : "nobooking")}`, content: handoffEmail(b), enquiryId: p.enquiryId, callId: p.callId },
        // The front desk gets a copy so a missed designer email can never strand a lead.
        [...new Set([...to, ...(b.designer ? r.frontDesk : [])])],
        b.designer ? "designer" : "front desk",
      );
      return;
    }
    case "escalation": {
      if (!p.escalationId) throw new PermanentJobError("escalation requires escalationId");
      const [esc] = await db.select().from(escalations).where(eq(escalations.id, p.escalationId)).limit(1);
      if (!esc) throw new PermanentJobError("escalation not found");
      const b = esc.enquiryId ? await loadEnquiryBundle(db, esc.enquiryId) : null;
      const to =
        esc.kind === "booking_failure" ? [...new Set([...r.frontDesk, ...r.senior])]
        : esc.kind === "integration_failure" || esc.kind === "compliance_flag" ? r.ops
        : r.senior.length ? r.senior : r.frontDesk;
      await sendToAll(
        db,
        { kind: `escalation:${esc.kind}`, keyPrefix: `escalation:${esc.id}`, content: escalationEmail(esc, b), enquiryId: esc.enquiryId ?? undefined, callId: esc.callId ?? undefined, escalationId: esc.id },
        to,
        "senior",
      );
      return;
    }
    case "dropped_call": {
      if (!p.callId) throw new PermanentJobError("dropped_call requires callId");
      const [call] = await db.select().from(calls).where(eq(calls.id, p.callId)).limit(1);
      if (!call?.enquiryId) throw new PermanentJobError("call has no enquiry");
      const b = await loadEnquiryBundle(db, call.enquiryId);
      if (!b) throw new PermanentJobError("enquiry not found");
      // The caller redialled (a later call shares this enquiry) or the enquiry has since progressed: no call-back needed.
      if (b.calls.some((c) => c.receivedAt > call.receivedAt) || b.enquiry.disposition !== "clarification_required") return;
      await sendToAll(
        db,
        { kind: "dropped_call", keyPrefix: `dropped:${call.id}`, content: droppedCallEmail(b, formatDateTimeInZone(call.receivedAt)), enquiryId: call.enquiryId, callId: call.id },
        r.frontDesk,
        "front desk",
      );
      return;
    }
    case "ops_alert": {
      await sendToAll(
        db,
        { kind: "ops_alert", keyPrefix: `ops:${job.id}`, content: opsAlertEmail(p.title ?? "Operational alert", p.detail ?? "") },
        r.ops,
        "ops",
      );
      return;
    }
    default:
      throw new PermanentJobError(`unknown email kind ${(p as { kind: string }).kind}`);
  }
};
