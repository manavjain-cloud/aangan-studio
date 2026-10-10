import { and, eq, gte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { bookings, teamMembers } from "../db/schema";
import { getEnv } from "../env";

export type TeamMember = typeof teamMembers.$inferSelect;

export async function listTeam(db: Db): Promise<TeamMember[]> {
  return db.select().from(teamMembers).orderBy(teamMembers.role, teamMembers.name);
}

/**
 * Designers eligible for a project type, ordered by routing preference:
 * fewest consultations booked in the last 14 days first (spreads load), then routing weight, then name.
 * If no designer rows exist but CALENDLY_DEFAULT_EVENT_TYPE_URI is set, a single "default host" designer is
 * created so booking still works against the one configured event type.
 */
export async function eligibleDesigners(db: Db, projectType: "residential" | "commercial" | null): Promise<TeamMember[]> {
  let designers = await db
    .select()
    .from(teamMembers)
    .where(and(eq(teamMembers.role, "designer"), eq(teamMembers.active, true)));
  designers = designers.filter((d) => !!d.calendlyEventTypeUri && (!projectType || d.handles.includes(projectType)));

  if (designers.length === 0) {
    const uri = getEnv().CALENDLY_DEFAULT_EVENT_TYPE_URI;
    const email = getEnv().FRONT_DESK_EMAIL ?? getEnv().SENIOR_ESCALATION_EMAIL;
    if (uri && email) {
      const [row] = await db
        .insert(teamMembers)
        .values({ name: "Default Calendly host", email, role: "designer", calendlyEventTypeUri: uri })
        .onConflictDoNothing({ target: teamMembers.email })
        .returning();
      if (row) designers = [row];
      else {
        const [existing] = await db.select().from(teamMembers).where(eq(teamMembers.email, email)).limit(1);
        if (existing?.role === "designer" && existing.calendlyEventTypeUri) designers = [existing];
      }
    }
    return designers;
  }

  const since = new Date(Date.now() - 14 * 86_400_000);
  const load = await db
    .select({ designerId: bookings.designerId, n: sql<number>`count(*)::int` })
    .from(bookings)
    .where(and(gte(bookings.createdAt, since), eq(bookings.status, "confirmed")))
    .groupBy(bookings.designerId);
  const loadMap = new Map(load.map((l) => [l.designerId, l.n]));

  return designers.sort(
    (a, b) =>
      (loadMap.get(a.id) ?? 0) / Math.max(a.routingWeight, 1) - (loadMap.get(b.id) ?? 0) / Math.max(b.routingWeight, 1) ||
      a.name.localeCompare(b.name),
  );
}

export interface Recipients {
  frontDesk: string[];
  senior: string[];
  ops: string[];
}

/** Role-based recipients from the team table, falling back to the env addresses. Duplicates removed. */
export async function recipients(db: Db): Promise<Recipients> {
  const env = getEnv();
  const members = await db.select().from(teamMembers).where(eq(teamMembers.active, true));
  const uniq = (xs: Array<string | undefined | null>) => [...new Set(xs.filter((x): x is string => !!x))];
  const frontDesk = uniq([...members.filter((m) => m.role === "front_desk").map((m) => m.email), env.FRONT_DESK_EMAIL]);
  const senior = uniq([...members.filter((m) => m.role === "senior").map((m) => m.email), env.SENIOR_ESCALATION_EMAIL]);
  const ops = uniq([env.OPS_ALERT_EMAIL, ...senior]);
  return { frontDesk, senior, ops };
}
