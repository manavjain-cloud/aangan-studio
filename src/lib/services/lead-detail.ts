import { desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { bookingAttempts, callEvents, callTranscripts, decisionOverrides, hubspotSyncs, notifications } from "../db/schema";
import { loadEnquiryBundle } from "./enquiry-data";

export async function getLeadDetail(db: Db, enquiryId: string) {
  const bundle = await loadEnquiryBundle(db, enquiryId);
  if (!bundle) return null;
  const callIds = bundle.calls.map((c) => c.id);

  const [attempts, overrides, hubspot, notifs, events, transcripts] = await Promise.all([
    db.select().from(bookingAttempts).where(eq(bookingAttempts.enquiryId, enquiryId)).orderBy(desc(bookingAttempts.createdAt)),
    db.select().from(decisionOverrides).where(eq(decisionOverrides.enquiryId, enquiryId)).orderBy(desc(decisionOverrides.createdAt)),
    db.select().from(hubspotSyncs).where(eq(hubspotSyncs.enquiryId, enquiryId)).limit(1),
    db.select().from(notifications).where(eq(notifications.enquiryId, enquiryId)).orderBy(desc(notifications.createdAt)),
    callIds.length ? db.select().from(callEvents).where(inArray(callEvents.callId, callIds)).orderBy(callEvents.occurredAt) : Promise.resolve([]),
    callIds.length ? db.select().from(callTranscripts).where(inArray(callTranscripts.callId, callIds)) : Promise.resolve([]),
  ]);

  return { ...bundle, attempts, overrides, hubspot: hubspot[0] ?? null, notifications: notifs, events, transcripts };
}
