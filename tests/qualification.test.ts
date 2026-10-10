import { describe, expect, it } from "vitest";
import { evaluateQualification, criterionByKey } from "@/lib/domain/qualification";
import { DEFAULT_QUALIFICATION_CONFIG, type QualificationConfig } from "@/lib/domain/config";
import { enquiryFactsSchema, emptyFacts, mergeFacts } from "@/lib/domain/types";
import { matchServiceArea } from "@/lib/domain/service-area";
import { FIXTURES, factsOf } from "./fixtures/transcripts";

const NOW = new Date("2026-10-10T05:00:00Z");

describe("qualification engine - transcript fixtures (T01-T20)", () => {
  for (const fx of FIXTURES) {
    it(`${fx.id}: ${fx.title} -> ${fx.expect.disposition}`, () => {
      const r = evaluateQualification(factsOf(fx), { now: new Date(fx.now) });
      expect(r.disposition).toBe(fx.expect.disposition);
      if (fx.expect.reason) {
        const codes = [...r.reasonCodes, r.escalation?.kind].filter(Boolean);
        expect(codes).toContain(fx.expect.reason);
      }
      // A rejected / escalated / unclear lead is never bookable.
      expect(r.canBook).toBe(r.disposition === "qualified");
    });
  }
});

describe("required qualification scenarios", () => {
  it("1. suitable residential full-home in Pune with authorised owner -> qualified, full score", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment", scope: "full_home",
        location_text: "Baner, Pune", desired_completion_date: "2027-03-01", authority: "decision_maker",
      }),
      { now: NOW },
    );
    expect(r.disposition).toBe("qualified");
    expect(r.score).toBe(100);
    expect(r.canBook).toBe(true);
  });

  it("2. office within size and service limits -> qualified", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "commercial", property_kind: "office", carpet_area_sqft: 2200,
        location_text: "Hinjewadi Phase 1", desired_completion_date: "2027-01-15",
      }),
      { now: NOW },
    );
    expect(r.disposition).toBe("qualified");
  });

  it("2b. office above ~3,000 sq ft goes to a human, never auto-qualified", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "commercial", property_kind: "office", carpet_area_sqft: 4200,
        location_text: "Baner", timeline_flexible: true,
      }),
      { now: NOW },
    );
    expect(r.disposition).toBe("human_escalation");
    expect(r.canBook).toBe(false);
  });

  it("3. Nashik (or any excluded location) -> rejected with a graceful script, no booking", () => {
    for (const loc of ["Nashik", "Talegaon Dabhade, near Pune", "Lonavala", "Mumbai - Powai"]) {
      const r = evaluateQualification(
        enquiryFactsSchema.parse({
          service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: loc, timeline_flexible: true,
        }),
        { now: NOW },
      );
      expect(r.disposition, loc).toBe("rejected");
      expect(r.canBook).toBe(false);
      expect(r.closingScript).toMatch(/Pune and PCMC/);
    }
  });

  it("4. styling-only / advice-only caller -> rejected", () => {
    for (const intent of ["advice_only", "styling_only", "furniture_sourcing_only", "vastu_only", "self_execution"]) {
      const r = evaluateQualification(enquiryFactsSchema.parse({ service_intent: intent, location_text: "Aundh" }), { now: NOW });
      expect(r.disposition, intent).toBe("rejected");
      expect(r.hardExclusions).toContain("advice_only");
    }
  });

  it("5. impossible timeline (3 weeks) -> rejected; no completion date is promised", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Wakad",
        desired_completion_date: "2026-10-31",
      }),
      { now: NOW },
    );
    expect(r.disposition).toBe("rejected");
    expect(r.hardExclusions).toContain("timeline_impossible");
    expect(r.closingScript).not.toMatch(/\bwill be (done|ready)\b/i);
  });

  it("6. clearly inadequate volunteered budget -> rejected, and the evidence never leaks an internal figure", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", scope: "partial_home", rooms_count: 2, carpet_area_sqft: 550,
        location_text: "Kharadi", timeline_flexible: true, budget_inr_max: "1,50,000".replace(/,/g, ""),
      }),
      { now: NOW },
    );
    expect(r.disposition).toBe("rejected");
    const text = JSON.stringify(r);
    expect(text).not.toMatch(/1,?800|2,?400|3\.5 lakh|per sq/i);
  });

  it("7. pricing question on an otherwise qualifying lead does not disqualify", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh",
        timeline_flexible: true, asked_about_pricing: true,
      }),
      { now: NOW },
    );
    expect(r.disposition).toBe("qualified");
  });

  it("8. declining to disclose a budget is neutral and costs no points", () => {
    const withDecline = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh",
        timeline_flexible: true, authority: "decision_maker", budget_declined: true,
      }),
      { now: NOW },
    );
    expect(withDecline.disposition).toBe("qualified");
    expect(criterionByKey(withDecline, "budget").status).toBe("unknown_neutral");
    expect(withDecline.score).toBe(100);
  });

  it("9. rented apartment, no structural changes -> qualified; structural changes -> human review", () => {
    const ok = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", scope: "partial_home", rooms_count: 3, location_text: "Baner",
        is_rented: true, structural_changes_required: false, timeline_flexible: true,
      }),
      { now: NOW },
    );
    expect(ok.disposition).toBe("qualified");
    const structural = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", scope: "partial_home", rooms_count: 3, location_text: "Baner",
        is_rented: true, structural_changes_required: true, timeline_flexible: true,
      }),
      { now: NOW },
    );
    expect(structural.disposition).toBe("human_escalation");
  });

  it("10. authorised family representative qualifies; researching-only with nobody attending is a (soft) failure", () => {
    const rep = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh",
        timeline_flexible: true, authority: "authorised_representative",
      }),
      { now: NOW },
    );
    expect(rep.disposition).toBe("qualified");

    const researching = evaluateQualification(
      enquiryFactsSchema.parse({
        service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh",
        timeline_flexible: true, authority: "researching_for_other", decision_makers_will_attend: false,
      }),
      { now: NOW },
    );
    // Single, non-hard failure -> conservative default is human review, not an automatic decline.
    expect(researching.failedCriteria).toEqual(["decision_maker"]);
    expect(researching.disposition).toBe("human_escalation");
    expect(researching.escalation?.kind).toBe("borderline_review");
  });

  it("11. unclear scope / location / timeline -> exactly one direct question, never a silent pass", () => {
    const noIntent = evaluateQualification(enquiryFactsSchema.parse({ location_text: "Baner" }), { now: NOW });
    expect(noIntent.disposition).toBe("clarification_required");
    expect(noIntent.nextQuestion).toBe("Are you looking for full design and execution, or design advice only?");

    const noLocation = evaluateQualification(
      enquiryFactsSchema.parse({ service_intent: "design_and_execution", project_type: "residential", scope: "full_home", timeline_flexible: true }),
      { now: NOW },
    );
    expect(noLocation.disposition).toBe("clarification_required");
    expect(noLocation.nextQuestion).toBe("Which locality is the property in?");

    const noTimeline = evaluateQualification(
      enquiryFactsSchema.parse({ service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh" }),
      { now: NOW },
    );
    expect(noTimeline.disposition).toBe("clarification_required");
    expect(noTimeline.nextQuestion).toMatch(/When would you need the project completed/);
    expect(noTimeline.canBook).toBe(false);
  });

  it("12. existing-customer complaint always escalates and is never bookable, whatever else is true", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({
        existing_customer_complaint: true, service_intent: "design_and_execution", project_type: "residential", scope: "full_home",
        location_text: "Viman Nagar", timeline_flexible: true,
      }),
      { now: NOW },
    );
    expect(r.disposition).toBe("human_escalation");
    expect(r.escalation?.kind).toBe("existing_customer_complaint");
    expect(r.escalation?.urgency).toBe("high");
    expect(r.canBook).toBe(false);
  });
});

describe("rule boundaries and policy", () => {
  const base = {
    service_intent: "design_and_execution", project_type: "residential", scope: "full_home", location_text: "Aundh",
  } as const;

  it("two or more confirmed failures -> rejected with the generic graceful close", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({ ...base, location_text: "Nashik", desired_completion_date: "2026-10-24" }),
      { now: NOW },
    );
    expect(r.failedCriteria.sort()).toEqual(["service_area", "timeline"]);
    expect(r.disposition).toBe("rejected");
    expect(r.closingScript).toMatch(/may not be the right fit/);
  });

  it("score never overrides a failed criterion (high score + hard failure still rejected)", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({ ...base, location_text: "Nashik", timeline_flexible: true, authority: "decision_maker" }),
      { now: NOW },
    );
    expect(r.score).toBe(75);
    expect(r.disposition).toBe("rejected");
  });

  it("singleHardExclusion=human_review sends a lone Nashik lead to a human instead", () => {
    const cfg: QualificationConfig = {
      ...DEFAULT_QUALIFICATION_CONFIG,
      rejectionPolicy: { ...DEFAULT_QUALIFICATION_CONFIG.rejectionPolicy, singleHardExclusion: "human_review" },
    };
    const r = evaluateQualification(enquiryFactsSchema.parse({ ...base, location_text: "Nashik", timeline_flexible: true }), { now: NOW, config: cfg });
    expect(r.disposition).toBe("human_escalation");
    expect(r.escalation?.kind).toBe("borderline_review");
    expect(r.closingScript).toBeNull();
  });

  it("autoRejectEnabled=false routes every would-be rejection to a human", () => {
    const cfg: QualificationConfig = {
      ...DEFAULT_QUALIFICATION_CONFIG,
      rejectionPolicy: { ...DEFAULT_QUALIFICATION_CONFIG.rejectionPolicy, autoRejectEnabled: false },
    };
    const r = evaluateQualification(enquiryFactsSchema.parse({ ...base, location_text: "Nashik", desired_completion_date: "2026-10-20" }), { now: NOW, config: cfg });
    expect(r.disposition).toBe("human_escalation");
  });

  it("unknown budget or authority never block qualification and never cost points", () => {
    const r = evaluateQualification(enquiryFactsSchema.parse({ ...base, timeline_flexible: true }), { now: NOW });
    expect(r.disposition).toBe("qualified");
    expect(r.score).toBe(100);
    expect(r.caveats.join(" ")).toMatch(/Budget not discussed|Decision-maker/);
  });

  it("timeline: exactly at the 6-week boundary passes with a tight caveat; just under fails", () => {
    const sixWeeks = new Date(NOW.getTime() + 6 * 7 * 86_400_000).toISOString().slice(0, 10);
    const underSix = new Date(NOW.getTime() + 5 * 7 * 86_400_000).toISOString().slice(0, 10);
    const ok = evaluateQualification(enquiryFactsSchema.parse({ ...base, desired_completion_date: sixWeeks }), { now: NOW });
    expect(ok.disposition).toBe("qualified");
    expect(criterionByKey(ok, "timeline").caveat).toMatch(/Tight timeline/);
    const bad = evaluateQualification(enquiryFactsSchema.parse({ ...base, desired_completion_date: underSix }), { now: NOW });
    expect(bad.disposition).toBe("rejected");
  });

  it("timeline: tightAction=human_review escalates a tight (but possible) deadline", () => {
    const cfg: QualificationConfig = {
      ...DEFAULT_QUALIFICATION_CONFIG,
      timeline: { ...DEFAULT_QUALIFICATION_CONFIG.timeline, tightAction: "human_review" },
    };
    const eightWeeks = new Date(NOW.getTime() + 8 * 7 * 86_400_000).toISOString().slice(0, 10);
    const r = evaluateQualification(enquiryFactsSchema.parse({ ...base, desired_completion_date: eightWeeks }), { now: NOW, config: cfg });
    expect(r.disposition).toBe("human_escalation");
  });

  it("a past completion date is not trusted - it asks the timeline question", () => {
    const r = evaluateQualification(enquiryFactsSchema.parse({ ...base, desired_completion_date: "2026-01-01" }), { now: NOW });
    expect(r.disposition).toBe("clarification_required");
  });

  it("a budget in the 'possibly tight' band is noted, not declined", () => {
    const r = evaluateQualification(
      enquiryFactsSchema.parse({ ...base, carpet_area_sqft: 1000, timeline_flexible: true, budget_inr_max: 1_100_000 }),
      { now: NOW },
    );
    expect(r.disposition).toBe("qualified");
    expect(r.caveats.join(" ")).toMatch(/tight/i);
  });

  it("weights are configurable but the rubric default totals 100", () => {
    const total = Object.values(DEFAULT_QUALIFICATION_CONFIG.weights).reduce((a, b) => a + b, 0);
    expect(total).toBe(100);
  });

  it("frustrated returning lead can auto-book only if the policy explicitly allows it", () => {
    const cfg: QualificationConfig = {
      ...DEFAULT_QUALIFICATION_CONFIG,
      escalation: { ...DEFAULT_QUALIFICATION_CONFIG.escalation, frustratedLeadAutoBook: true },
    };
    const r = evaluateQualification(enquiryFactsSchema.parse({ ...base, timeline_flexible: true, missed_followup: true }), { now: NOW, config: cfg });
    expect(r.disposition).toBe("qualified");
  });
});

describe("service-area matcher", () => {
  it.each([
    ["Kothrud", "in_area"],
    ["Pimple Saudagar", "in_area"],
    ["Pimpri-Chinchwad", "in_area"],
    ["Magarpatta - Cybercity area", "in_area"],
    ["Kharadi, Pune", "in_area"],
    ["Nashik", "out_of_area"],
    ["Talegaon Dabhade, near Pune", "out_of_area"],
    ["Hinjewadi but home is in Mumbai", "unknown"],
    ["somewhere near the highway", "unknown"],
    ["", "unknown"],
  ])("%s -> %s", (text, status) => {
    expect(matchServiceArea(text).status).toBe(status);
  });

  it("flags localities that are only assumed to be inside Pune city", () => {
    expect(matchServiceArea("Kharadi").caveat).toMatch(/not on the named list/);
    expect(matchServiceArea("Kothrud").caveat).toBeNull();
  });
});

describe("facts parsing is lenient but never invents values", () => {
  it("coerces LLM-style strings and maps junk to null", () => {
    const f = enquiryFactsSchema.parse({
      carpet_area_sqft: "1,400", is_rented: "yes", bhk: "unknown", service_intent: "Design and Execution",
      budget_inr_max: "₹1,50,000", scope: "something-weird", desired_completion_date: "March 2027",
    });
    expect(f.carpet_area_sqft).toBe(1400);
    expect(f.is_rented).toBe(true);
    expect(f.bhk).toBeNull();
    expect(f.service_intent).toBe("design_and_execution");
    expect(f.budget_inr_max).toBe(150000);
    expect(f.scope).toBeNull();
    expect(f.desired_completion_date).toBeNull(); // unparseable dates are unknown, not guessed
  });

  it("tool runners that send defaults for every field: zeros are 'not stated' and safety flags never revert to false", () => {
    const first = enquiryFactsSchema.parse({ existing_customer_complaint: true, location_text: "Viman Nagar", bhk: 2 });
    const defaults = enquiryFactsSchema.parse({ existing_customer_complaint: false, requests_senior: "", bhk: 0, carpet_area_sqft: "0", budget_inr_max: 0, rooms_count: "", location_text: "" });
    expect(defaults.bhk).toBeNull();
    expect(defaults.budget_inr_max).toBeNull();
    const merged = mergeFacts(first, defaults);
    expect(merged.existing_customer_complaint).toBe(true);
    expect(merged.bhk).toBe(2);
    expect(merged.location_text).toBe("Viman Nagar");
  });

  it("mergeFacts: null never erases a known value", () => {
    const merged = mergeFacts(enquiryFactsSchema.parse({ location_text: "Baner", bhk: 2 }), { location_text: null, bhk: 3 });
    expect(merged.location_text).toBe("Baner");
    expect(merged.bhk).toBe(3);
    expect(Object.values(emptyFacts()).every((v) => v === null)).toBe(true);
  });
});
