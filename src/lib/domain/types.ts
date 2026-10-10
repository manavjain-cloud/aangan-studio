import { z } from "zod";
import { zBool, zDateOnly, zLooseEnum, zNumber, zText } from "./coerce";

/* -------------------------------------------------------------------------- */
/* Criteria and dispositions (qualified.md / rubric.txt Part A)               */
/* -------------------------------------------------------------------------- */

export const CRITERION_KEYS = ["real_project", "service_area", "timeline", "budget", "decision_maker"] as const;
export type CriterionKey = (typeof CRITERION_KEYS)[number];

export const CRITERION_LABELS: Record<CriterionKey, string> = {
  real_project: "Real project (design + execution)",
  service_area: "Within service area",
  timeline: "Realistic timeline & site readiness",
  budget: "Broad budget fit (volunteered only)",
  decision_maker: "Decision-maker / authorised representative",
};

export const CRITERION_STATUSES = ["pass", "fail", "unknown", "unknown_neutral", "human_review"] as const;
export type CriterionStatus = (typeof CRITERION_STATUSES)[number];

export const DISPOSITIONS = ["qualified", "clarification_required", "rejected", "human_escalation"] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

export const ESCALATION_KINDS = [
  "existing_customer_complaint",
  "frustrated_returning_lead",
  "senior_requested",
  "borderline_review",
  "booking_failure",
  "integration_failure",
  "compliance_flag",
  "post_call_review",
  "other",
] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* Structured facts captured from the call                                    */
/* -------------------------------------------------------------------------- */

export const PROPERTY_KINDS = [
  "apartment",
  "independent_house",
  "villa",
  "office",
  "clinic",
  "studio",
  "coworking",
  "restaurant",
  "hotel",
  "retail_store",
  "gym",
  "other",
] as const;

export const SERVICE_INTENTS = [
  "design_and_execution",
  "advice_only",
  "styling_only",
  "furniture_sourcing_only",
  "vastu_only",
  "self_execution",
] as const;

export const SCOPES = ["full_home", "partial_home", "single_room_full", "office_fitout", "other"] as const;

export const SITE_CONDITIONS = ["bare_shell", "new_possession_empty", "occupied", "under_construction", "vacant_old"] as const;

export const AUTHORITY = ["decision_maker", "authorised_representative", "researching_for_other"] as const;

/**
 * Every field is nullable: null means "not captured yet", which the engine treats as unknown and
 * never as a pass for criteria 1-3.
 */
export const enquiryFactsSchema = z.object({
  caller_name: zText(120),
  caller_email: zText(200),
  project_type: zLooseEnum(["residential", "commercial"] as const),
  property_kind: zLooseEnum(PROPERTY_KINDS),
  service_intent: zLooseEnum(SERVICE_INTENTS),
  scope: zLooseEnum(SCOPES),
  rooms_count: zNumber,
  rooms_description: zText(300),
  bhk: zNumber,
  carpet_area_sqft: zNumber,
  location_text: zText(200),
  site_condition: zLooseEnum(SITE_CONDITIONS),
  is_rented: zBool,
  structural_changes_required: zBool,
  desired_completion_date: zDateOnly,
  timeline_flexible: zBool,
  site_available_date: zDateOnly,
  site_available_now: zBool,
  authority: zLooseEnum(AUTHORITY),
  decision_makers_will_attend: zBool,
  budget_inr_min: zNumber,
  budget_inr_max: zNumber,
  budget_declined: zBool,
  asked_about_pricing: zBool,
  existing_customer_complaint: zBool,
  requests_senior: zBool,
  caller_frustrated: zBool,
  missed_followup: zBool,
  availability_notes: zText(300),
  notes: zText(600),
});

export type EnquiryFacts = z.infer<typeof enquiryFactsSchema>;

export function emptyFacts(): EnquiryFacts {
  return enquiryFactsSchema.parse({});
}

/** Merge new facts over old: a non-null incoming value wins, null never erases a known value. */
export function mergeFacts(base: EnquiryFacts, incoming: Partial<EnquiryFacts>): EnquiryFacts {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(incoming)) {
    if (v !== null && v !== undefined) out[k] = v;
  }
  return out as EnquiryFacts;
}

/* -------------------------------------------------------------------------- */
/* Evaluation results                                                         */
/* -------------------------------------------------------------------------- */

export interface CriterionResult {
  key: CriterionKey;
  status: CriterionStatus;
  weight: number;
  points: number;
  evidence: string;
  /** A confirmed hard exclusion (out-of-area, excluded project type, impossible timeline, clearly inadequate budget). */
  hardExclusion: boolean;
  reasonCode: string | null;
  /** Single direct question to ask when status is "unknown" (criteria 1-3). */
  question: string | null;
  caveat: string | null;
}

export interface EscalationDecision {
  kind: EscalationKind;
  urgency: "normal" | "high";
  reason: string;
  requestedResponse: string;
}

export interface QualificationResult {
  disposition: Disposition;
  score: number;
  criteria: CriterionResult[];
  failedCriteria: CriterionKey[];
  hardExclusions: string[];
  reasonCodes: string[];
  caveats: string[];
  nextQuestion: string | null;
  escalation: EscalationDecision | null;
  /** True only for qualified leads that may proceed to Calendly. */
  canBook: boolean;
  /** Customer-facing wording for a graceful close (rejections only). Never contains prices. */
  closingScript: string | null;
  rulesVersion: string;
  evaluatedAt: string;
}

export const RULES_VERSION = "2026.10-rubric-v1.0";
