import { and, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  bookingAttempts,
  bookings,
  calls,
  contacts,
  enquiries,
  escalations,
  integrationEvents,
  notifications,
  outboxJobs,
  qualificationCriteria,
  qualificationResults,
  type DataMode,
} from "../db/schema";
import { allIntegrationStatuses } from "../env";
import { addDaysIso, DEFAULT_TZ, isoDateInZone, startOfDayUtc } from "../time";
import { costSummary, type CostSummary } from "./usage";

export type DataScope = "all" | "live" | "simulated";

export const SCOPE_MODES: Record<DataScope, DataMode[]> = {
  all: ["live", "mock", "seed"],
  live: ["live"],
  simulated: ["mock", "seed"],
};

export interface DashboardRange {
  fromIso: string;
  toIso: string; // inclusive day
  from: Date;
  to: Date; // exclusive instant
  preset: string;
}

export function resolveRange(params: { range?: string; from?: string; to?: string }, now: Date = new Date()): DashboardRange {
  const today = isoDateInZone(now, DEFAULT_TZ);
  const isIso = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  let fromIso: string;
  let toIso = today;
  let preset = params.range ?? "30d";
  if (isIso(params.from) && isIso(params.to) && params.from! <= params.to!) {
    fromIso = params.from!;
    toIso = params.to!;
    preset = "custom";
  } else if (preset === "today") fromIso = today;
  else if (preset === "7d") fromIso = addDaysIso(today, -6);
  else if (preset === "90d") fromIso = addDaysIso(today, -89);
  else if (preset === "mtd") fromIso = `${today.slice(0, 8)}01`;
  else {
    preset = "30d";
    fromIso = addDaysIso(today, -29);
  }
  // Cap at 366 days so a hand-edited URL cannot trigger a huge scan.
  if (Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`) > 366 * 86_400_000) fromIso = addDaysIso(toIso, -366);
  return { fromIso, toIso, from: startOfDayUtc(fromIso, DEFAULT_TZ), to: startOfDayUtc(addDaysIso(toIso, 1), DEFAULT_TZ), preset };
}

export const REASON_LABELS: Record<string, string> = {
  out_of_area: "Outside Pune / PCMC",
  advice_only: "Advice or styling only",
  excluded_category: "Out-of-scope space type",
  below_minimum_commercial_scope: "Commercial space too small",
  timeline_impossible: "Timeline not feasible",
  timeline_execution_window: "Execution window too short",
  budget_clearly_inadequate: "Volunteered budget clearly inadequate",
  not_authorised: "Caller not authorised to proceed",
};

const RESPONSE_BUCKETS: Array<[string, number, number]> = [
  ["under 10 s", 0, 10],
  ["10-30 s", 10, 30],
  ["30-60 s", 30, 60],
  ["1-5 min", 60, 300],
  ["over 5 min", 300, Infinity],
];

function quantile(sorted: number[], q: number): number | null {
  if (!sorted.length) return null;
  const i = Math.min(sorted.length - 1, Math.floor(q * sorted.length));
  return sorted[i]!;
}

export interface Overview {
  range: DashboardRange;
  scope: DataScope;
  composition: Record<DataMode, number>;
  calls: { total: number; answered: number; missed: number; inProgress: number; afterHours: number; afterHoursPct: number | null; repeat: number };
  response: { targetSec: number; buckets: Array<{ label: string; count: number }>; withinTargetPct: number | null; medianSec: number | null; p90Sec: number | null; measuredCalls: number };
  humanFollowUp: { open: number; acknowledged: number; resolved: number; medianAckMinutes: number | null };
  outcomes: { qualified: number; clarification: number; rejected: number; escalated: number };
  rejectionReasons: Array<{ code: string; label: string; count: number }>;
  funnel: Array<{ key: string; label: string; count: number }>;
  bookings: { confirmed: number; attempts: number; failed: number; unconfirmed: number; slotTaken: number; failureRatePct: number | null };
  trend: Array<{ date: string; calls: number; qualified: number; rejected: number; escalated: number; booked: number }>;
  cost: CostSummary & { perCallInr: number | null; perQualifiedInr: number | null };
  escalationsByKind: Array<{ kind: string; count: number }>;
  recentCalls: Array<{ id: string; at: string; phone: string | null; name: string | null; state: string; disposition: string; score: number | null; afterHours: boolean; answered: boolean; mode: DataMode; enquiryId: string | null }>;
  health: IntegrationHealth;
}

export interface IntegrationHealth {
  integrations: Array<{ name: string; mode: string; missing: string[]; note: string | null; failures24h: number }>;
  outbox: { pending: number; failed: number; dead: number };
  notifications: { sent: number; failed: number };
}

export async function integrationHealth(db: Db): Promise<IntegrationHealth> {
  const since = new Date(Date.now() - 24 * 3600_000);
  const failures = await db
    .select({ integration: integrationEvents.integration, n: sql<number>`count(*)::int` })
    .from(integrationEvents)
    .where(and(gte(integrationEvents.createdAt, since), eq(integrationEvents.status, "failed")))
    .groupBy(integrationEvents.integration);
  const fMap = new Map(failures.map((f) => [f.integration, f.n]));
  const jobs = await db.select({ status: outboxJobs.status, n: sql<number>`count(*)::int` }).from(outboxJobs).groupBy(outboxJobs.status);
  const j = (s: string) => jobs.find((x) => x.status === s)?.n ?? 0;
  const notif = await db.select({ status: notifications.status, n: sql<number>`count(*)::int` }).from(notifications).where(gte(notifications.createdAt, since)).groupBy(notifications.status);
  return {
    integrations: allIntegrationStatuses().map((s) => ({ name: s.name, mode: s.mode, missing: s.missing, note: s.note, failures24h: fMap.get(s.name) ?? 0 })),
    outbox: { pending: j("pending") + j("running"), failed: j("failed"), dead: j("dead") },
    notifications: { sent: notif.find((x) => x.status === "sent")?.n ?? 0, failed: notif.find((x) => x.status === "failed")?.n ?? 0 },
  };
}

export async function getOverview(db: Db, range: DashboardRange, scope: DataScope): Promise<Overview> {
  const modes = SCOPE_MODES[scope];
  const inRange = and(gte(calls.receivedAt, range.from), lt(calls.receivedAt, range.to), inArray(calls.mode, modes));

  const callRows = await db.select().from(calls).where(inRange).orderBy(desc(calls.receivedAt));
  const compRows = await db
    .select({ mode: calls.mode, n: sql<number>`count(*)::int` })
    .from(calls)
    .where(and(gte(calls.receivedAt, range.from), lt(calls.receivedAt, range.to)))
    .groupBy(calls.mode);
  const composition: Record<DataMode, number> = { live: 0, mock: 0, seed: 0 };
  for (const c of compRows) composition[c.mode] = c.n;

  const enquiryIds = [...new Set(callRows.map((c) => c.enquiryId).filter((x): x is string => !!x))];
  const enqRows = enquiryIds.length ? await db.select().from(enquiries).where(inArray(enquiries.id, enquiryIds)) : [];
  const enqMap = new Map(enqRows.map((e) => [e.id, e]));
  const contactIds = [...new Set(callRows.map((c) => c.contactId).filter((x): x is string => !!x))];
  const contactRows = contactIds.length ? await db.select().from(contacts).where(inArray(contacts.id, contactIds)) : [];
  const contactMap = new Map(contactRows.map((c) => [c.id, c]));

  const ended = callRows.filter((c) => c.endedAt);
  const answered = callRows.filter((c) => c.answered).length;
  const missed = ended.filter((c) => !c.answered).length;
  const afterHours = callRows.filter((c) => c.afterHours).length;

  /* response time (answer latency, seconds) */
  const secs = callRows.filter((c) => c.answeredAt).map((c) => Math.max((c.answeredAt!.getTime() - c.receivedAt.getTime()) / 1000, 0)).sort((a, b) => a - b);
  const TARGET = 300;
  const buckets = RESPONSE_BUCKETS.map(([label, lo, hi]) => ({ label, count: secs.filter((s) => s >= lo && s < hi).length }));
  buckets.push({ label: "not answered", count: missed });
  const decided = secs.length + missed;
  const within = secs.filter((s) => s <= TARGET).length;

  /* outcomes per enquiry (distinct) */
  const outcomes = { qualified: 0, clarification: 0, rejected: 0, escalated: 0 };
  for (const e of enqRows) {
    if (e.disposition === "qualified") outcomes.qualified++;
    else if (e.disposition === "rejected") outcomes.rejected++;
    else if (e.disposition === "human_escalation") outcomes.escalated++;
    else outcomes.clarification++;
  }

  /* rejection reasons from criterion-level evidence of the latest result per rejected enquiry */
  const rejectedIds = enqRows.filter((e) => e.disposition === "rejected").map((e) => e.id);
  const reasons = new Map<string, number>();
  if (rejectedIds.length) {
    const latest = await db
      .select({ id: qualificationResults.id, enquiryId: qualificationResults.enquiryId, version: qualificationResults.version })
      .from(qualificationResults)
      .where(inArray(qualificationResults.enquiryId, rejectedIds));
    const best = new Map<string, { id: string; version: number }>();
    for (const r of latest) if (!best.has(r.enquiryId) || best.get(r.enquiryId)!.version < r.version) best.set(r.enquiryId, { id: r.id, version: r.version });
    const crit = best.size
      ? await db.select().from(qualificationCriteria).where(and(inArray(qualificationCriteria.resultId, [...best.values()].map((b) => b.id)), eq(qualificationCriteria.status, "fail")))
      : [];
    for (const c of crit) reasons.set(c.reasonCode ?? c.criterion, (reasons.get(c.reasonCode ?? c.criterion) ?? 0) + 1);
  }

  /* bookings */
  const enquiryScope = enquiryIds.length ? inArray(bookings.enquiryId, enquiryIds) : sql`false`;
  const bookingRows = await db.select().from(bookings).where(and(enquiryScope, eq(bookings.status, "confirmed")));
  const attemptRows = await db.select().from(bookingAttempts).where(enquiryIds.length ? inArray(bookingAttempts.enquiryId, enquiryIds) : sql`false`);
  const failed = attemptRows.filter((a) => a.status === "failed").length;
  const unconfirmed = attemptRows.filter((a) => a.status === "unconfirmed").length;
  const slotTaken = attemptRows.filter((a) => a.status === "slot_unavailable").length;
  const decidedAttempts = attemptRows.filter((a) => a.status !== "pending").length;

  /* escalations */
  const escRows = await db
    .select()
    .from(escalations)
    .where(and(gte(escalations.createdAt, range.from), lt(escalations.createdAt, range.to), inArray(escalations.mode, modes)));
  const acks = escRows.filter((e) => e.acknowledgedAt).map((e) => (e.acknowledgedAt!.getTime() - e.createdAt.getTime()) / 60_000).sort((a, b) => a - b);
  const kindCount = new Map<string, number>();
  for (const e of escRows) kindCount.set(e.kind, (kindCount.get(e.kind) ?? 0) + 1);

  /* funnel */
  const withResult = enquiryIds.length
    ? await db.select({ id: qualificationResults.enquiryId }).from(qualificationResults).where(inArray(qualificationResults.enquiryId, enquiryIds)).groupBy(qualificationResults.enquiryId)
    : [];
  const bookedEnquiries = new Set(bookingRows.map((b) => b.enquiryId)).size;
  const funnel = [
    { key: "calls", label: "Calls received", count: callRows.length },
    { key: "answered", label: "Answered by the agent", count: answered },
    { key: "evaluated", label: "Qualification evaluated", count: withResult.length },
    { key: "qualified", label: "Qualified for a designer", count: outcomes.qualified },
    { key: "booked", label: "Consultation booked", count: bookedEnquiries },
  ];

  /* trend by IST day */
  const days: string[] = [];
  for (let d = range.fromIso; d <= range.toIso && days.length < 400; d = addDaysIso(d, 1)) days.push(d);
  const trendMap = new Map(days.map((d) => [d, { date: d, calls: 0, qualified: 0, rejected: 0, escalated: 0, booked: 0 }]));
  for (const c of callRows) {
    const t = trendMap.get(isoDateInZone(c.receivedAt, DEFAULT_TZ));
    if (!t) continue;
    t.calls++;
    const e = c.enquiryId ? enqMap.get(c.enquiryId) : undefined;
    if (e?.disposition === "qualified") t.qualified++;
    else if (e?.disposition === "rejected") t.rejected++;
    else if (e?.disposition === "human_escalation") t.escalated++;
  }
  for (const b of bookingRows) {
    const t = trendMap.get(isoDateInZone(b.createdAt, DEFAULT_TZ));
    if (t) t.booked++;
  }

  const costs = await costSummary(db, range.from, range.to, modes);
  const perCall = costs.totalKnownInr !== null && callRows.length ? costs.totalKnownInr / callRows.length : null;
  const perQualified = costs.totalKnownInr !== null && outcomes.qualified ? costs.totalKnownInr / outcomes.qualified : null;

  return {
    range,
    scope,
    composition,
    calls: { total: callRows.length, answered, missed, inProgress: callRows.length - ended.length, afterHours, afterHoursPct: callRows.length ? (afterHours / callRows.length) * 100 : null, repeat: callRows.filter((c) => c.relatedCallId).length },
    response: { targetSec: TARGET, buckets, withinTargetPct: decided ? (within / decided) * 100 : null, medianSec: quantile(secs, 0.5), p90Sec: quantile(secs, 0.9), measuredCalls: secs.length },
    humanFollowUp: { open: escRows.filter((e) => e.status === "open").length, acknowledged: escRows.filter((e) => e.status === "acknowledged").length, resolved: escRows.filter((e) => e.status === "resolved").length, medianAckMinutes: quantile(acks, 0.5) },
    outcomes,
    rejectionReasons: [...reasons.entries()].map(([code, count]) => ({ code, label: REASON_LABELS[code] ?? code.replace(/_/g, " "), count })).sort((a, b) => b.count - a.count),
    funnel,
    bookings: { confirmed: bookingRows.length, attempts: decidedAttempts, failed, unconfirmed, slotTaken, failureRatePct: decidedAttempts ? ((failed + unconfirmed) / decidedAttempts) * 100 : null },
    trend: [...trendMap.values()],
    cost: { ...costs, perCallInr: perCall, perQualifiedInr: perQualified },
    escalationsByKind: [...kindCount.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    recentCalls: callRows.slice(0, 12).map((c) => {
      const e = c.enquiryId ? enqMap.get(c.enquiryId) : undefined;
      const ct = c.contactId ? contactMap.get(c.contactId) : undefined;
      return { id: c.id, at: c.receivedAt.toISOString(), phone: c.fromNumber, name: ct?.name ?? e?.facts.caller_name ?? null, state: c.state, disposition: e?.disposition ?? "n/a", score: e?.score ?? null, afterHours: c.afterHours, answered: c.answered, mode: c.mode, enquiryId: c.enquiryId };
    }),
    health: await integrationHealth(db),
  };
}

/* ------------------------------------------------------------ enquiry list */

export interface EnquiryListFilter {
  q?: string;
  disposition?: string;
  scope: DataScope;
  range: DashboardRange;
  page?: number;
}

export async function listEnquiries(db: Db, f: EnquiryListFilter) {
  const pageSize = 25;
  const page = Math.max(f.page ?? 1, 1);
  const conds = [gte(enquiries.createdAt, f.range.from), lt(enquiries.createdAt, f.range.to), inArray(enquiries.mode, SCOPE_MODES[f.scope])];
  if (f.disposition && ["qualified", "rejected", "human_escalation", "clarification_required"].includes(f.disposition)) conds.push(eq(enquiries.disposition, f.disposition));
  if (f.q?.trim()) {
    const like = `%${f.q.trim().replace(/[%_]/g, "")}%`;
    conds.push(or(ilike(contacts.name, like), ilike(contacts.phoneE164, like), ilike(contacts.email, like), sql`${enquiries.facts}->>'location_text' ilike ${like}`, sql`${enquiries.facts}->>'caller_name' ilike ${like}`)!);
  }
  const where = and(...conds);
  const [{ n }] = (await db.select({ n: sql<number>`count(*)::int` }).from(enquiries).leftJoin(contacts, eq(enquiries.contactId, contacts.id)).where(where)) as [{ n: number }];
  const rows = await db
    .select({ e: enquiries, c: contacts })
    .from(enquiries)
    .leftJoin(contacts, eq(enquiries.contactId, contacts.id))
    .where(where)
    .orderBy(desc(enquiries.createdAt))
    .limit(pageSize)
    .offset((page - 1) * pageSize);
  const ids = rows.map((r) => r.e.id);
  const booked = ids.length ? await db.select({ enquiryId: bookings.enquiryId, start: bookings.startTime }).from(bookings).where(and(inArray(bookings.enquiryId, ids), eq(bookings.status, "confirmed"))) : [];
  const bookedMap = new Map(booked.map((b) => [b.enquiryId, b.start]));
  return {
    total: n,
    page,
    pageSize,
    rows: rows.map(({ e, c }) => ({
      id: e.id, createdAt: e.createdAt, name: c?.name ?? e.facts.caller_name ?? null, phone: c?.phoneE164 ?? null, disposition: e.disposition, score: e.score,
      location: e.facts.location_text, project: [e.facts.project_type, e.facts.scope?.replace(/_/g, " ")].filter(Boolean).join(" / "), overridden: e.overridden,
      bookedAt: bookedMap.get(e.id) ?? null, mode: e.mode,
    })),
  };
}
