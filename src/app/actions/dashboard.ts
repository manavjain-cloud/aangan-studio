"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { auditEvents, decisionOverrides, enquiries, fixedCosts, teamMembers } from "@/lib/db/schema";
import { DISPOSITIONS } from "@/lib/domain/types";
import { qualificationConfigSchema } from "@/lib/domain/config";
import { getCalendly, getEmail, getGemini, getHubspot, getVaani } from "@/lib/integrations";
import { acknowledgeEscalation, assignEscalation, resolveEscalation } from "@/lib/services/escalations";
import { processOutbox } from "@/lib/services/jobs";
import { getQualificationConfig, setCostSettings, setQualificationConfig } from "@/lib/services/settings";
import { integrationStatus, type IntegrationName } from "@/lib/env";

const text = (fd: FormData, k: string, max = 500) => String(fd.get(k) ?? "").trim().slice(0, max);
const uuid = z.string().uuid();

/* ---------------- decision override (audited) ---------------- */

export async function overrideDisposition(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = uuid.parse(text(formData, "enquiryId", 60));
  const to = z.enum(DISPOSITIONS).parse(text(formData, "toDisposition", 40));
  const reason = text(formData, "reason", 800);
  if (reason.length < 10) throw new Error("A reason of at least 10 characters is required for an override.");

  const db = await getDb();
  const [enq] = await db.select().from(enquiries).where(eq(enquiries.id, id)).limit(1);
  if (!enq) throw new Error("Enquiry not found");
  await db.update(enquiries).set({ disposition: to, overridden: true, updatedAt: new Date() }).where(eq(enquiries.id, id));
  await db.insert(decisionOverrides).values({ enquiryId: id, fromDisposition: enq.disposition, toDisposition: to, reason, overriddenBy: admin.email });
  await db.insert(auditEvents).values({ actor: admin.email, action: "enquiry.disposition_overridden", entityType: "enquiry", entityId: id, detail: { from: enq.disposition, to, reason: reason.slice(0, 300) } });
  revalidatePath(`/dashboard/enquiries/${id}`);
  revalidatePath("/dashboard");
}

/* ---------------- escalations ---------------- */

export async function ackEscalationAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  await acknowledgeEscalation(await getDb(), uuid.parse(text(formData, "id", 60)), admin.email);
  revalidatePath("/dashboard/exceptions");
}

export async function resolveEscalationAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const note = text(formData, "note", 800);
  if (note.length < 3) throw new Error("A short resolution note is required.");
  await resolveEscalation(await getDb(), uuid.parse(text(formData, "id", 60)), note, admin.email);
  revalidatePath("/dashboard/exceptions");
}

export async function assignEscalationAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const member = text(formData, "memberId", 60);
  await assignEscalation(await getDb(), uuid.parse(text(formData, "id", 60)), member ? uuid.parse(member) : null, admin.email);
  revalidatePath("/dashboard/exceptions");
}

/* ---------------- settings ---------------- */

export async function savePolicyAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const db = await getDb();
  const current = await getQualificationConfig(db);
  const num = (k: string) => Number(text(formData, k, 12));
  const candidate = {
    ...current,
    weights: {
      real_project: num("w_real_project"), service_area: num("w_service_area"), timeline: num("w_timeline"),
      budget: num("w_budget"), decision_maker: num("w_decision_maker"),
    },
    rejectionPolicy: {
      singleHardExclusion: text(formData, "singleHardExclusion", 20),
      singleSoftFailure: text(formData, "singleSoftFailure", 20),
      twoOrMoreFailures: text(formData, "twoOrMoreFailures", 20),
      autoRejectEnabled: formData.get("autoRejectEnabled") === "on",
    },
    timeline: { ...current.timeline, tightAction: text(formData, "tightAction", 20) },
    commercial: { ...current.commercial, minSqft: num("minSqft"), maxSqft: num("maxSqft") },
    escalation: { ...current.escalation, frustratedLeadAutoBook: formData.get("frustratedLeadAutoBook") === "on" },
  };
  const parsed = qualificationConfigSchema.parse(candidate);
  await setQualificationConfig(db, parsed, admin.email);
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?saved=policy");
}

export async function saveCostSettingsAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const n = (k: string) => {
    const v = text(formData, k, 20);
    return v === "" ? null : Number(v);
  };
  await setCostSettings(await getDb(), { vaaniCreditInr: n("vaaniCreditInr"), geminiInputInrPerMillion: n("geminiIn"), geminiOutputInrPerMillion: n("geminiOut") }, admin.email);
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  redirect("/dashboard/settings?saved=costs");
}

export async function addFixedCostAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const row = z
    .object({ provider: z.string().min(2).max(40), label: z.string().min(2).max(80), monthlyInr: z.coerce.number().min(0).max(10_000_000), activeFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
    .parse({ provider: text(formData, "provider", 40), label: text(formData, "label", 80), monthlyInr: text(formData, "monthlyInr", 14), activeFrom: text(formData, "activeFrom", 10) });
  const db = await getDb();
  await db.insert(fixedCosts).values({ provider: row.provider, label: row.label, monthlyInr: String(row.monthlyInr), activeFrom: row.activeFrom });
  await db.insert(auditEvents).values({ actor: admin.email, action: "settings.fixed_cost.added", detail: row });
  revalidatePath("/dashboard/settings");
  revalidatePath("/dashboard");
  redirect("/dashboard/settings?saved=fixedcost");
}

export async function removeFixedCostAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = uuid.parse(text(formData, "id", 60));
  await (await getDb()).delete(fixedCosts).where(eq(fixedCosts.id, id));
  await (await getDb()).insert(auditEvents).values({ actor: admin.email, action: "settings.fixed_cost.removed", entityId: id });
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?saved=fixedcost-removed");
}

export async function addTeamMemberAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const row = z
    .object({
      name: z.string().min(2).max(80), email: z.string().email().max(200), role: z.enum(["designer", "front_desk", "senior"]),
      calendlyEventTypeUri: z.string().regex(/^(https:\/\/api\.calendly\.com\/event_types\/[A-Za-z0-9-]+|calcom:\d+|\d+)$/, "Use a Calendly event type URI (https://api.calendly.com/event_types/...) or a Cal.com event type id (calcom:123)").nullable(),
    })
    .parse({
      name: text(formData, "name", 80), email: text(formData, "email", 200).toLowerCase(), role: text(formData, "role", 20),
      calendlyEventTypeUri: text(formData, "calendlyEventTypeUri", 300) || null,
    });
  if (row.role === "designer" && !row.calendlyEventTypeUri) throw new Error("A designer needs a calendar event type: a Calendly URI (https://api.calendly.com/event_types/...) or a Cal.com id such as calcom:123.");
  const handles = formData.getAll("handles").map(String).filter((h) => h === "residential" || h === "commercial");
  const db = await getDb();
  await db.insert(teamMembers).values({ ...row, handles: handles.length ? handles : ["residential", "commercial"] }).onConflictDoNothing({ target: teamMembers.email });
  await db.insert(auditEvents).values({ actor: admin.email, action: "team.member_added", detail: { email: row.email, role: row.role } });
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?saved=team");
}

export async function toggleTeamMemberAction(formData: FormData): Promise<void> {
  const admin = await requireAdmin();
  const id = uuid.parse(text(formData, "id", 60));
  const active = text(formData, "active", 5) === "true";
  const db = await getDb();
  await db.update(teamMembers).set({ active, updatedAt: new Date() }).where(eq(teamMembers.id, id));
  await db.insert(auditEvents).values({ actor: admin.email, action: "team.member_toggled", entityId: id, detail: { active } });
  revalidatePath("/dashboard/settings");
  redirect("/dashboard/settings?saved=team-updated");
}

/* ---------------- operations ---------------- */

export interface HealthResult {
  name: string;
  mode: string;
  ok: boolean | null;
  detail: string;
}

/** Runs one harmless authenticated call per live integration. Mock/unconfigured integrations are reported as such, never as "OK". */
export async function runHealthChecks(): Promise<HealthResult[]> {
  await requireAdmin();
  const checks: Array<[IntegrationName, () => Promise<{ ok: boolean; detail: string }>]> = [
    ["vaani", () => getVaani().health()],
    ["gemini", () => getGemini().health()],
    ["hubspot", () => getHubspot().health()],
    ["calendly", () => getCalendly().health()],
    ["email", () => getEmail().health()],
  ];
  const out: HealthResult[] = [];
  for (const [name, fn] of checks) {
    const status = integrationStatus(name);
    if (status.mode !== "live") {
      out.push({ name, mode: status.mode, ok: null, detail: status.mode === "mock" ? `Not connected - simulated. Missing: ${status.missing.join(", ") || "FORCE_MOCK_INTEGRATIONS is on"}` : `Not configured. Missing: ${status.missing.join(", ")}` });
      continue;
    }
    try {
      const r = await fn();
      out.push({ name, mode: "live", ok: r.ok, detail: r.detail });
    } catch (err) {
      out.push({ name, mode: "live", ok: false, detail: String((err as Error).message).slice(0, 200) });
    }
  }
  return out;
}

export async function runJobsNowAction(): Promise<{ claimed: number; done: number; retried: number; dead: number }> {
  await requireAdmin();
  const r = await processOutbox(await getDb(), 25, 5);
  revalidatePath("/dashboard/integrations");
  return r;
}

