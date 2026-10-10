import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { calls, contacts, enquiries, qualificationCriteria, qualificationResults } from "../db/schema";
import { evaluateQualification } from "../domain/qualification";
import { scanTextSignals } from "../domain/signals";
import {
  mergeFacts,
  type EnquiryFacts,
  type QualificationResult,
} from "../domain/types";
import { createLogger } from "../logging/logger";
import { createEscalation } from "./escalations";
import { normalizeEmail, type CallContext, type EnquiryRow } from "./ingest";
import { getQualificationConfig } from "./settings";
import { advanceThrough, logCallEvent, type CallState } from "./workflow";

const log = createLogger("qualify");

const DISPOSITION_TO_STATE: Record<QualificationResult["disposition"], CallState> = {
  qualified: "qualified",
  clarification_required: "clarification_required",
  rejected: "rejected",
  human_escalation: "human_escalation",
};

const FREE_TEXT_FIELDS = ["notes", "availability_notes", "rooms_description", "location_text"] as const;

/**
 * Merge newly captured facts into the enquiry (merge-only: null never erases a known value), validate them,
 * and refresh the contact. Free text is scanned for prompt-injection and escalation signals as a safety net.
 */
export async function saveFacts(
  db: Db,
  ctx: CallContext,
  incoming: Partial<EnquiryFacts>,
): Promise<{ enquiry: EnquiryRow; facts: EnquiryFacts; emailRejected: boolean; contactName: string | null }> {
  const base = ctx.enquiry.facts;
  let emailRejected = false;
  const patch: Partial<EnquiryFacts> = { ...incoming };

  if (patch.caller_email) {
    const normalised = normalizeEmail(patch.caller_email);
    if (!normalised) emailRejected = true;
    patch.caller_email = normalised;
  }

  let facts = mergeFacts(base, patch);

  const text = FREE_TEXT_FIELDS.map((f) => facts[f]).filter(Boolean).join(" \n ");
  if (text) {
    const sig = scanTextSignals(text);
    if (sig.promptInjection) {
      await logCallEvent(db, ctx.call.id, "prompt_injection_suspected", { fields: FREE_TEXT_FIELDS.filter((f) => facts[f]) });
      log.warn("prompt injection suspected in captured text", { callId: ctx.call.id });
    }
    const escalated: Partial<EnquiryFacts> = {};
    if (sig.complaint && facts.existing_customer_complaint !== true) escalated.existing_customer_complaint = true;
    if (sig.wantsSenior && facts.requests_senior !== true) escalated.requests_senior = true;
    if (sig.missedFollowup && facts.missed_followup !== true) escalated.missed_followup = true;
    if (Object.keys(escalated).length) {
      facts = mergeFacts(facts, escalated);
      await logCallEvent(db, ctx.call.id, "escalation_signal_from_text", { flags: Object.keys(escalated) });
    }
  }

  const [enquiry] = await db.update(enquiries).set({ facts, updatedAt: new Date() }).where(eq(enquiries.id, ctx.enquiry.id)).returning();

  let contactName: string | null = ctx.contact?.name ?? null;
  if (ctx.contact && (facts.caller_name || facts.caller_email)) {
    const patchC: Partial<typeof contacts.$inferInsert> = {};
    if (!ctx.contact.name && facts.caller_name) patchC.name = facts.caller_name;
    if (!ctx.contact.email && facts.caller_email) patchC.email = facts.caller_email;
    if (Object.keys(patchC).length) {
      const [c] = await db.update(contacts).set({ ...patchC, updatedAt: new Date() }).where(eq(contacts.id, ctx.contact.id)).returning();
      contactName = c?.name ?? contactName;
    }
  }

  await advanceThrough(db, ctx.call.id, ["agent_active", "capturing_information"]);
  return { enquiry: enquiry!, facts, emailRejected, contactName };
}

export interface EvaluationOutcome {
  result: QualificationResult;
  resultId: string;
  version: number;
  escalationId: string | null;
}

/** Run the deterministic engine, persist the criterion-level decision, move the call, and raise escalations. */
export async function evaluateAndPersist(db: Db, ctx: CallContext, opts: { now?: Date; moveCall?: boolean } = {}): Promise<EvaluationOutcome> {
  const config = await getQualificationConfig(db);
  const [fresh] = await db.select().from(enquiries).where(eq(enquiries.id, ctx.enquiry.id)).limit(1);
  const facts = fresh!.facts;
  const result = evaluateQualification(facts, { now: opts.now, config });

  const [last] = await db
    .select({ v: qualificationResults.version })
    .from(qualificationResults)
    .where(eq(qualificationResults.enquiryId, ctx.enquiry.id))
    .orderBy(desc(qualificationResults.version))
    .limit(1);
  const version = (last?.v ?? 0) + 1;

  const [stored] = await db
    .insert(qualificationResults)
    .values({
      enquiryId: ctx.enquiry.id, callId: ctx.call.id, version, disposition: result.disposition, score: result.score, canBook: result.canBook,
      nextQuestion: result.nextQuestion, reasonCodes: result.reasonCodes, caveats: result.caveats, factsSnapshot: facts,
      policySnapshot: { rejectionPolicy: config.rejectionPolicy, weights: config.weights, timeline: config.timeline, commercial: config.commercial },
      rulesVersion: result.rulesVersion, evaluatedAt: new Date(result.evaluatedAt),
    })
    .returning({ id: qualificationResults.id });

  await db.insert(qualificationCriteria).values(
    result.criteria.map((c) => ({
      resultId: stored!.id, criterion: c.key, status: c.status, weight: c.weight, points: c.points, evidence: c.evidence,
      hardExclusion: c.hardExclusion, reasonCode: c.reasonCode, caveat: c.caveat,
    })),
  );

  // A human override is final: automated re-evaluation must not flip it back.
  if (!fresh!.overridden) {
    await db.update(enquiries).set({ disposition: result.disposition, score: result.score, updatedAt: new Date() }).where(eq(enquiries.id, ctx.enquiry.id));
  }

  // Live evaluations move the call through the workflow; post-call re-evaluations only refresh the record.
  if (opts.moveCall !== false) {
    await advanceThrough(db, ctx.call.id, ["agent_active", "capturing_information", "checking_qualification", DISPOSITION_TO_STATE[result.disposition]]);
  }
  await logCallEvent(db, ctx.call.id, "qualification_evaluated", {
    disposition: result.disposition, score: result.score, version, failed: result.failedCriteria, reasons: result.reasonCodes,
  });

  let escalationId: string | null = null;
  if (result.disposition === "human_escalation" && result.escalation) {
    const e = await createEscalation(db, {
      enquiryId: ctx.enquiry.id, callId: ctx.call.id, kind: result.escalation.kind, urgency: result.escalation.urgency,
      reason: result.escalation.reason, requestedResponse: result.escalation.requestedResponse, mode: ctx.call.mode,
    });
    escalationId = e.id;
  }
  return { result, resultId: stored!.id, version, escalationId };
}

/** Deterministic, fact-only summary used when Gemini is unavailable. Clearly labelled; never invents detail. */
export function buildDeterministicSummary(facts: EnquiryFacts, result: QualificationResult | null): string {
  const bits: string[] = [];
  if (facts.caller_name) bits.push(`Caller: ${facts.caller_name}.`);
  const proj = [facts.project_type, facts.property_kind?.replace(/_/g, " "), facts.scope?.replace(/_/g, " "), facts.bhk ? `${facts.bhk}BHK` : null, facts.carpet_area_sqft ? `~${facts.carpet_area_sqft} sq ft` : null]
    .filter(Boolean).join(", ");
  if (proj) bits.push(`Project: ${proj}.`);
  if (facts.location_text) bits.push(`Location: ${facts.location_text}.`);
  if (facts.desired_completion_date) bits.push(`Wants completion by ${facts.desired_completion_date}.`);
  else if (facts.timeline_flexible) bits.push("No fixed deadline.");
  if (facts.asked_about_pricing) bits.push("Asked about pricing; the approved deflection was used and no figure was quoted.");
  if (result) bits.push(`Outcome: ${result.disposition.replace(/_/g, " ")} (score ${result.score}/100).`);
  return `${bits.join(" ")} (Auto-generated from captured fields; AI summary unavailable.)`.trim();
}

export async function latestResult(db: Db, enquiryId: string) {
  const [r] = await db.select().from(qualificationResults).where(eq(qualificationResults.enquiryId, enquiryId)).orderBy(desc(qualificationResults.version)).limit(1);
  return r ?? null;
}

export async function touchCall(db: Db, callId: string, patch: Partial<typeof calls.$inferInsert>): Promise<void> {
  await db.update(calls).set({ ...patch, updatedAt: new Date() }).where(eq(calls.id, callId));
}

