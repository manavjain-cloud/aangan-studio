import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  bookings,
  calls,
  contacts,
  enquiries,
  escalations,
  qualificationCriteria,
  qualificationResults,
  teamMembers,
} from "../db/schema";
import type { CriterionKey, CriterionStatus, EnquiryFacts } from "../domain/types";

export interface StoredCriterion {
  criterion: CriterionKey;
  status: CriterionStatus;
  weight: number;
  points: number;
  evidence: string;
  hardExclusion: boolean;
  reasonCode: string | null;
  caveat: string | null;
}

export interface EnquiryBundle {
  enquiry: typeof enquiries.$inferSelect;
  facts: EnquiryFacts;
  contact: typeof contacts.$inferSelect | null;
  designer: typeof teamMembers.$inferSelect | null;
  latestCall: typeof calls.$inferSelect | null;
  calls: Array<typeof calls.$inferSelect>;
  qualification: (typeof qualificationResults.$inferSelect & { criteria: StoredCriterion[] }) | null;
  booking: (typeof bookings.$inferSelect) | null;
  escalations: Array<typeof escalations.$inferSelect>;
}

const CRITERION_ORDER: CriterionKey[] = ["real_project", "service_area", "timeline", "budget", "decision_maker"];

export async function loadEnquiryBundle(db: Db, enquiryId: string): Promise<EnquiryBundle | null> {
  const [enquiry] = await db.select().from(enquiries).where(eq(enquiries.id, enquiryId)).limit(1);
  if (!enquiry) return null;

  const [contact] = enquiry.contactId ? await db.select().from(contacts).where(eq(contacts.id, enquiry.contactId)).limit(1) : [];
  const [designer] = enquiry.assignedDesignerId
    ? await db.select().from(teamMembers).where(eq(teamMembers.id, enquiry.assignedDesignerId)).limit(1)
    : [];
  const callRows = await db.select().from(calls).where(eq(calls.enquiryId, enquiryId)).orderBy(desc(calls.receivedAt));
  const [q] = await db
    .select()
    .from(qualificationResults)
    .where(eq(qualificationResults.enquiryId, enquiryId))
    .orderBy(desc(qualificationResults.version))
    .limit(1);

  let qualification: EnquiryBundle["qualification"] = null;
  if (q) {
    const crit = await db.select().from(qualificationCriteria).where(eq(qualificationCriteria.resultId, q.id));
    const criteria: StoredCriterion[] = crit
      .map((c) => ({
        criterion: c.criterion as CriterionKey,
        status: c.status as CriterionStatus,
        weight: c.weight,
        points: c.points,
        evidence: c.evidence,
        hardExclusion: c.hardExclusion,
        reasonCode: c.reasonCode,
        caveat: c.caveat,
      }))
      .sort((a, b) => CRITERION_ORDER.indexOf(a.criterion) - CRITERION_ORDER.indexOf(b.criterion));
    qualification = { ...q, criteria };
  }

  const [booking] = await db
    .select()
    .from(bookings)
    .where(and(eq(bookings.enquiryId, enquiryId), eq(bookings.status, "confirmed")))
    .orderBy(desc(bookings.createdAt))
    .limit(1);
  const escs = await db.select().from(escalations).where(eq(escalations.enquiryId, enquiryId)).orderBy(desc(escalations.createdAt));

  return {
    enquiry,
    facts: enquiry.facts,
    contact: contact ?? null,
    designer: designer ?? null,
    latestCall: callRows[0] ?? null,
    calls: callRows,
    qualification,
    booking: booking ?? null,
    escalations: escs,
  };
}
