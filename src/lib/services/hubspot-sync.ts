import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { contacts, hubspotSyncs } from "../db/schema";
import { CRITERION_LABELS } from "../domain/types";
import { getEnv } from "../env";
import { getHubspot } from "../integrations";
import { CUSTOM_PROPERTY_DEFS, FIELD_MAP, HubspotError } from "../integrations/hubspot/types";
import { createLogger } from "../logging/logger";
import { sha256Hex } from "../security/hmac";
import { formatDateTimeInZone } from "../time";
import { loadEnquiryBundle, type EnquiryBundle } from "./enquiry-data";
import { PermanentJobError, type JobHandler } from "./outbox";

const log = createLogger("hubspot-sync");
const propertiesEnsured = new Set<string>();

const cap = (s: string | null | undefined, n: number) => (s ?? "").slice(0, n);

function contactProperties(b: EnquiryBundle): Record<string, string | number> {
  const f = b.facts;
  const q = b.qualification;
  const out: Record<string, string | number> = {
    [FIELD_MAP.source]: "Inbound phone call (AI voice agent)",
    [FIELD_MAP.disposition]: b.enquiry.disposition,
    [FIELD_MAP.score]: b.enquiry.score,
  };
  const set = (k: string, v: string | number | null | undefined) => {
    if (v !== null && v !== undefined && v !== "") out[k] = v;
  };
  set(FIELD_MAP.projectType, f.project_type);
  set(FIELD_MAP.scope, [f.property_kind, f.scope].filter(Boolean).join(" / ").replace(/_/g, " "));
  set(FIELD_MAP.location, f.location_text);
  set(FIELD_MAP.area, f.carpet_area_sqft);
  set(FIELD_MAP.timeline, [f.desired_completion_date ? `Complete by ${f.desired_completion_date}` : f.timeline_flexible ? "Flexible" : null, f.site_available_date ? `site from ${f.site_available_date}` : f.site_available_now ? "site available now" : null].filter(Boolean).join("; "));
  set(FIELD_MAP.authority, f.authority?.replace(/_/g, " "));
  if (f.budget_inr_min || f.budget_inr_max) {
    set(FIELD_MAP.volunteeredBudget, `Volunteered (not asked): ${f.budget_inr_min ?? ""}${f.budget_inr_min && f.budget_inr_max ? " - " : ""}${f.budget_inr_max ?? ""} INR`);
  } else if (f.budget_declined) set(FIELD_MAP.volunteeredBudget, "Preferred not to share");
  if (q) {
    set(FIELD_MAP.criteria, cap(q.criteria.map((c) => `${CRITERION_LABELS[c.criterion]}: ${c.status} (${c.points}/${c.weight})`).join("\n"), 2000));
    set(FIELD_MAP.caveats, cap((q.caveats as string[]).join("\n"), 2000));
    const rej = q.criteria.filter((c) => c.status === "fail").map((c) => c.reasonCode ?? c.criterion);
    if (b.enquiry.disposition === "rejected" || rej.length) set(FIELD_MAP.rejectionReason, rej.join(", "));
  }
  set(FIELD_MAP.callSummary, cap(b.enquiry.summary, 3000));
  if (b.latestCall) {
    set(FIELD_MAP.callId, b.latestCall.vaaniCallId);
    set(FIELD_MAP.callTime, formatDateTimeInZone(b.latestCall.receivedAt));
  }
  set(FIELD_MAP.designer, b.designer?.name);
  set(FIELD_MAP.bookingStatus, b.booking ? `Confirmed${b.booking.mode !== "live" ? " (SIMULATED)" : ""}` : b.enquiry.disposition === "qualified" ? "Not booked" : "n/a");
  if (b.booking) set(FIELD_MAP.bookingTime, formatDateTimeInZone(b.booking.startTime, b.booking.designerTimezone ?? b.booking.customerTimezone));
  const openEsc = b.escalations.find((e) => e.status !== "resolved");
  set(FIELD_MAP.escalationStatus, openEsc ? `${openEsc.kind} (${openEsc.status})` : b.escalations.length ? "resolved" : "none");
  return out;
}

function noteBody(b: EnquiryBundle): string {
  const call = b.latestCall;
  const lines = [
    `Aangan Studio - inbound phone enquiry${call?.mode && call.mode !== "live" ? " [SIMULATED DATA]" : ""}`,
    call ? `Call: ${call.vaaniCallId} at ${formatDateTimeInZone(call.receivedAt)}${call.afterHours ? " (after hours)" : ""}` : "",
    `Disposition: ${b.enquiry.disposition} | Score: ${b.enquiry.score}/100`,
    "",
    "Criterion-level results:",
    ...(b.qualification?.criteria ?? []).map((c) => `- ${CRITERION_LABELS[c.criterion]}: ${c.status} (${c.points}/${c.weight}) - ${c.evidence}`),
    ...((b.qualification?.caveats as string[] | undefined)?.length ? ["", "Caveats:", ...(b.qualification!.caveats as string[]).map((c) => `- ${c}`)] : []),
    "",
    "Summary:",
    b.enquiry.summary ?? "(not available)",
    "",
    b.booking ? `Consultation: ${formatDateTimeInZone(b.booking.startTime, b.booking.designerTimezone ?? b.booking.customerTimezone)} with ${b.designer?.name ?? "designer"} (${b.booking.mode === "live" ? "confirmed in Calendly" : "SIMULATED booking"})` : "Consultation: not booked",
  ];
  return lines.filter((l) => l !== undefined).join("\n").slice(0, 60_000);
}

export async function syncEnquiry(db: Db, enquiryId: string): Promise<{ status: "synced" | "skipped_unchanged" | "no_identifier"; hubspotContactId?: string }> {
  const b = await loadEnquiryBundle(db, enquiryId);
  if (!b) throw new PermanentJobError("enquiry not found");

  const client = getHubspot();
  const mode = client.mode === "live" ? "live" : "mock";
  const phone = b.contact?.phoneE164 ?? null;
  const email = b.contact?.email ?? b.facts.caller_email ?? null;
  const name = b.contact?.name ?? b.facts.caller_name ?? null;

  await db.insert(hubspotSyncs).values({ enquiryId, mode }).onConflictDoNothing({ target: hubspotSyncs.enquiryId });
  const [sync] = await db.select().from(hubspotSyncs).where(eq(hubspotSyncs.enquiryId, enquiryId)).limit(1);

  if (!phone && !email) {
    await db.update(hubspotSyncs).set({ lastStatus: "failed", lastError: "No phone number or email available to create a CRM contact (withheld caller ID).", updatedAt: new Date() }).where(eq(hubspotSyncs.enquiryId, enquiryId));
    return { status: "no_identifier" };
  }

  const properties = contactProperties(b);
  const body = noteBody(b);
  const hash = sha256Hex(JSON.stringify({ properties, body, name, email, phone }));
  if (sync?.lastStatus === "synced" && sync.payloadHash === hash && sync.mode === mode) return { status: "skipped_unchanged", hubspotContactId: sync.hubspotContactId ?? undefined };

  try {
    if (!propertiesEnsured.has(mode)) {
      const r = await client.ensureProperties(CUSTOM_PROPERTY_DEFS);
      if (r.created.length) log.info("created HubSpot custom properties", { count: r.created.length });
      propertiesEnsured.add(mode);
    }

    const c = await client.upsertContact({ email, phone, name, properties });
    if (b.contact) await db.update(contacts).set({ hubspotContactId: c.id, updatedAt: new Date() }).where(eq(contacts.id, b.contact.id));

    const env = getEnv();
    let dealId = sync?.hubspotDealId ?? null;
    if (env.HUBSPOT_CREATE_DEALS && env.HUBSPOT_DEAL_PIPELINE && env.HUBSPOT_DEAL_STAGE_QUALIFIED && (b.enquiry.disposition === "qualified" || dealId)) {
      const stage = b.booking ? (env.HUBSPOT_DEAL_STAGE_BOOKED ?? env.HUBSPOT_DEAL_STAGE_QUALIFIED) : env.HUBSPOT_DEAL_STAGE_QUALIFIED;
      const d = await client.upsertDeal({ existingDealId: dealId, contactId: c.id, name: `Aangan enquiry - ${name ?? "caller"} - ${b.facts.location_text ?? "Pune"}`, pipeline: env.HUBSPOT_DEAL_PIPELINE, stage });
      dealId = d.id;
    }

    const noteIds = { ...(sync?.noteIds ?? {}) };
    const callKey = b.latestCall?.id ?? "enquiry";
    const note = await client.upsertNote({ contactId: c.id, dealId, existingNoteId: noteIds[callKey] ?? null, body, timestamp: b.latestCall?.receivedAt ?? new Date() });
    noteIds[callKey] = note.id;

    await db
      .update(hubspotSyncs)
      .set({ hubspotContactId: c.id, hubspotDealId: dealId, noteIds, lastStatus: "synced", lastError: null, payloadHash: hash, syncedAt: new Date(), mode, updatedAt: new Date() })
      .where(eq(hubspotSyncs.enquiryId, enquiryId));
    return { status: "synced", hubspotContactId: c.id };
  } catch (err) {
    const message = String((err as Error)?.message ?? err).slice(0, 400);
    await db.update(hubspotSyncs).set({ lastStatus: "failed", lastError: message, updatedAt: new Date() }).where(eq(hubspotSyncs.enquiryId, enquiryId));
    if (err instanceof HubspotError && err.code === "invalid_request") throw new PermanentJobError(message);
    throw err;
  }
}

export const hubspotSyncJob: JobHandler = async ({ db, job }) => {
  const enquiryId = job.payload.enquiryId;
  if (typeof enquiryId !== "string") throw new PermanentJobError("hubspot_sync requires enquiryId");
  await syncEnquiry(db, enquiryId);
};
