import type { QualificationConfig } from "./config";
import type { EnquiryFacts } from "./types";

/**
 * Criterion 4 - broad budget fit, ONLY from what the caller volunteered.
 *
 * INTERNAL ONLY. The floors below are derived from pricing.md's lowest indicative figures purely so the
 * server can recognise a *clearly* inadequate volunteered budget (e.g. Rs 1-1.5 lakh for a kitchen plus a
 * bedroom with full execution - transcript T10). They are never returned in an API response, never put in
 * an LLM prompt, never written into evidence text, and never spoken to a caller (pricing.md: the agent
 * must never quote any figure). The caller-facing line is always the approved deflection.
 */

const LAKH = 100_000;

// Lowest indicative figures from pricing.md (internal). Rupees.
const RESIDENTIAL_MIN_PER_SQFT = 1_800;
const COMMERCIAL_MIN_PER_SQFT = 1_200;
const SINGLE_ROOM_MIN_ALL_IN = 3.5 * LAKH;

export interface BudgetAssessment {
  status: "pass" | "fail" | "unknown_neutral";
  evidence: string;
  caveat: string | null;
  reasonCode: string | null;
}

/** Lowest plausible spend for the described scope, or null if the scope is too vague to judge. */
function internalFloorInr(facts: EnquiryFacts): number | null {
  const area = facts.carpet_area_sqft;
  if (facts.project_type === "commercial") {
    return area && area > 0 ? area * COMMERCIAL_MIN_PER_SQFT : null;
  }
  if (facts.project_type === "residential" || facts.scope) {
    if (facts.scope === "full_home" || facts.scope === "partial_home") {
      if (facts.scope === "partial_home" && facts.rooms_count && facts.rooms_count > 0) {
        return facts.rooms_count * SINGLE_ROOM_MIN_ALL_IN;
      }
      if (area && area > 0) return area * RESIDENTIAL_MIN_PER_SQFT;
      return null;
    }
    if (facts.scope === "single_room_full") {
      const rooms = facts.rooms_count && facts.rooms_count > 0 ? facts.rooms_count : 1;
      return rooms * SINGLE_ROOM_MIN_ALL_IN;
    }
    if (facts.rooms_count && facts.rooms_count > 0) return facts.rooms_count * SINGLE_ROOM_MIN_ALL_IN;
  }
  return null;
}

export function assessBudget(facts: EnquiryFacts, cfg: QualificationConfig["budget"]): BudgetAssessment {
  // Highest figure the caller volunteered - the most generous reading of their budget.
  const volunteered = facts.budget_inr_max ?? facts.budget_inr_min ?? null;

  if (volunteered === null || volunteered <= 0) {
    return {
      status: "unknown_neutral",
      evidence: facts.budget_declined
        ? "Caller preferred not to share a budget. Not penalised; designer establishes fit at the consultation."
        : "No budget volunteered. Not penalised; designer establishes fit at the consultation.",
      caveat: "Budget not discussed.",
      reasonCode: null,
    };
  }

  const floor = internalFloorInr(facts);
  if (floor === null) {
    return {
      status: "unknown_neutral",
      evidence: "Caller volunteered a budget, but the scope is not specific enough to judge fit. Recorded for the designer; not used to decline.",
      caveat: "Budget volunteered but scope too vague to assess; designer to review.",
      reasonCode: null,
    };
  }

  const ratio = volunteered / floor;
  if (ratio < cfg.clearlyBelowRatio) {
    return {
      status: "fail",
      evidence: "Caller volunteered a budget that is clearly below what the described scope with full execution would require.",
      caveat: null,
      reasonCode: "budget_clearly_inadequate",
    };
  }
  if (ratio < cfg.noteBelowRatio) {
    return {
      status: "unknown_neutral",
      evidence: "Caller volunteered a budget that may be tight for the described scope. Not clear enough to decline; flagged for the designer.",
      caveat: "Volunteered budget may be tight for the scope; designer to discuss at the consultation.",
      reasonCode: null,
    };
  }
  return {
    status: "pass",
    evidence: "Caller volunteered a budget that does not clearly conflict with the described scope.",
    caveat: null,
    reasonCode: null,
  };
}
