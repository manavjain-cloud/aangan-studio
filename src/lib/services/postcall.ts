import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { callTranscripts, calls, contacts, enquiries } from "../db/schema";
import { auditAgentPriceDisclosure } from "../domain/pricing-guard";
import { evaluateQualification } from "../domain/qualification";
import { enquiryFactsSchema, mergeFacts, type EnquiryFacts } from "../domain/types";
import { getEnv, requireNumber } from "../env";
import { getGemini, getVaani } from "../integrations";
import { GeminiInvalidOutputError, GeminiUnavailableError } from "../integrations/gemini/types";
import { createLogger } from "../logging/logger";
import { redactString } from "../logging/redact";
import { DEFAULT_TZ } from "../time";
import { latestBookingFor } from "./booking";
import { createEscalation } from "./escalations";
import type { CallContext } from "./ingest";
import { queueEmail } from "./notifications";
import { PermanentJobError, enqueue, type JobHandler } from "./outbox";
import { buildDeterministicSummary, evaluateAndPersist, latestResult } from "./qualify";
import { getCostSettings, getQualificationConfig } from "./settings";
import { recordGeminiUsage, recordVaaniUsage } from "./usage";
import { logCallEvent, transitionCall } from "./workflow";

const log = createLogger("postcall");

export async function storeTranscript(db: Db, callId: string, transcript: string | null | undefined): Promise<void> {
  if (!transcript) return;
  const days = getEnv().TRANSCRIPT_RETENTION_DAYS;
  const text = redactString(transcript).slice(0, 120_000);
  await db
    .insert(callTranscripts)
    .values({ callId, text, redacted: true, expiresAt: new Date(Date.now() + days * 86_400_000) })
    .onConflictDoUpdate({ target: callTranscripts.callId, set: { text, expiresAt: new Date(Date.now() + days * 86_400_000) } });
}

/** Retention: blank out transcripts past their expiry. Run from the cron endpoint. */
export async function purgeExpiredTranscripts(db: Db): Promise<number> {
  const rows = await db.select({ callId: callTranscripts.callId, expiresAt: callTranscripts.expiresAt }).from(callTranscripts);
  const now = Date.now();
  let n = 0;
  for (const r of rows) {
    if (r.expiresAt && r.expiresAt.getTime() < now) {
      await db.delete(callTranscripts).where(eq(callTranscripts.callId, r.callId));
      n++;
    }
  }
  return n;
}

const FLAGS = ["existing_customer_complaint", "requests_senior", "caller_frustrated", "missed_followup"] as const;

/** Facts captured live win; the transcript only fills gaps. Escalation flags are OR-ed (safe direction). */
function reconcileFacts(live: EnquiryFacts, fromTranscript: EnquiryFacts): EnquiryFacts {
  const merged = mergeFacts(fromTranscript, live as Partial<EnquiryFacts>);
  for (const k of FLAGS) if (fromTranscript[k] === true) merged[k] = true;
  return merged;
}

export const postcallEnrichJob: JobHandler = async ({ db, job, isFinalAttempt }) => {
  const callId = job.payload.callId;
  if (typeof callId !== "string") throw new PermanentJobError("postcall_enrich requires callId");

  const [call] = await db.select().from(calls).where(eq(calls.id, callId)).limit(1);
  if (!call?.enquiryId) throw new PermanentJobError("call or enquiry not found");
  const [enquiry] = await db.select().from(enquiries).where(eq(enquiries.id, call.enquiryId)).limit(1);
  const [contact] = call.contactId ? await db.select().from(contacts).where(eq(contacts.id, call.contactId)).limit(1) : [];
  if (!enquiry) throw new PermanentJobError("enquiry not found");
  const ctx: CallContext = { call, enquiry, contact: contact ?? null, createdNow: false };

  // The delayed fallback job is a no-op if the real post-processing webhook already did the work.
  if (job.payload.fallback === true && call.postProcessedAt) return;

  const [tRow] = await db.select().from(callTranscripts).where(eq(callTranscripts.callId, call.id)).limit(1);
  let transcript = tRow?.text ?? null;
  let vaaniSummary: string | null = null;

  if (!transcript) {
    const d = await getVaani().getCallDetails(call.vaaniCallId).catch(() => null);
    if (d?.ready && d.transcript) {
      transcript = d.transcript;
      vaaniSummary = d.summary;
      await storeTranscript(db, call.id, transcript);
    }
  }

  const env = getEnv();
  const costSettings = await getCostSettings(db, {
    vaaniCreditInr: requireNumber(env.VAANI_CREDIT_INR),
    geminiInputInrPerMillion: requireNumber(env.GEMINI_INPUT_INR_PER_MILLION_TOKENS),
    geminiOutputInrPerMillion: requireNumber(env.GEMINI_OUTPUT_INR_PER_MILLION_TOKENS),
  });

  /* ---- deterministic compliance audit (needs no model) ---- */
  const flags = new Set<string>(call.complianceFlags);
  const priceAudit = auditAgentPriceDisclosure(transcript);

  /* ---- Gemini analysis ---- */
  let summary: string | null = null;
  let handoff: string | null = null;
  let analysisFacts: EnquiryFacts | null = null;
  let confirmedSlot: boolean | null = null;
  let agentPrice = priceAudit.violated;

  if (transcript) {
    const gemini = getGemini();
    let analysis: Awaited<ReturnType<typeof gemini.analyzeTranscript>> | null = null;
    for (let attempt = 0; attempt < 2 && !analysis; attempt++) {
      try {
        analysis = await gemini.analyzeTranscript({ transcript, currentFacts: enquiry.facts, now: call.receivedAt, timezone: DEFAULT_TZ });
      } catch (err) {
        if (err instanceof GeminiInvalidOutputError && attempt === 0) {
          log.warn("gemini returned invalid structured output, retrying once", { callId: call.id });
          continue;
        }
        if (err instanceof GeminiInvalidOutputError || err instanceof GeminiUnavailableError) {
          await logCallEvent(db, call.id, "gemini_failed", { reason: (err as Error).message.slice(0, 200), final: isFinalAttempt });
          if (!isFinalAttempt) throw err; // retry later via outbox backoff
          break;
        }
        throw err;
      }
    }
    if (analysis) {
      summary = analysis.analysis.summary;
      handoff = analysis.analysis.handoff_note;
      analysisFacts = enquiryFactsSchema.parse(analysis.analysis.facts);
      confirmedSlot = analysis.analysis.customer_confirmed_slot;
      agentPrice = agentPrice || analysis.analysis.agent_stated_price;
      await recordGeminiUsage(db, {
        callId: call.id, model: analysis.usage.model, inputTokens: analysis.usage.inputTokens, outputTokens: analysis.usage.outputTokens,
        settings: costSettings, mode: gemini.mode === "live" ? "live" : "mock", dedupe: `${call.id}:analyze`,
      });
    }
  } else if (!isFinalAttempt && job.payload.fallback !== true) {
    throw new Error("transcript not available yet; will retry");
  }

  /* ---- reconcile facts + qualification ---- */
  let facts = enquiry.facts;
  if (analysisFacts) {
    facts = reconcileFacts(enquiry.facts, analysisFacts);
    if (JSON.stringify(facts) !== JSON.stringify(enquiry.facts)) {
      await db.update(enquiries).set({ facts, updatedAt: new Date() }).where(eq(enquiries.id, enquiry.id));
      await logCallEvent(db, call.id, "facts_reconciled_from_transcript", {});
    }
  }

  const booking = await latestBookingFor(db, enquiry.id);
  const config = await getQualificationConfig(db);
  if (booking) {
    // Never silently undo a booking. If post-call evidence disagrees with the live decision, ask a human.
    const re = evaluateQualification(facts, { now: call.receivedAt, config });
    if (re.disposition !== "qualified") {
      await createEscalation(db, {
        enquiryId: enquiry.id, callId: call.id, kind: "post_call_review", urgency: "normal", mode: call.mode,
        reason: `A consultation was booked during the call, but post-call analysis of the transcript now evaluates this enquiry as "${re.disposition}" (${re.reasonCodes.join(", ") || "see criteria"}). Please review.`,
        requestedResponse: "Review the transcript facts and confirm whether the consultation should proceed.",
      });
    }
    if (confirmedSlot === false) flags.add("booking_without_clear_confirmation");
  } else if (!enquiry.overridden) {
    const out = await evaluateAndPersist(db, ctx, { now: call.receivedAt, moveCall: false });
    await logCallEvent(db, call.id, "postcall_reevaluated", { disposition: out.result.disposition });
  }

  /* ---- compliance escalations ---- */
  if (agentPrice) {
    flags.add("agent_price_disclosure");
    await createEscalation(db, {
      enquiryId: enquiry.id, callId: call.id, kind: "compliance_flag", urgency: "high", mode: call.mode,
      reason: `The voice agent appears to have stated a price, range or rate during this call, which the pricing policy forbids. Excerpt: "${priceAudit.excerpts[0] ?? "(detected by model)"}". Review the agent prompt and contact the caller if needed.`,
      requestedResponse: "Review the call and tighten the agent configuration.",
    });
  }
  if (flags.has("booking_without_clear_confirmation")) {
    await createEscalation(db, {
      enquiryId: enquiry.id, callId: call.id, kind: "compliance_flag", urgency: "normal", mode: call.mode,
      reason: "A consultation was booked but the transcript does not show a clear confirmation from the caller.",
      requestedResponse: "Confirm the consultation with the customer.",
    });
  }

  /* ---- persist summaries ---- */
  const latest = await latestResult(db, enquiry.id);
  const fallback = buildDeterministicSummary(facts, latest ? ({ disposition: latest.disposition, score: latest.score } as never) : null);
  const finalSummary = summary ?? vaaniSummary ?? fallback;
  await db.update(enquiries).set({ summary: finalSummary, handoffNote: handoff ?? enquiry.handoffNote, updatedAt: new Date() }).where(eq(enquiries.id, enquiry.id));
  await db.update(calls).set({ summary: finalSummary, postProcessedAt: new Date(), complianceFlags: [...flags], updatedAt: new Date() }).where(eq(calls.id, call.id));

  /* ---- Vaani usage (best effort: call history carries the cost in credits) ---- */
  try {
    const hist = await getVaani().getCallHistory({ page: 1, pageSize: 100 });
    const rec = hist.records.find((r) => r.callId === call.vaaniCallId);
    await recordVaaniUsage(db, {
      callId: call.id, vaaniCallId: call.vaaniCallId, credits: rec?.costCredits ?? null, durationMs: rec?.durationMs ?? call.durationMs,
      settings: costSettings, mode: call.mode,
    });
    if (rec?.costCredits !== null && rec?.costCredits !== undefined) await db.update(calls).set({ vaaniCostCredits: String(rec.costCredits) }).where(eq(calls.id, call.id));
  } catch (err) {
    log.warn("could not fetch Vaani call cost", { callId: call.id, error: String((err as Error).message).slice(0, 120) });
  }

  /* ---- downstream outputs ---- */
  await enqueue(db, { type: "hubspot_sync", key: `hubspot:${enquiry.id}:final:${call.id}`, payload: { enquiryId: enquiry.id } });
  const [after] = await db.select().from(enquiries).where(eq(enquiries.id, enquiry.id)).limit(1);
  if (after?.disposition === "qualified" && !booking) {
    // Qualified but not booked on the call: the designer / front desk must arrange the consultation.
    await queueEmail(db, `handoff:${enquiry.id}:nobooking`, { kind: "qualified_handoff", enquiryId: enquiry.id, callId: call.id, variant: "nobooking" });
  }
  await transitionCall(db, call.id, "completed", { by: "postcall" });
};
