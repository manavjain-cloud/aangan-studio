import { enquiryFactsSchema, type EnquiryFacts } from "@/lib/domain/types";

/**
 * Structured facts for the September 2026 PHONE transcripts (T01-T20), as the voice agent would capture
 * them. Anonymised source: Aangan_Sep 2026_Enquiries.pdf. Names are the placeholders used in the PDF; no
 * real contact details. `now` is the call date so timeline rules are evaluated as they were then.
 */

export interface Fixture {
  id: string;
  title: string;
  now: string; // ISO instant (IST evenings -> UTC) of the call
  facts: Partial<Record<keyof EnquiryFacts, unknown>>;
  expect: { disposition: "qualified" | "clarification_required" | "rejected" | "human_escalation"; reason?: string };
}

const f = (x: Fixture["facts"]): Fixture["facts"] => x;

export const FIXTURES: Fixture[] = [
  {
    id: "T01",
    title: "Kothrud 3BHK full redesign, owner + husband authorised",
    now: "2026-09-02T04:53:00Z",
    facts: f({
      caller_name: "Priya", service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment",
      scope: "full_home", bhk: 3, carpet_area_sqft: 1400, location_text: "Kothrud, Dahanukar Colony",
      desired_completion_date: "2027-03-31", timeline_flexible: true, authority: "authorised_representative",
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T02",
    title: "Wakad 2BHK, asks for price twice, otherwise qualifies",
    now: "2026-09-03T09:11:00Z",
    facts: f({
      service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment", scope: "full_home",
      bhk: 2, carpet_area_sqft: 950, location_text: "Wakad", desired_completion_date: "2026-11-30", asked_about_pricing: true,
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T03",
    title: "Nashik home office - out of service area",
    now: "2026-09-03T10:45:00Z",
    facts: f({
      caller_name: "Suresh Patil", service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment",
      scope: "partial_home", rooms_count: 2, location_text: "Nashik", timeline_flexible: true,
    }),
    expect: { disposition: "rejected", reason: "out_of_area" },
  },
  {
    id: "T04",
    title: "Living room ideas only - advice/styling",
    now: "2026-09-04T05:37:00Z",
    facts: f({ service_intent: "styling_only", project_type: "residential", scope: "single_room_full", location_text: null }),
    expect: { disposition: "rejected", reason: "advice_only" },
  },
  {
    id: "T05",
    title: "Koregaon Park 4BHK, referral, moved out temporarily",
    now: "2026-09-05T05:22:00Z",
    facts: f({
      caller_name: "Aarti Mehta", service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment",
      scope: "full_home", bhk: 4, carpet_area_sqft: 2400, location_text: "Koregaon Park", desired_completion_date: "2027-02-15",
      site_available_now: true, authority: "decision_maker",
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T06",
    title: "Baner 800 sq ft startup office, founder",
    now: "2026-09-05T09:58:00Z",
    facts: f({
      service_intent: "design_and_execution", project_type: "commercial", property_kind: "office", scope: "office_fitout",
      carpet_area_sqft: 800, location_text: "Baner", site_condition: "bare_shell", desired_completion_date: "2026-12-15", authority: "decision_maker",
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T07",
    title: "Living room + kitchen before Diwali (~3 weeks)",
    now: "2026-09-08T04:14:00Z",
    facts: f({
      service_intent: "design_and_execution", project_type: "residential", scope: "partial_home", rooms_count: 2,
      location_text: "Pune", desired_completion_date: "2026-09-29",
    }),
    expect: { disposition: "rejected", reason: "timeline_impossible" },
  },
  {
    id: "T09",
    title: "Existing project complaint, wants senior callback",
    now: "2026-09-10T06:02:00Z",
    facts: f({ caller_name: "Sheetal Deshpande", existing_customer_complaint: true, requests_senior: true, location_text: "Viman Nagar" }),
    expect: { disposition: "human_escalation", reason: "existing_customer_complaint" },
  },
  {
    id: "T10",
    title: "Kharadi 1BHK kitchen + bedroom, volunteers Rs 1-1.5 lakh",
    now: "2026-09-11T08:34:00Z",
    facts: f({
      service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment", scope: "partial_home",
      rooms_count: 2, bhk: 1, carpet_area_sqft: 550, location_text: "Kharadi, Pune", timeline_flexible: true,
      budget_inr_min: 100000, budget_inr_max: 150000,
    }),
    expect: { disposition: "rejected", reason: "budget_clearly_inadequate" },
  },
  {
    id: "T11",
    title: "Rented Baner 2BHK, no structural changes, landlord ok",
    now: "2026-09-12T04:48:00Z",
    facts: f({
      service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment", scope: "partial_home",
      rooms_count: 3, bhk: 2, location_text: "Baner", is_rented: true, structural_changes_required: false, timeline_flexible: true, authority: "decision_maker",
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T12",
    title: "Kalyani Nagar 5,500 sq ft villa, new possession",
    now: "2026-09-15T04:35:00Z",
    facts: f({
      caller_name: "Anand Sharma", service_intent: "design_and_execution", project_type: "residential", property_kind: "villa",
      scope: "full_home", carpet_area_sqft: 5500, location_text: "Kalyani Nagar", site_condition: "new_possession_empty",
      desired_completion_date: "2027-03-31", site_available_now: true,
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T13",
    title: "Aundh 3BHK, keeps pressing for a rough price",
    now: "2026-09-16T06:49:00Z",
    facts: f({
      service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment", scope: "partial_home",
      rooms_count: 4, bhk: 3, carpet_area_sqft: 1100, location_text: "Aundh", timeline_flexible: true, asked_about_pricing: true,
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T14",
    title: "Son enquiring for parents' Hadapsar 3BHK; parents will attend",
    now: "2026-09-17T06:11:00Z",
    facts: f({
      service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment", scope: "full_home", bhk: 3,
      location_text: "Hadapsar", timeline_flexible: true, authority: "researching_for_other", decision_makers_will_attend: true,
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T15",
    title: "Undri 2BHK, possession in ~6 weeks, no deadline",
    now: "2026-09-18T09:42:00Z",
    facts: f({
      caller_name: "Smita", service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment",
      scope: "full_home", bhk: 2, carpet_area_sqft: 875, location_text: "Undri", timeline_flexible: true, site_available_date: "2026-10-30",
      authority: "authorised_representative",
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T16",
    title: "Frustrated returning caller after missed follow-up",
    now: "2026-09-19T05:08:00Z",
    facts: f({
      caller_name: "Girish Nair", service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment",
      scope: "full_home", bhk: 3, location_text: "Viman Nagar", timeline_flexible: true, missed_followup: true, caller_frustrated: true,
    }),
    expect: { disposition: "human_escalation", reason: "frustrated_returning_lead" },
  },
  {
    id: "T17",
    title: "Pimple Saudagar 3BHK (second call after a dropped one)",
    now: "2026-09-22T08:48:00Z",
    facts: f({
      caller_name: "Ritu Kapoor", service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment",
      scope: "full_home", bhk: 3, carpet_area_sqft: 1050, location_text: "Pimple Saudagar", desired_completion_date: "2027-03-31",
    }),
    expect: { disposition: "qualified" },
  },
  {
    id: "T18",
    title: "180 sq ft coworking pod - below minimum commercial scope",
    now: "2026-09-23T06:25:00Z",
    facts: f({
      service_intent: "design_and_execution", project_type: "commercial", property_kind: "coworking", carpet_area_sqft: 180,
      location_text: "Pune", timeline_flexible: true,
    }),
    expect: { disposition: "rejected", reason: "below_minimum_commercial_scope" },
  },
  {
    id: "T19",
    title: "Restaurant in Koregaon Park - hospitality, out of scope",
    now: "2026-09-24T10:32:00Z",
    facts: f({ service_intent: "design_and_execution", project_type: "commercial", property_kind: "restaurant", location_text: "Koregaon Park", timeline_flexible: true }),
    expect: { disposition: "rejected", reason: "excluded_category" },
  },
  {
    id: "T20",
    title: "Magarpatta (Cybercity) 2BHK, January start",
    now: "2026-09-25T03:45:00Z",
    facts: f({
      caller_name: "Pooja", service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment",
      scope: "full_home", bhk: 2, carpet_area_sqft: 900, location_text: "Magarpatta, Cybercity", timeline_flexible: true,
      authority: "decision_maker",
    }),
    expect: { disposition: "qualified" },
  },
];

export function factsOf(fx: Fixture): EnquiryFacts {
  return enquiryFactsSchema.parse(fx.facts);
}
