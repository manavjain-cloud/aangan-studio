import { z } from "zod";
import { CRITERION_KEYS, type CriterionKey } from "./types";

/**
 * Qualification configuration. Every value here is either taken from the source documents (noted)
 * or is a PROPOSED value that needs Nikhil's approval (noted). Stored overrides live in the
 * `app_settings` table and are validated against this schema before use.
 */

export const DEFAULT_WEIGHTS: Record<CriterionKey, number> = {
  real_project: 30, // PROPOSED (rubric.txt A1) - not supplied by Nikhil
  service_area: 25, // PROPOSED
  timeline: 20, // PROPOSED
  budget: 15, // PROPOSED
  decision_maker: 10, // PROPOSED
};

export const qualificationConfigSchema = z.object({
  weights: z
    .object({
      real_project: z.number().min(0).max(100),
      service_area: z.number().min(0).max(100),
      timeline: z.number().min(0).max(100),
      budget: z.number().min(0).max(100),
      decision_maker: z.number().min(0).max(100),
    })
    .refine((w) => Object.values(w).reduce((a, b) => a + b, 0) === 100, "Weights must sum to 100"),

  /**
   * Rejection policy - the documented ambiguity in qualified.md (see README "Open business decisions").
   *  - singleHardExclusion: one confirmed hard exclusion (e.g. Nashik, advice-only, 3-week deadline).
   *      "reject" (default, matches rubric A5 examples T03/T04/T07/T10/T18/T19) or "human_review".
   *  - singleSoftFailure: one failed criterion that is not a hard exclusion. Default "human_review".
   *  - twoOrMoreFailures: always "reject" (qualified.md boundary section).
   *  - autoRejectEnabled: master switch. When false every would-be rejection is routed to a human instead.
   */
  rejectionPolicy: z.object({
    singleHardExclusion: z.enum(["reject", "human_review"]),
    singleSoftFailure: z.enum(["reject", "human_review"]),
    twoOrMoreFailures: z.enum(["reject", "human_review"]),
    autoRejectEnabled: z.boolean(),
  }),

  timeline: z.object({
    /** services.md: "cannot begin execution on a project that needs to be ready in under 6 weeks from today". */
    hardMinWeeksToCompletion: z.number().min(0),
    /** qualified.md: site available for execution within 8-10 weeks. Below this = "tight": note for the designer. */
    tightWeeksToCompletion: z.number().min(0),
    /** services.md: execution takes 8-16 weeks. Window between site availability and completion below the hard minimum fails. */
    hardMinExecutionWeeks: z.number().min(0),
    tightAction: z.enum(["note", "human_review"]),
  }),

  commercial: z.object({
    /** services.md: "up to approximately 3,000 sq ft". Above this goes to human review rather than auto-pass. */
    maxSqft: z.number(),
    /** NOT in services.md - derived from the T18 front-desk statement ("typically 500 sq ft or more") and rubric A5. Needs approval. */
    minSqft: z.number(),
  }),

  budget: z.object({
    /** Volunteered budget below this fraction of the internal floor for the stated scope is "clearly inadequate". */
    clearlyBelowRatio: z.number().min(0).max(1),
    /** Between clearlyBelowRatio and this ratio: pass but record a caveat for the designer. */
    noteBelowRatio: z.number().min(0).max(1.5),
  }),

  escalation: z.object({
    /** A frustrated returning lead (T16/W08) is routed to a human by default instead of auto-booking. */
    frustratedLeadAutoBook: z.boolean(),
    callbackPromiseMinutes: z.number().nullable(),
  }),

  businessHours: z.object({
    startHour: z.number().min(0).max(23),
    endHour: z.number().min(1).max(24),
    timezone: z.string(),
    /** Days of week open (0 = Sunday). Case brief says 10am-7pm; weekend coverage is not stated, so weekdays + Saturday are NOT assumed. */
    openDays: z.array(z.number().min(0).max(6)),
  }),
});

export type QualificationConfig = z.infer<typeof qualificationConfigSchema>;

export const DEFAULT_QUALIFICATION_CONFIG: QualificationConfig = {
  weights: DEFAULT_WEIGHTS,
  rejectionPolicy: {
    singleHardExclusion: "reject",
    singleSoftFailure: "human_review",
    twoOrMoreFailures: "reject",
    autoRejectEnabled: true,
  },
  timeline: {
    hardMinWeeksToCompletion: 6,
    tightWeeksToCompletion: 10,
    hardMinExecutionWeeks: 6,
    tightAction: "note",
  },
  commercial: { maxSqft: 3000, minSqft: 500 },
  budget: { clearlyBelowRatio: 0.4, noteBelowRatio: 0.7 },
  escalation: { frustratedLeadAutoBook: false, callbackPromiseMinutes: null },
  businessHours: { startHour: 10, endHour: 19, timezone: "Asia/Kolkata", openDays: [1, 2, 3, 4, 5, 6, 0] },
};

export function totalWeight(w: Record<CriterionKey, number>): number {
  return CRITERION_KEYS.reduce((sum, k) => sum + w[k], 0);
}
