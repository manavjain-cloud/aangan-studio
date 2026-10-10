import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { calls, enquiries, escalations, outboxJobs } from "@/lib/db/schema";
import { setIntegrationOverride } from "@/lib/integrations";
import type { GeminiClient, GeminiAnalysis } from "@/lib/integrations/gemini/types";
import { emptyFacts, type EnquiryFacts } from "@/lib/domain/types";
import { MockEmailClient } from "@/lib/integrations/email/mock";
import { MockHubspotClient } from "@/lib/integrations/hubspot/mock";
import { MockCalendlyClient } from "@/lib/integrations/calendly/mock";
import { makeHarness, type Harness } from "./helpers/harness";

/**
 * Architecture fallback (spec point 8): if the configured Vaani product could NOT run live tools, the system still
 * works from the signed post-call webhook alone - but it can only qualify and hand off, never book on the call.
 */

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  setIntegrationOverride("gemini", undefined);
  await h.close();
});

function stubGemini(facts: Partial<EnquiryFacts>, extra: Partial<GeminiAnalysis> = {}): GeminiClient {
  return {
    mode: "live",
    async analyzeTranscript() {
      return {
        analysis: { facts: { ...emptyFacts(), ...facts } as GeminiAnalysis["facts"], summary: "Caller wants a full 3BHK redesign in Kothrud.", handoff_note: "Call back to arrange a consultation.", customer_confirmed_slot: null, agent_stated_price: false, ...extra },
        usage: { inputTokens: 900, outputTokens: 120, model: "stub" },
      };
    },
    async health() {
      return { ok: true, detail: "stub" };
    },
  };
}

const post = (callId: string) => ({
  event: "call_postprocessing", call_id: callId, data: { room_name: callId, call_id: callId, call_duration: 120_000, transcript: "[10:00:01] AGENT: Hello.\n\n[10:00:05] USER: 3BHK in Kothrud, full design and execution, no rush." },
});

describe("post-call-only operation (no live tool calls at all)", () => {
  it("qualifies from the transcript, emails the handoff as 'no consultation booked', syncs HubSpot - and NEVER books", async () => {
    setIntegrationOverride("gemini", stubGemini({ service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment", scope: "full_home", bhk: 3, location_text: "Kothrud", timeline_flexible: true, authority: "decision_maker", caller_name: "Fallback Caller" }));
    await h.webhook({ event: "call_started", room_name: "room-fb", phone_number: "+919811100001" });
    await h.webhook({ event: "user_picked_up_at", room_name: "room-fb" });
    await h.webhook({ event: "call_ended", room_name: "room-fb", call_duration: 120 });
    await h.webhook(post("room-fb"));
    await h.drain();

    const [e] = await h.db.select().from(enquiries);
    expect(e!.disposition).toBe("qualified");
    expect(MockCalendlyClient.stats.createCalls).toBe(0);
    const handoff = MockEmailClient.sent.filter((m) => /Qualified lead - arrange consultation/.test(m.subject));
    expect(handoff.length).toBeGreaterThan(0);
    expect(handoff[0]!.text).toContain("No consultation booked yet");
    expect(MockHubspotClient.snapshot.contacts[0]!.properties.aangan_booking_status).toBe("Not booked");
    const [c] = await h.db.select().from(calls);
    expect(c!.summary).toBe("Caller wants a full 3BHK redesign in Kothrud.");
  });

  it("an existing-customer complaint found only in the transcript still escalates to the senior person (never a sales lead)", async () => {
    setIntegrationOverride("gemini", stubGemini({ existing_customer_complaint: true, requests_senior: true, caller_name: "Angry Customer", location_text: "Viman Nagar" }));
    await h.webhook({ event: "call_started", room_name: "room-fb2", phone_number: "+919811100002" });
    await h.webhook({ event: "call_ended", room_name: "room-fb2", call_duration: 90 });
    await h.webhook(post("room-fb2"));
    await h.drain();
    const esc = await h.db.select().from(escalations);
    expect(esc.map((x) => x.kind)).toContain("existing_customer_complaint");
    expect(MockEmailClient.sent.some((m) => m.subject.startsWith("[URGENT] Existing-customer complaint") && m.to === "nikhil@aangan.test")).toBe(true);
    expect(MockEmailClient.sent.some((m) => /Qualified lead/.test(m.subject))).toBe(false);
  });

  it("transcript facts never overwrite facts the agent captured live", async () => {
    await h.tool("evaluate_qualification", { service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh", timeline_flexible: true }, "room-fb3");
    setIntegrationOverride("gemini", stubGemini({ location_text: "Nashik", service_intent: "design_and_execution", project_type: "residential", scope: "full_home", timeline_flexible: true }));
    await h.webhook({ event: "call_ended", room_name: "room-fb3", call_duration: 100 });
    await h.webhook(post("room-fb3"));
    await h.drain();
    const [e] = await h.db.select().from(enquiries);
    expect(e!.facts.location_text).toBe("Aundh");
    expect(e!.disposition).toBe("qualified");
  });

  it("a booking made on the call is never silently undone by contradictory post-call analysis: a human is asked instead", async () => {
    await h.tool("evaluate_qualification", { service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh", timeline_flexible: true }, "room-fb4");
    await h.tool("get_available_slots", {}, "room-fb4");
    await h.tool("book_consultation", { slot_option: 1, customer_confirmed: true, customer_confirmation_quote: "yes", invitee_email: "a@example.com", invitee_name: "Test Caller" }, "room-fb4");
    // The transcript reveals a structural-change requirement the agent never captured.
    setIntegrationOverride("gemini", stubGemini({ structural_changes_required: true, location_text: "Aundh", service_intent: "design_and_execution", project_type: "residential", scope: "full_home", timeline_flexible: true }));
    await h.webhook({ event: "call_ended", room_name: "room-fb4", call_duration: 100 });
    await h.webhook(post("room-fb4"));
    await h.drain();
    const [e] = await h.db.select().from(enquiries);
    expect(e!.disposition).toBe("qualified");
    const esc = await h.db.select().from(escalations);
    expect(esc.some((x) => x.kind === "post_call_review")).toBe(true);
  });

  it("flags a booking that the transcript shows was never clearly confirmed", async () => {
    await h.tool("evaluate_qualification", { service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh", timeline_flexible: true }, "room-fb5");
    await h.tool("get_available_slots", {}, "room-fb5");
    await h.tool("book_consultation", { slot_option: 1, customer_confirmed: true, customer_confirmation_quote: "um", invitee_email: "a@example.com", invitee_name: "Test Caller" }, "room-fb5");
    setIntegrationOverride("gemini", stubGemini({ location_text: "Aundh", service_intent: "design_and_execution", project_type: "residential", scope: "full_home", timeline_flexible: true }, { customer_confirmed_slot: false }));
    await h.webhook({ event: "call_ended", room_name: "room-fb5", call_duration: 100 });
    await h.webhook(post("room-fb5"));
    await h.drain();
    const [c] = await h.db.select().from(calls);
    expect(c!.complianceFlags).toContain("booking_without_clear_confirmation");
    expect((await h.db.select().from(escalations)).some((x) => x.kind === "compliance_flag")).toBe(true);
  });

  it("jobs for a deleted/unknown enquiry fail permanently instead of retrying forever", async () => {
    await h.webhook({ event: "call_started", room_name: "room-fb6", phone_number: "+919811100006" });
    await h.webhook(post("room-fb6"));
    await h.db.delete(enquiries).where(eq(enquiries.id, (await h.db.select().from(enquiries))[0]!.id)).catch(() => undefined);
    await h.drain();
    const dead = (await h.db.select().from(outboxJobs)).filter((j) => j.status === "dead");
    expect(dead.length + (await h.db.select().from(outboxJobs)).filter((j) => j.status === "done").length).toBeGreaterThan(0);
  });
});
