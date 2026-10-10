import { and, desc, eq, gte, isNull, like, ne, not, or } from "drizzle-orm";
import type { Db } from "../db/client";
import { calls, contacts, enquiries, type DataMode } from "../db/schema";
import type { QualificationConfig } from "../domain/config";
import { emptyFacts } from "../domain/types";
import { integrationStatus } from "../env";
import { isAfterHours } from "../time";
import { logCallEvent } from "./workflow";

export type CallRow = typeof calls.$inferSelect;
export type EnquiryRow = typeof enquiries.$inferSelect;
export type ContactRow = typeof contacts.$inferSelect;

export interface CallContext {
  call: CallRow;
  enquiry: EnquiryRow;
  contact: ContactRow | null;
  createdNow: boolean;
}

/** Real calls are "live" only when Vaani is actually configured; otherwise they are simulated and labelled. */
export function currentCallMode(): DataMode {
  return integrationStatus("vaani").mode === "live" ? "live" : "mock";
}

/** E.164 for Indian-first input. Returns null rather than guessing when the number is unusable. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  if (trimmed.startsWith("+")) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (digits.length === 11 && digits.startsWith("0")) return `+91${digits.slice(1)}`;
  return `+${digits}`;
}

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  // Voice transcription often yields "name at gmail dot com".
  const spoken = raw.trim().toLowerCase().replace(/\s+at\s+/g, "@").replace(/\s+dot\s+/g, ".").replace(/\s+/g, "");
  return /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(spoken) && spoken.length <= 200 ? spoken : null;
}

export async function upsertContact(
  db: Db,
  input: { phone: string | null; name?: string | null; email?: string | null; mode: DataMode },
): Promise<ContactRow | null> {
  const email = normalizeEmail(input.email ?? null);
  if (!input.phone && !email) return null;

  if (input.phone) {
    const [existing] = await db.select().from(contacts).where(and(eq(contacts.phoneE164, input.phone), eq(contacts.mode, input.mode))).limit(1);
    if (existing) {
      const patch: Partial<typeof contacts.$inferInsert> = {};
      if (!existing.name && input.name) patch.name = input.name;
      if (!existing.email && email) patch.email = email;
      if (Object.keys(patch).length) {
        const [u] = await db.update(contacts).set({ ...patch, updatedAt: new Date() }).where(eq(contacts.id, existing.id)).returning();
        return u!;
      }
      return existing;
    }
    const [row] = await db
      .insert(contacts)
      .values({ phoneE164: input.phone, name: input.name ?? null, email, mode: input.mode })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    const [again] = await db.select().from(contacts).where(and(eq(contacts.phoneE164, input.phone), eq(contacts.mode, input.mode))).limit(1);
    return again ?? null;
  }
  const [row] = await db.insert(contacts).values({ phoneE164: null, name: input.name ?? null, email, mode: input.mode }).returning();
  return row ?? null;
}

const REPEAT_WINDOW_MS = 45 * 60_000;

/**
 * Finds or creates the call (idempotent on vaani call id + mode), its contact and its enquiry.
 * A repeat call from the same number within 45 minutes of a call that never reached a final outcome
 * (a disconnect + redial, transcript T17) re-uses that enquiry, so facts already captured are not re-asked.
 */
export async function ensureCallContext(
  db: Db,
  input: {
    vaaniCallId: string;
    fromNumber?: string | null;
    toNumber?: string | null;
    agentId?: string | null;
    receivedAt?: Date;
    mode: DataMode;
    businessHours: QualificationConfig["businessHours"];
    source: "webhook" | "tool" | "simulator";
  },
): Promise<CallContext> {
  const [existing] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.vaaniCallId, input.vaaniCallId), eq(calls.mode, input.mode)))
    .limit(1);

  if (existing) {
    const [enquiry] = existing.enquiryId ? await db.select().from(enquiries).where(eq(enquiries.id, existing.enquiryId)).limit(1) : [];
    const [contact] = existing.contactId ? await db.select().from(contacts).where(eq(contacts.id, existing.contactId)).limit(1) : [];
    if (!enquiry) throw new Error(`call ${existing.id} has no enquiry`);
    return { call: existing, enquiry, contact: contact ?? null, createdNow: false };
  }

  const receivedAt = input.receivedAt ?? new Date();
  const phone = normalizePhone(input.fromNumber ?? null);
  const contact = await upsertContact(db, { phone, mode: input.mode });

  // Look for an unfinished enquiry from the same number a few minutes ago (dropped call + redial).
  let related: { call: CallRow; enquiry: EnquiryRow } | null = null;
  if (contact && phone) {
    const since = new Date(receivedAt.getTime() - REPEAT_WINDOW_MS);
    const prior = await db
      .select()
      .from(calls)
      .where(and(eq(calls.fromNumber, phone), eq(calls.mode, input.mode), gte(calls.receivedAt, since), ne(calls.vaaniCallId, input.vaaniCallId)))
      .orderBy(desc(calls.receivedAt))
      .limit(1);
    const p = prior[0];
    if (p?.enquiryId && ["abandoned", "agent_active", "capturing_information", "call_received", "clarification_required"].includes(p.state)) {
      const [enq] = await db.select().from(enquiries).where(eq(enquiries.id, p.enquiryId)).limit(1);
      if (enq && ["clarification_required"].includes(enq.disposition)) related = { call: p, enquiry: enq };
    }
  }

  let enquiry: EnquiryRow;
  if (related) {
    enquiry = related.enquiry;
  } else {
    const [row] = await db.insert(enquiries).values({ contactId: contact?.id ?? null, facts: emptyFacts(), mode: input.mode }).returning();
    enquiry = row!;
  }

  const [inserted] = await db
    .insert(calls)
    .values({
      vaaniCallId: input.vaaniCallId,
      enquiryId: enquiry.id,
      contactId: contact?.id ?? null,
      fromNumber: phone,
      toNumber: input.toNumber ?? null,
      agentId: input.agentId ?? null,
      receivedAt,
      afterHours: isAfterHours(receivedAt, input.businessHours),
      relatedCallId: related?.call.id ?? null,
      mode: input.mode,
    })
    .onConflictDoNothing()
    .returning();

  if (!inserted) {
    // Lost a creation race with a concurrent webhook/tool call: use the winner.
    const [winner] = await db.select().from(calls).where(and(eq(calls.vaaniCallId, input.vaaniCallId), eq(calls.mode, input.mode))).limit(1);
    return { call: winner!, enquiry, contact, createdNow: false };
  }

  await logCallEvent(db, inserted.id, "call_created", { source: input.source, repeatOf: related?.call.id ?? null });
  if (related) await logCallEvent(db, inserted.id, "repeat_call_linked", { previousCallId: related.call.id, enquiryId: enquiry.id });
  return { call: inserted, enquiry, contact, createdNow: true };
}

/** Resolve a tool call's call: by Vaani call id, else by the caller's number (most recent unfinished call). */
export async function findActiveCallByPhone(db: Db, phone: string, mode: DataMode): Promise<CallRow | null> {
  const since = new Date(Date.now() - 3 * 3600_000);
  const [row] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.fromNumber, phone), eq(calls.mode, mode), gte(calls.receivedAt, since), or(isNull(calls.endedAt))))
    .orderBy(desc(calls.receivedAt))
    .limit(1);
  return row ?? null;
}

/**
 * Last-resort correlation for a tool call that carries neither a call id nor a caller number (Vaani's custom-tool
 * form does not document passing either): if EXACTLY ONE call is in progress (started in the last 45 minutes, not
 * ended) it is that call. With two or more in progress the request is refused rather than guessed.
 */
export async function findSoleActiveCall(db: Db, mode: DataMode): Promise<{ call: CallRow | null; ambiguous: boolean }> {
  const since = new Date(Date.now() - 45 * 60_000);
  const rows = await db
    .select()
    .from(calls)
    .where(and(eq(calls.mode, mode), gte(calls.receivedAt, since), isNull(calls.endedAt), not(like(calls.vaaniCallId, "adhoc-%"))))
    .orderBy(desc(calls.receivedAt))
    .limit(3);
  return rows.length === 1 ? { call: rows[0]!, ambiguous: false } : { call: null, ambiguous: rows.length > 1 };
}

const REF_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"; // no 0/O/1/I/L: easy for a model to carry and echo

function newRef(): string {
  let out = "";
  for (let i = 0; i < 5; i++) out += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  return out;
}

/** Gives the call a short reference (idempotent) that the agent echoes back in later tool calls. */
export async function ensureCallRef(db: Db, call: CallRow): Promise<string> {
  if (call.callRef) return call.callRef;
  for (let i = 0; i < 6; i++) {
    const ref = newRef();
    const rows = await db.update(calls).set({ callRef: ref }).where(and(eq(calls.id, call.id), isNull(calls.callRef))).returning({ ref: calls.callRef }).catch(() => []);
    if (rows[0]?.ref) return rows[0].ref;
    const [again] = await db.select({ ref: calls.callRef }).from(calls).where(eq(calls.id, call.id)).limit(1);
    if (again?.ref) return again.ref;
  }
  throw new Error("could not allocate a call reference");
}

export async function findCallByRef(db: Db, ref: string): Promise<CallRow | null> {
  const [row] = await db.select().from(calls).where(eq(calls.callRef, ref.trim().toUpperCase())).limit(1);
  return row ?? null;
}
