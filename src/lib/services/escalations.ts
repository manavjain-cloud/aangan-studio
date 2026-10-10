import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { auditEvents, escalations, type DataMode } from "../db/schema";
import type { EscalationKind } from "../domain/types";
import { queueEmail } from "./notifications";

export type EscalationRow = typeof escalations.$inferSelect;

export interface NewEscalation {
  enquiryId?: string | null;
  callId?: string | null;
  kind: EscalationKind;
  urgency: "normal" | "high";
  reason: string;
  requestedResponse?: string | null;
  mode: DataMode;
}

/**
 * One escalation per (call or enquiry, kind): repeated tool calls, webhook retries and re-evaluations cannot
 * spam the senior team. Creating it queues the email (the only notification channel, per the spec).
 */
export async function createEscalation(db: Db, e: NewEscalation): Promise<{ id: string; created: boolean }> {
  const dedupeKey = `${e.callId ?? e.enquiryId ?? "none"}:${e.kind}`;
  const rows = await db
    .insert(escalations)
    .values({
      enquiryId: e.enquiryId ?? null, callId: e.callId ?? null, kind: e.kind, urgency: e.urgency, reason: e.reason,
      requestedResponse: e.requestedResponse ?? null, dedupeKey, mode: e.mode,
    })
    .onConflictDoNothing({ target: escalations.dedupeKey })
    .returning({ id: escalations.id });
  if (rows[0]) {
    await queueEmail(db, `escalation:${rows[0].id}`, { kind: "escalation", escalationId: rows[0].id, enquiryId: e.enquiryId ?? undefined, callId: e.callId ?? undefined });
    await db.insert(auditEvents).values({ actor: "system", action: "escalation.created", entityType: "escalation", entityId: rows[0].id, detail: { kind: e.kind, urgency: e.urgency } });
    return { id: rows[0].id, created: true };
  }
  const [existing] = await db.select({ id: escalations.id }).from(escalations).where(eq(escalations.dedupeKey, dedupeKey)).limit(1);
  return { id: existing!.id, created: false };
}

export async function acknowledgeEscalation(db: Db, id: string, actor: string): Promise<void> {
  await db
    .update(escalations)
    .set({ status: "acknowledged", acknowledgedAt: new Date(), updatedAt: new Date() })
    .where(eq(escalations.id, id));
  await db.insert(auditEvents).values({ actor, action: "escalation.acknowledged", entityType: "escalation", entityId: id });
}

export async function resolveEscalation(db: Db, id: string, note: string, actor: string): Promise<void> {
  await db
    .update(escalations)
    .set({ status: "resolved", resolvedAt: new Date(), resolutionNote: note.slice(0, 1000), updatedAt: new Date() })
    .where(eq(escalations.id, id));
  await db.insert(auditEvents).values({ actor, action: "escalation.resolved", entityType: "escalation", entityId: id, detail: { note: note.slice(0, 300) } });
}

export async function assignEscalation(db: Db, id: string, memberId: string | null, actor: string): Promise<void> {
  await db.update(escalations).set({ assignedToId: memberId, updatedAt: new Date() }).where(eq(escalations.id, id));
  await db.insert(auditEvents).values({ actor, action: "escalation.assigned", entityType: "escalation", entityId: id, detail: { memberId } });
}
