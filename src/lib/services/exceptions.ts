import { and, desc, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "../db/client";
import { bookingAttempts, calls, contacts, enquiries, escalations, teamMembers } from "../db/schema";
import { SCOPE_MODES, type DataScope } from "./analytics";

export async function getExceptions(db: Db, scope: DataScope, status: "active" | "all") {
  const modes = SCOPE_MODES[scope];
  const escRows = await db
    .select({ e: escalations, enq: enquiries, c: contacts, owner: teamMembers })
    .from(escalations)
    .leftJoin(enquiries, eq(escalations.enquiryId, enquiries.id))
    .leftJoin(contacts, eq(enquiries.contactId, contacts.id))
    .leftJoin(teamMembers, eq(escalations.assignedToId, teamMembers.id))
    .where(and(inArray(escalations.mode, modes), status === "active" ? ne(escalations.status, "resolved") : undefined))
    .orderBy(desc(escalations.createdAt))
    .limit(100);

  // Enquiries that ended without enough information to decide, and with no human yet involved.
  const uncertain = await db
    .select({ enq: enquiries, c: contacts, call: calls })
    .from(enquiries)
    .leftJoin(contacts, eq(enquiries.contactId, contacts.id))
    .innerJoin(calls, eq(calls.enquiryId, enquiries.id))
    .where(and(eq(enquiries.disposition, "clarification_required"), inArray(enquiries.mode, modes), inArray(calls.state, ["abandoned", "completed"])))
    .orderBy(desc(calls.receivedAt))
    .limit(50);
  const seen = new Set<string>();
  const uncertainRows = uncertain.filter((u) => (seen.has(u.enq.id) ? false : (seen.add(u.enq.id), true)));

  const failedBookings = await db
    .select({ a: bookingAttempts, enq: enquiries, c: contacts })
    .from(bookingAttempts)
    .leftJoin(enquiries, eq(bookingAttempts.enquiryId, enquiries.id))
    .leftJoin(contacts, eq(enquiries.contactId, contacts.id))
    .where(and(inArray(bookingAttempts.mode, modes), inArray(bookingAttempts.status, ["failed", "unconfirmed"])))
    .orderBy(desc(bookingAttempts.createdAt))
    .limit(50);

  const team = await db.select().from(teamMembers).where(eq(teamMembers.active, true));
  return { escRows, uncertainRows, failedBookings, team };
}
