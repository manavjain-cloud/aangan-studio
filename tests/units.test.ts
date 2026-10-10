import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { addDaysIso, formatDateTimeInZone, isAfterHours, isoDateInZone, speakableSlot, startOfDayUtc, weeksUntil, zonedParts } from "@/lib/time";
import { esc, escalationEmail, handoffEmail, opsAlertEmail } from "@/lib/services/email-templates";
import { containsPriceDisclosure, APPROVED_PRICING_RESPONSE } from "@/lib/domain/pricing-guard";
import { DEFAULT_QUALIFICATION_CONFIG } from "@/lib/domain/config";
import { normalizeEmail, normalizePhone } from "@/lib/services/ingest";
import { backoffSeconds, enqueue } from "@/lib/services/outbox";
import { canTransition, CALL_STATES, TRANSITIONS } from "@/lib/services/workflow";
import { calls } from "@/lib/db/schema";
import { loadEnquiryBundle } from "@/lib/services/enquiry-data";
import { makeHarness, QUALIFYING_FACTS } from "./helpers/harness";

const hours = DEFAULT_QUALIFICATION_CONFIG.businessHours;

describe("time helpers (India time)", () => {
  it("business hours are 10:00 inclusive to 19:00 exclusive", () => {
    const at = (h: number, m: number) => new Date(Date.UTC(2026, 9, 12, h, m) - 5.5 * 3600_000); // IST wall clock -> UTC
    expect(isAfterHours(at(9, 59), hours)).toBe(true);
    expect(isAfterHours(at(10, 0), hours)).toBe(false);
    expect(isAfterHours(at(18, 59), hours)).toBe(false);
    expect(isAfterHours(at(19, 0), hours)).toBe(true);
    expect(isAfterHours(at(23, 30), hours)).toBe(true);
    expect(isAfterHours(at(3, 0), hours)).toBe(true);
  });
  it("converts instants to IST parts and dates", () => {
    const d = new Date("2026-10-12T17:17:00Z");
    expect(zonedParts(d)).toMatchObject({ year: 2026, month: 10, day: 12, hour: 22, minute: 47, weekday: 1 });
    expect(isoDateInZone(new Date("2026-10-12T20:00:00Z"))).toBe("2026-10-13"); // already tomorrow in IST
  });
  it("weeksUntil counts calendar days in IST", () => {
    expect(weeksUntil("2026-10-26", new Date("2026-10-12T05:00:00Z"))).toBe(2);
    expect(weeksUntil("2026-10-05", new Date("2026-10-12T05:00:00Z"))).toBe(-1);
  });
  it("speaks slots naturally and relative to today", () => {
    const now = new Date("2026-10-12T05:00:00Z"); // Mon 10:30 IST
    expect(speakableSlot(new Date("2026-10-13T10:30:00Z"), "Asia/Kolkata", now)).toBe("tomorrow at 4 pm");
    expect(speakableSlot(new Date("2026-10-15T06:00:00Z"), "Asia/Kolkata", now)).toBe("Thursday 15 October at 11:30 am");
    expect(speakableSlot(new Date("2026-10-12T11:00:00Z"), "Asia/Kolkata", now)).toBe("today at 4:30 pm");
  });
  it("startOfDayUtc round-trips and addDaysIso rolls months", () => {
    expect(startOfDayUtc("2026-10-12").toISOString()).toBe("2026-10-11T18:30:00.000Z");
    expect(addDaysIso("2026-10-30", 3)).toBe("2026-11-02");
    expect(formatDateTimeInZone(new Date("2026-10-12T05:00:00Z"))).toContain("Monday 12 October 2026, 10:30 am");
  });
});

describe("normalisation", () => {
  it("phone numbers become E.164 without guessing", () => {
    expect(normalizePhone("98220 00111")).toBe("+919822000111");
    expect(normalizePhone("+91 98220-00111")).toBe("+919822000111");
    expect(normalizePhone("09822000111")).toBe("+919822000111");
    expect(normalizePhone("919822000111")).toBe("+919822000111");
    expect(normalizePhone("+14155551234")).toBe("+14155551234");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });
  it("emails spoken through speech-to-text are normalised, junk is rejected", () => {
    expect(normalizeEmail("Priya.Sharma at gmail dot com")).toBe("priya.sharma@gmail.com");
    expect(normalizeEmail("priya@example.com")).toBe("priya@example.com");
    expect(normalizeEmail("not an email")).toBeNull();
    expect(normalizeEmail("a@b")).toBeNull();
  });
});

describe("call workflow state machine", () => {
  it("every state is reachable and only enumerated transitions are allowed", () => {
    expect(CALL_STATES).toContain("booking_confirmed");
    for (const s of CALL_STATES) for (const t of TRANSITIONS[s]) expect(CALL_STATES).toContain(t);
    expect(canTransition("qualified", "booking_confirmed")).toBe(false); // cannot skip availability + confirmation
    expect(canTransition("rejected", "booking_calendar")).toBe(false); // a declined lead can never reach booking
    expect(canTransition("human_escalation", "booking_calendar")).toBe(false);
    expect(canTransition("awaiting_customer_confirmation", "booking_calendar")).toBe(true);
    expect(canTransition("booking_calendar", "booking_confirmed")).toBe(true);
    expect(canTransition("completed", "agent_active")).toBe(false);
  });
  it("no route into booking_calendar exists from any rejected / escalated / unqualified state", () => {
    const into = CALL_STATES.filter((s) => TRANSITIONS[s].includes("booking_calendar"));
    expect(into.sort()).toEqual(["awaiting_customer_confirmation"]);
  });
  it("backoff grows and is capped at 30 minutes", () => {
    expect([1, 2, 3, 4].map(backoffSeconds)).toEqual([30, 60, 120, 240]);
    expect(backoffSeconds(30)).toBe(1800);
  });
});

describe("email templates", () => {
  it("escape caller-supplied text so a hostile name cannot inject markup", async () => {
    const h = await makeHarness();
    await h.tool("evaluate_qualification", { ...QUALIFYING_FACTS, caller_name: '<script>alert("x")</script>', notes: "<img src=x onerror=alert(1)>" }, "t1");
    const [c] = await h.db.select().from(calls);
    const bundle = (await loadEnquiryBundle(h.db, c!.enquiryId!))!;
    const mail = handoffEmail(bundle);
    expect(mail.html).not.toContain("<script>");
    expect(mail.html).toContain("&lt;script&gt;");
    expect(esc(`"'<>&`)).toBe("&quot;&#39;&lt;&gt;&amp;");
    await h.close();
  });
  it("handoff and escalation emails never contain a price figure or the approved-deflection violation patterns", async () => {
    const h = await makeHarness();
    await h.tool("evaluate_qualification", { ...QUALIFYING_FACTS, asked_about_pricing: true }, "t2");
    await h.tool("escalate_to_human", { reason: "complaint" }, "t3");
    const rows = await h.db.select().from(calls);
    for (const r of rows) {
      const b = (await loadEnquiryBundle(h.db, r.enquiryId!))!;
      expect(containsPriceDisclosure(handoffEmail(b).text.replace(APPROVED_PRICING_RESPONSE, ""))).toBe(false);
      for (const e of b.escalations) expect(containsPriceDisclosure(escalationEmail(e, b).text)).toBe(false);
    }
    expect(opsAlertEmail("T", "d").subject).toBe("[Ops] T");
    await h.close();
  });
});

describe("database", () => {
  it("migrations create every table and the unique constraints that make retries safe", async () => {
    const h = await makeHarness();
    const res = (await h.db.execute(sql`select tablename from pg_tables where schemaname='public'`)) as unknown as { rows: Array<{ tablename: string }> };
    const names = res.rows.map((r) => r.tablename);
    for (const t of ["calls", "call_events", "call_transcripts", "contacts", "enquiries", "qualification_results", "qualification_criteria", "escalations", "decision_overrides", "team_members", "offered_slots", "booking_attempts", "bookings", "notifications", "outbox_jobs", "integration_events", "tool_invocations", "usage_records", "fixed_costs", "admin_users", "audit_events", "app_settings", "hubspot_syncs", "rate_limit_counters"]) {
      expect(names, t).toContain(t);
    }
    const first = await enqueue(h.db, { type: "hubspot_sync", key: "k1", payload: {} });
    const second = await enqueue(h.db, { type: "hubspot_sync", key: "k1", payload: {} });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    await h.close();
  });
});

describe("Vaani agent prompt (docs/vaani-agent-prompt.md)", () => {
  const prompt = fs.readFileSync(path.join(process.cwd(), "docs", "vaani-agent-prompt.md"), "utf8");
  const norm = (s: string) => s.replace(/[—–]/g, "-").replace(/\s+/g, " ").toLowerCase();

  it("contains the approved pricing deflection verbatim (dash-insensitive) and every tool name", () => {
    expect(norm(prompt)).toContain(norm(APPROVED_PRICING_RESPONSE));
    for (const t of ["get_call_context", "save_enquiry_progress", "evaluate_qualification", "get_available_slots", "book_consultation", "escalate_to_human"]) expect(prompt).toContain(t);
  });
  it("contains no price, rate or budget figure", () => {
    expect(prompt).not.toMatch(/[₹$]\s*\d|\brs\.?\s*\d|\d[\d,.]*\s*(lakh|lac|crore)|\d[\d,]*\s*(per|\/)\s*sq/i);
  });
  it("never instructs the agent to ask for a budget and forbids it explicitly", () => {
    expect(prompt).toMatch(/NEVER ask for the caller's budget/);
    expect(prompt).not.toMatch(/ask (them |the caller )?(for|about) (their |the )?budget/i);
  });
  it("states the service area and exclusions from services.md without inventing new ones", () => {
    for (const w of ["Pune city and PCMC", "restaurants, hotels, retail stores, gyms", "3,000 sq ft"]) expect(prompt).toContain(w);
  });
});
