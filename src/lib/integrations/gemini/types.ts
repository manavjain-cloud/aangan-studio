import { z } from "zod";
import { AUTHORITY, PROPERTY_KINDS, SCOPES, SERVICE_INTENTS, SITE_CONDITIONS, type EnquiryFacts } from "../../domain/types";

/**
 * Strict schema that Gemini must satisfy. It is converted to JSON Schema for structured output, and the
 * model's answer is then re-validated here AND passed through the lenient enquiryFactsSchema. Model output is
 * untrusted: it can only ever fill facts (never decide qualification) and every field may be null.
 */
export const geminiFactsSchema = z.object({
  caller_name: z.string().nullable(),
  caller_email: z.string().nullable(),
  project_type: z.enum(["residential", "commercial"]).nullable(),
  property_kind: z.enum(PROPERTY_KINDS).nullable(),
  service_intent: z.enum(SERVICE_INTENTS).nullable(),
  scope: z.enum(SCOPES).nullable(),
  rooms_count: z.number().nullable(),
  rooms_description: z.string().nullable(),
  bhk: z.number().nullable(),
  carpet_area_sqft: z.number().nullable(),
  location_text: z.string().nullable(),
  site_condition: z.enum(SITE_CONDITIONS).nullable(),
  is_rented: z.boolean().nullable(),
  structural_changes_required: z.boolean().nullable(),
  desired_completion_date: z.string().nullable(),
  timeline_flexible: z.boolean().nullable(),
  site_available_date: z.string().nullable(),
  site_available_now: z.boolean().nullable(),
  authority: z.enum(AUTHORITY).nullable(),
  decision_makers_will_attend: z.boolean().nullable(),
  budget_inr_min: z.number().nullable(),
  budget_inr_max: z.number().nullable(),
  budget_declined: z.boolean().nullable(),
  asked_about_pricing: z.boolean().nullable(),
  existing_customer_complaint: z.boolean().nullable(),
  requests_senior: z.boolean().nullable(),
  caller_frustrated: z.boolean().nullable(),
  missed_followup: z.boolean().nullable(),
  availability_notes: z.string().nullable(),
  notes: z.string().nullable(),
});

export const geminiAnalysisSchema = z.object({
  facts: geminiFactsSchema,
  summary: z.string().max(900),
  handoff_note: z.string().max(1400),
  /** True only if the caller clearly agreed to a specific consultation slot in the transcript. */
  customer_confirmed_slot: z.boolean().nullable(),
  /** True if the AGENT (not the caller) stated any price, range, per-sq-ft figure or typical cost. */
  agent_stated_price: z.boolean(),
});

export type GeminiAnalysis = z.infer<typeof geminiAnalysisSchema>;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export interface AnalyzeTranscriptInput {
  transcript: string;
  currentFacts: EnquiryFacts;
  now: Date;
  timezone: string;
}

export interface AnalyzeTranscriptResult {
  analysis: GeminiAnalysis;
  usage: TokenUsage;
}

export interface GeminiClient {
  readonly mode: "live" | "mock";
  analyzeTranscript(input: AnalyzeTranscriptInput): Promise<AnalyzeTranscriptResult>;
  /** Lightweight check used by the settings page. */
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class GeminiInvalidOutputError extends Error {
  constructor(message: string, public readonly raw?: string) {
    super(message);
    this.name = "GeminiInvalidOutputError";
  }
}

export class GeminiUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiUnavailableError";
  }
}
