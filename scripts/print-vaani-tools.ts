import { getEnv } from "@/lib/env";

/**
 * Prints the six custom-tool definitions to enter in the Vaani dashboard
 * (Design -> Tools & Actions -> New Action -> Create Custom Tool: Name, Description, API Endpoint, Timeout, Headers, Parameters).
 *
 * IMPORTANT - what is and is not verified:
 *  - VERIFIED (docs.vaanivoice.ai, "Customize Persona"): Vaani supports custom tools defined by a pasted cURL request
 *    plus a natural-language description of when to trigger it, executed mid-call.
 *  - NOT PUBLIC: the placeholder syntax Vaani uses to inject model-supplied arguments and call metadata (the
 *    {{...}} markers below) and whether the call id is auto-injected. Confirm both in the dashboard tool editor
 *    and adjust the markers; see docs/vaani-integration.md section "Verify in the dashboard".
 * The endpoint also resolves a call from `caller_phone`, so it still works if only that can be injected.
 */
const base = (process.env.APP_URL ?? getEnv().APP_URL).replace(/\/$/, "");
const url = `${base}/api/voice/tools/aangan-workflow-action`;
const key = process.env.VOICE_TOOL_SECRET ?? "<set VOICE_TOOL_SECRET first>";

interface Tool {
  name: string;
  when: string;
  action: string;
  params: Record<string, string>;
}

const FACT_PARAMS: Record<string, string> = {
  caller_name: "caller's name, if stated",
  project_type: "residential | commercial",
  property_kind: "apartment | independent_house | villa | office | clinic | studio | coworking | restaurant | hotel | retail_store | gym | other",
  service_intent: "design_and_execution | advice_only | styling_only | furniture_sourcing_only | vastu_only | self_execution",
  scope: "full_home | partial_home | single_room_full | office_fitout | other",
  rooms_count: "number of rooms to be redesigned",
  bhk: "number",
  carpet_area_sqft: "number, carpet area in sq ft",
  location_text: "locality / area / city of the PROPERTY, in the caller's words",
  site_condition: "bare_shell | new_possession_empty | occupied | under_construction | vacant_old",
  is_rented: "true | false",
  structural_changes_required: "true | false",
  desired_completion_date: "YYYY-MM-DD, use today's date from get_call_context to resolve phrases like 'by March'",
  timeline_flexible: "true if the caller says they have no fixed deadline",
  site_available_date: "YYYY-MM-DD when the site will be available",
  site_available_now: "true | false",
  authority: "decision_maker | authorised_representative | researching_for_other",
  decision_makers_will_attend: "true | false",
  budget_inr_max: "ONLY if the caller volunteers a figure, in rupees. Never ask for it.",
  budget_declined: "true if the caller declines to share a budget",
  asked_about_pricing: "true if the caller asked what it costs",
  existing_customer_complaint: "true only for an existing customer complaining about an ongoing project",
  requests_senior: "true if the caller asks for a senior person",
  caller_frustrated: "true",
  missed_followup: "true if the caller says an earlier enquiry was not followed up",
  caller_email: "email, only after reading it back letter by letter",
  availability_notes: "the caller's availability in their words",
};

const TOOLS: Tool[] = [
  { name: "get_call_context", action: "get_call_context", when: "Call ONCE at the very start of the call, before asking anything. Returns today's date, whether it is after hours, and anything already known from an earlier dropped call.", params: {} },
  { name: "save_enquiry_progress", action: "save_enquiry_progress", when: "Call after the caller gives you any new facts (location, scope, timeline, authority...). Send ONLY facts the caller actually stated; leave everything else out. Never ask the caller for a budget.", params: FACT_PARAMS },
  { name: "evaluate_qualification", action: "evaluate_qualification", when: "Call when you have asked the basic questions, and again after each clarifying answer. Say exactly what `say` returns. Never decide qualification yourself.", params: FACT_PARAMS },
  { name: "get_available_slots", action: "get_available_slots", when: "ONLY after evaluate_qualification returns status 'qualified' and the caller has said when they are free. Offer only the times returned; never invent a time.", params: { date_from: "YYYY-MM-DD earliest day the caller can meet", date_to: "YYYY-MM-DD latest day", time_of_day: "morning | afternoon | evening | any" } },
  { name: "book_consultation", action: "book_consultation", when: "ONLY after the caller has clearly said yes to one specific time you read out. Never say the consultation is booked unless this returns status 'booked'.", params: { slot_option: "the option number the caller chose (1, 2 or 3)", customer_confirmed: "true only if the caller explicitly agreed", customer_confirmation_quote: "the caller's own words agreeing, e.g. 'Yes, book the Tuesday one'", invitee_email: "caller's email, read back and confirmed letter by letter", invitee_name: "caller's full name" } },
  { name: "escalate_to_human", action: "escalate_to_human", when: "Call when an EXISTING customer is complaining about their project, anyone asks for a senior person, the caller is very frustrated or says an earlier enquiry was ignored, or you cannot safely resolve something. Never try to resolve a complaint yourself.", params: { reason: "complaint | senior_requested | frustrated | missed_followup | other", details: "one sentence in the caller's words", caller_name: "name if known" } },
];

console.log(`Vaani custom tools for ${url}` + "\n");
console.log("Vaani dashboard -> Design -> Tools & Actions -> New Action -> Create Custom Tool. For each tool below fill the form fields exactly:" + "\n");
for (const t of TOOLS) {
  console.log("=".repeat(78));
  console.log(`Name *            : ${t.name}`);
  console.log(`Description *     : ${t.when}`);
  console.log(`API Endpoint *    : POST  ${url}?action=${t.action}`);
  console.log("Timeout (ms)      : 8000");
  console.log(`Headers           : X-Aangan-Tool-Key = ${key}`);
  console.log("                    Content-Type = application/json");
  console.log("Query Parameters  : (none - the action is already in the URL)");
  if (Object.keys(t.params).length) {
    console.log("Parameters (the agent extracts these; mark as optional unless stated):");
    for (const [k, v] of Object.entries(t.params)) console.log(`   - ${k.padEnd(28)} ${v}`);
  } else console.log("Parameters        : (none)");
  console.log("Call identity     : if Vaani offers a system variable for the call id / caller number (check the variable picker),");
  console.log("                    add parameters call_id and caller_phone bound to it. If not, see docs/vaani-integration.md.");
  console.log("");
}
console.log("=".repeat(78));
console.log("Webhook (Developers -> Webhooks):" + "\n  " + `${base}/api/voice/webhooks/vaani?token=<VAANI_WEBHOOK_TOKEN>`);
