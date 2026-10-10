import type { QualificationConfig } from "./config";
import type { EnquiryFacts } from "./types";
import { weeksBetween, weeksUntil } from "../time";

export type TimelineStatus = "pass" | "fail" | "unknown" | "human_review";

export interface TimelineAssessment {
  status: TimelineStatus;
  evidence: string;
  caveat: string | null;
  reasonCode: string | null;
}

/**
 * Criterion 3 - realistic timeline and site readiness.
 * Sources: services.md (design 3-4 wks, execution 8-16 wks, cannot start if needed in under 6 wks)
 * and qualified.md ("site available within 8-10 weeks of the consultation", 3 weeks = impossible).
 * Never promises a completion date; uncertain feasibility is noted for the designer.
 */
export function assessTimeline(facts: EnquiryFacts, now: Date, cfg: QualificationConfig["timeline"]): TimelineAssessment {
  const { desired_completion_date: completion, site_available_date: siteDate } = facts;

  if (completion) {
    const weeks = weeksUntil(completion, now);
    if (weeks < 0) {
      return {
        status: "unknown",
        evidence: `Stated completion date ${completion} is in the past, so it cannot be used.`,
        caveat: null,
        reasonCode: "timeline_date_invalid",
      };
    }
    if (weeks < cfg.hardMinWeeksToCompletion) {
      return {
        status: "fail",
        evidence: `Caller needs the project ready by ${completion} (~${weeks.toFixed(1)} weeks away); design alone takes 3-4 weeks and execution cannot begin for work needed in under ${cfg.hardMinWeeksToCompletion} weeks.`,
        caveat: null,
        reasonCode: "timeline_impossible",
      };
    }
    if (siteDate) {
      const window = weeksBetween(siteDate, completion);
      if (window < cfg.hardMinExecutionWeeks) {
        return {
          status: "fail",
          evidence: `Site only available from ${siteDate} and completion needed by ${completion}: ~${Math.max(window, 0).toFixed(1)} weeks for execution, below the minimum.`,
          caveat: null,
          reasonCode: "timeline_execution_window",
        };
      }
    }
    if (weeks < cfg.tightWeeksToCompletion) {
      const msg = `Tight timeline: completion wanted by ${completion} (~${weeks.toFixed(1)} weeks). Designer must confirm feasibility; no completion date has been promised.`;
      return cfg.tightAction === "human_review"
        ? { status: "human_review", evidence: msg, caveat: msg, reasonCode: "timeline_tight" }
        : { status: "pass", evidence: msg, caveat: msg, reasonCode: "timeline_tight" };
    }
    return {
      status: "pass",
      evidence: `Completion wanted by ${completion} (~${weeks.toFixed(0)} weeks away), which allows for design plus execution.`,
      caveat: null,
      reasonCode: null,
    };
  }

  if (facts.timeline_flexible === true) {
    const siteNote = siteDate
      ? ` Site available from ${siteDate}.`
      : facts.site_available_now === true
        ? " Site is available now."
        : "";
    return { status: "pass", evidence: `Caller has no fixed deadline (flexible timeline).${siteNote}`, caveat: null, reasonCode: null };
  }

  return {
    status: "unknown",
    evidence: "No completion date or flexibility stated yet.",
    caveat: null,
    reasonCode: "timeline_unknown",
  };
}
