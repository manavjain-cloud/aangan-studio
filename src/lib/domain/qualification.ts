import { assessBudget } from "./budget";
import { DEFAULT_QUALIFICATION_CONFIG, type QualificationConfig } from "./config";
import { CLOSING, QUESTIONS } from "./messages";
import { matchServiceArea } from "./service-area";
import { assessTimeline } from "./timeline";
import {
  CRITERION_KEYS,
  RULES_VERSION,
  type CriterionKey,
  type CriterionResult,
  type CriterionStatus,
  type Disposition,
  type EnquiryFacts,
  type EscalationDecision,
  type QualificationResult,
} from "./types";

/**
 * Deterministic qualification engine (qualified.md / rubric.txt Part A).
 *
 * Gemini and the voice agent may help *capture* facts, but every decision below is made here, in code,
 * from validated facts. The weighted score is a decision aid and never overrides a failed criterion.
 */

export interface EvaluateOptions {
  now?: Date;
  config?: QualificationConfig;
}

const EXCLUDED_KINDS = new Set(["restaurant", "hotel", "retail_store", "gym"]);
const ADVICE_INTENTS: Record<string, { reason: string; evidence: string }> = {
  advice_only: { reason: "advice_only", evidence: "Caller wants advice or ideas only, not design with execution." },
  styling_only: { reason: "advice_only", evidence: "Caller wants colour/styling or furniture-arrangement advice only." },
  furniture_sourcing_only: { reason: "advice_only", evidence: "Caller wants standalone furniture sourcing, which Aangan does not offer without a design project." },
  vastu_only: { reason: "advice_only", evidence: "Caller wants standalone Vastu advice, which Aangan does not offer." },
  self_execution: { reason: "advice_only", evidence: "Caller intends to handle execution themselves; Aangan's minimum engagement is design with full execution." },
};

function base(key: CriterionKey, weight: number): CriterionResult {
  return { key, status: "unknown", weight, points: 0, evidence: "", hardExclusion: false, reasonCode: null, question: null, caveat: null };
}

function pointsFor(status: CriterionStatus, weight: number): number {
  // unknown_neutral (budget / decision-maker not volunteered) is deliberately NOT penalised.
  return status === "pass" || status === "unknown_neutral" ? weight : 0;
}

function assessRealProject(facts: EnquiryFacts, cfg: QualificationConfig): CriterionResult {
  const r = base("real_project", cfg.weights.real_project);

  if (facts.property_kind && EXCLUDED_KINDS.has(facts.property_kind)) {
    return {
      ...r, status: "fail", hardExclusion: true, reasonCode: "excluded_category",
      evidence: `Project is a ${facts.property_kind.replace("_", " ")}; restaurants, hotels, retail stores and gyms are out of scope.`,
    };
  }
  if (facts.service_intent && facts.service_intent in ADVICE_INTENTS) {
    const a = ADVICE_INTENTS[facts.service_intent]!;
    return { ...r, status: "fail", hardExclusion: true, reasonCode: a.reason, evidence: a.evidence };
  }

  const isCommercial = facts.project_type === "commercial" || ["office", "clinic", "studio", "coworking"].includes(facts.property_kind ?? "");
  if (isCommercial && facts.carpet_area_sqft && facts.carpet_area_sqft > 0) {
    if (facts.carpet_area_sqft < cfg.commercial.minSqft) {
      return {
        ...r, status: "fail", hardExclusion: true, reasonCode: "below_minimum_commercial_scope",
        evidence: `Commercial space of ~${facts.carpet_area_sqft} sq ft is below Aangan's typical minimum commercial scope (${cfg.commercial.minSqft} sq ft).`,
      };
    }
    if (facts.carpet_area_sqft > cfg.commercial.maxSqft) {
      return {
        ...r, status: "human_review", reasonCode: "above_typical_commercial_size",
        evidence: `Commercial space of ~${facts.carpet_area_sqft} sq ft exceeds the typical limit of ~${cfg.commercial.maxSqft} sq ft; needs a human decision.`,
      };
    }
  }
  if (facts.structural_changes_required === true) {
    return {
      ...r, status: "human_review", reasonCode: "structural_changes",
      evidence: "Caller indicates structural changes are needed; Aangan does not move walls or modify the structure, so a human must confirm what can be offered.",
    };
  }

  if (!facts.service_intent) {
    return {
      ...r, status: "unknown", reasonCode: "intent_unknown", question: QUESTIONS.intent,
      evidence: "It is not yet clear whether the caller wants full design and execution or advice only.",
    };
  }
  if (!facts.property_kind && !facts.project_type && !facts.scope) {
    return {
      ...r, status: "unknown", reasonCode: "scope_unknown", question: QUESTIONS.projectKind,
      evidence: "Caller wants design and execution, but the type of space and scope are not yet known.",
    };
  }

  const bits = [
    facts.project_type ?? (isCommercial ? "commercial" : "residential"),
    facts.property_kind?.replace("_", " "),
    facts.scope?.replace(/_/g, " "),
    facts.bhk ? `${facts.bhk}BHK` : null,
    facts.carpet_area_sqft ? `~${facts.carpet_area_sqft} sq ft` : null,
  ].filter(Boolean);
  const caveats: string[] = [];
  if (facts.is_rented === true) caveats.push("Rented property; no structural changes should be involved.");
  return {
    ...r, status: "pass", reasonCode: null,
    evidence: `Caller wants design with full execution: ${bits.join(", ")}.`,
    caveat: caveats.length ? caveats.join(" ") : null,
  };
}

function assessServiceArea(facts: EnquiryFacts, cfg: QualificationConfig): CriterionResult {
  const r = base("service_area", cfg.weights.service_area);
  const m = matchServiceArea(facts.location_text);
  if (m.status === "out_of_area") {
    return {
      ...r, status: "fail", hardExclusion: true, reasonCode: "out_of_area",
      evidence: `Property location "${facts.location_text}" is outside Pune city and PCMC (matched: ${m.matched}).`,
    };
  }
  if (m.status === "in_area") {
    return { ...r, status: "pass", evidence: `Property location "${facts.location_text}" is within the service area (${m.matched}).`, caveat: m.caveat };
  }
  return {
    ...r, status: "unknown", reasonCode: "location_unknown", question: QUESTIONS.locality,
    evidence: m.caveat ?? "Property location has not been confirmed.",
  };
}

function assessTimelineCriterion(facts: EnquiryFacts, cfg: QualificationConfig, now: Date): CriterionResult {
  const r = base("timeline", cfg.weights.timeline);
  const t = assessTimeline(facts, now, cfg.timeline);
  if (t.status === "fail") return { ...r, status: "fail", hardExclusion: true, reasonCode: t.reasonCode, evidence: t.evidence };
  if (t.status === "human_review") return { ...r, status: "human_review", reasonCode: t.reasonCode, evidence: t.evidence, caveat: t.caveat };
  if (t.status === "unknown") return { ...r, status: "unknown", reasonCode: t.reasonCode, question: QUESTIONS.timeline, evidence: t.evidence };
  return { ...r, status: "pass", evidence: t.evidence, caveat: t.caveat, reasonCode: t.reasonCode };
}

function assessBudgetCriterion(facts: EnquiryFacts, cfg: QualificationConfig): CriterionResult {
  const r = base("budget", cfg.weights.budget);
  const b = assessBudget(facts, cfg.budget);
  if (b.status === "fail") return { ...r, status: "fail", hardExclusion: true, reasonCode: b.reasonCode, evidence: b.evidence };
  return { ...r, status: b.status, evidence: b.evidence, caveat: b.caveat };
}

function assessDecisionMaker(facts: EnquiryFacts, cfg: QualificationConfig): CriterionResult {
  const r = base("decision_maker", cfg.weights.decision_maker);
  switch (facts.authority) {
    case "decision_maker":
      return { ...r, status: "pass", evidence: "Caller is the decision-maker." };
    case "authorised_representative":
      return { ...r, status: "pass", evidence: "Caller confirmed they are authorised by the decision-maker to move forward." };
    case "researching_for_other":
      if (facts.decision_makers_will_attend === true) {
        return {
          ...r, status: "unknown_neutral",
          evidence: "Caller is doing initial research for the decision-makers, who will attend the consultation. Provisionally qualified.",
          caveat: "Decision-maker is not the caller; ensure the owners attend the consultation.",
        };
      }
      return {
        ...r, status: "fail", reasonCode: "not_authorised",
        evidence: "Caller is only researching on behalf of someone else and is not authorised to proceed.",
      };
    default:
      return {
        ...r, status: "unknown_neutral",
        evidence: "Decision-maker status not established. Not pushed on the call; treated as provisionally qualified.",
        caveat: "Decision-maker status unclear; confirm that the decision-maker attends the consultation.",
      };
  }
}

function detectEscalation(facts: EnquiryFacts, cfg: QualificationConfig): EscalationDecision | null {
  if (facts.existing_customer_complaint === true) {
    return {
      kind: "existing_customer_complaint",
      urgency: "high",
      reason: "Existing customer with an active project issue or complaint. Not a new sales lead.",
      requestedResponse: "Senior person to call the customer back promptly.",
    };
  }
  if (facts.requests_senior === true) {
    return {
      kind: "senior_requested",
      urgency: "high",
      reason: "Caller asked to speak to a senior person.",
      requestedResponse: "Senior person to call the caller back.",
    };
  }
  if ((facts.caller_frustrated === true || facts.missed_followup === true) && !cfg.escalation.frustratedLeadAutoBook) {
    return {
      kind: "frustrated_returning_lead",
      urgency: "high",
      reason: facts.missed_followup === true
        ? "Returning lead frustrated by a missed follow-up. Handle carefully; do not treat as a routine new lead."
        : "Caller is highly frustrated.",
      requestedResponse: "Same-day personal outreach by a senior designer or the studio head.",
    };
  }
  return null;
}

export function evaluateQualification(facts: EnquiryFacts, opts: EvaluateOptions = {}): QualificationResult {
  const now = opts.now ?? new Date();
  const cfg = opts.config ?? DEFAULT_QUALIFICATION_CONFIG;

  const criteria: CriterionResult[] = [
    assessRealProject(facts, cfg),
    assessServiceArea(facts, cfg),
    assessTimelineCriterion(facts, cfg, now),
    assessBudgetCriterion(facts, cfg),
    assessDecisionMaker(facts, cfg),
  ].map((c) => ({ ...c, points: pointsFor(c.status, c.weight) }));

  const score = criteria.reduce((s, c) => s + c.points, 0);
  const failed = criteria.filter((c) => c.status === "fail");
  const hard = failed.filter((c) => c.hardExclusion);
  const reviews = criteria.filter((c) => c.status === "human_review");
  const unknownCore = criteria.filter((c) => c.status === "unknown" && ["real_project", "service_area", "timeline"].includes(c.key));
  const caveats = criteria.map((c) => c.caveat).filter((c): c is string => !!c);
  const reasonCodes = criteria.map((c) => c.reasonCode).filter((c): c is string => !!c);

  const result = (disposition: Disposition, extra: Partial<QualificationResult> = {}): QualificationResult => ({
    disposition,
    score,
    criteria,
    failedCriteria: failed.map((c) => c.key),
    hardExclusions: hard.map((c) => c.reasonCode ?? c.key),
    reasonCodes,
    caveats,
    nextQuestion: null,
    escalation: null,
    canBook: false,
    closingScript: null,
    rulesVersion: RULES_VERSION,
    evaluatedAt: now.toISOString(),
    ...extra,
  });

  // 1. Escalation signals outrank everything: complaints are never sales leads.
  const esc = detectEscalation(facts, cfg);
  if (esc) return result("human_escalation", { escalation: esc });

  // 2. Confirmed failures.
  if (failed.length > 0) {
    const policy = cfg.rejectionPolicy;
    const rule =
      failed.length >= 2 ? policy.twoOrMoreFailures : hard.length >= 1 ? policy.singleHardExclusion : policy.singleSoftFailure;
    const wouldReject = rule === "reject" && policy.autoRejectEnabled;
    if (wouldReject) {
      const primary = hard[0] ?? failed[0]!;
      const closingScript =
        failed.length >= 2 ? CLOSING.multiple! : (CLOSING[primary.reasonCode ?? ""] ?? CLOSING.generic!);
      return result("rejected", { closingScript });
    }
    return result("human_escalation", {
      escalation: {
        kind: "borderline_review",
        urgency: "normal",
        reason: `Failed criteria (${failed.map((c) => c.key).join(", ")}) need a human decision under the current rejection policy${
          policy.autoRejectEnabled ? "" : " (automatic rejection is switched off)"
        }.`,
        requestedResponse: "Review the criterion-level evidence and either decline politely or arrange a consultation.",
      },
    });
  }

  // 3. Something the rules cannot settle safely.
  if (reviews.length > 0) {
    return result("human_escalation", {
      escalation: {
        kind: "borderline_review",
        urgency: "normal",
        reason: `Needs human judgement: ${reviews.map((c) => `${c.key} (${c.reasonCode ?? "review"})`).join(", ")}.`,
        requestedResponse: "Review the evidence and decide whether to offer a consultation.",
      },
    });
  }

  // 4. Unknowns in criteria 1-3: ask exactly one direct question.
  if (unknownCore.length > 0) {
    const first = unknownCore[0]!;
    return result("clarification_required", { nextQuestion: first.question });
  }

  // 5. Qualified (unknown 4/5 are neutral and recorded as caveats).
  return result("qualified", { canBook: true });
}

export function criterionByKey(r: QualificationResult, key: CriterionKey): CriterionResult {
  const c = r.criteria.find((x) => x.key === key);
  if (!c) throw new Error(`criterion ${key} missing`);
  return c;
}

export { CRITERION_KEYS };
