/**
 * Configurable HubSpot field mapping. Internal property names live in ONE place so the CRM owner can change
 * them without touching business logic. Standard HubSpot properties are written only when empty (never
 * overwriting existing customer data); the aangan_* custom properties describe the latest phone enquiry and are
 * always refreshed. ensureProperties() checks existing definitions first and only creates what is missing.
 */

export const HUBSPOT_PROPERTY_GROUP = { name: "aangan_studio", label: "Aangan Studio phone enquiry" };

export interface PropertyDef {
  name: string;
  label: string;
  type: "string" | "number" | "datetime";
  fieldType: "text" | "textarea" | "number" | "date";
  description?: string;
}

export const FIELD_MAP = {
  disposition: "aangan_disposition",
  score: "aangan_qualification_score",
  projectType: "aangan_project_type",
  scope: "aangan_scope",
  location: "aangan_property_location",
  area: "aangan_carpet_area_sqft",
  timeline: "aangan_timeline",
  authority: "aangan_decision_maker_status",
  volunteeredBudget: "aangan_volunteered_budget",
  criteria: "aangan_criteria_results",
  caveats: "aangan_qualification_caveats",
  callSummary: "aangan_call_summary",
  callId: "aangan_call_reference",
  callTime: "aangan_call_time",
  designer: "aangan_assigned_designer",
  bookingStatus: "aangan_booking_status",
  bookingTime: "aangan_consultation_time",
  escalationStatus: "aangan_escalation_status",
  rejectionReason: "aangan_rejection_reason",
  source: "aangan_lead_source",
} as const;

export const CUSTOM_PROPERTY_DEFS: PropertyDef[] = [
  { name: FIELD_MAP.disposition, label: "Aangan: disposition", type: "string", fieldType: "text" },
  { name: FIELD_MAP.score, label: "Aangan: qualification score (0-100)", type: "number", fieldType: "number" },
  { name: FIELD_MAP.projectType, label: "Aangan: project type", type: "string", fieldType: "text" },
  { name: FIELD_MAP.scope, label: "Aangan: project scope", type: "string", fieldType: "text" },
  { name: FIELD_MAP.location, label: "Aangan: property location", type: "string", fieldType: "text" },
  { name: FIELD_MAP.area, label: "Aangan: carpet area (sq ft)", type: "number", fieldType: "number" },
  { name: FIELD_MAP.timeline, label: "Aangan: timeline and site readiness", type: "string", fieldType: "textarea" },
  { name: FIELD_MAP.authority, label: "Aangan: decision-maker status", type: "string", fieldType: "text" },
  { name: FIELD_MAP.volunteeredBudget, label: "Aangan: volunteered budget (never asked)", type: "string", fieldType: "text" },
  { name: FIELD_MAP.criteria, label: "Aangan: criterion-level results", type: "string", fieldType: "textarea" },
  { name: FIELD_MAP.caveats, label: "Aangan: qualification caveats", type: "string", fieldType: "textarea" },
  { name: FIELD_MAP.callSummary, label: "Aangan: call summary", type: "string", fieldType: "textarea" },
  { name: FIELD_MAP.callId, label: "Aangan: call reference", type: "string", fieldType: "text" },
  { name: FIELD_MAP.callTime, label: "Aangan: call time", type: "string", fieldType: "text" },
  { name: FIELD_MAP.designer, label: "Aangan: assigned designer", type: "string", fieldType: "text" },
  { name: FIELD_MAP.bookingStatus, label: "Aangan: consultation booking status", type: "string", fieldType: "text" },
  { name: FIELD_MAP.bookingTime, label: "Aangan: consultation time", type: "string", fieldType: "text" },
  { name: FIELD_MAP.escalationStatus, label: "Aangan: escalation status", type: "string", fieldType: "text" },
  { name: FIELD_MAP.rejectionReason, label: "Aangan: rejection / failure reason", type: "string", fieldType: "text" },
  { name: FIELD_MAP.source, label: "Aangan: lead source", type: "string", fieldType: "text" },
];

export interface HubspotContactInput {
  email: string | null;
  phone: string | null;
  name: string | null;
  /** Custom aangan_* properties; always refreshed. */
  properties: Record<string, string | number>;
}

export interface HubspotDealInput {
  existingDealId?: string | null;
  contactId: string;
  name: string;
  pipeline: string;
  stage: string;
  properties?: Record<string, string | number>;
}

export interface HubspotClient {
  readonly mode: "live" | "mock";
  ensureProperties(defs: PropertyDef[]): Promise<{ created: string[]; existing: string[] }>;
  upsertContact(input: HubspotContactInput): Promise<{ id: string; created: boolean; matchedBy: "email" | "phone" | null }>;
  upsertNote(input: { contactId: string; dealId?: string | null; existingNoteId?: string | null; body: string; timestamp: Date }): Promise<{ id: string }>;
  upsertDeal(input: HubspotDealInput): Promise<{ id: string }>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class HubspotError extends Error {
  constructor(
    public readonly code: "unauthorized" | "forbidden" | "rate_limited" | "invalid_request" | "server_error" | "timeout" | "unknown",
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "HubspotError";
  }
  get retryable() {
    return this.code === "rate_limited" || this.code === "server_error" || this.code === "timeout";
  }
}
