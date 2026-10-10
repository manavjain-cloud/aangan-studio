import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { callEvents, callTranscripts, calls, enquiries, escalations, hubspotSyncs, integrationEvents, notifications, outboxJobs, usageRecords } from "@/lib/db/schema";
import { MockEmailClient } from "@/lib/integrations/email/mock";
import { MockGeminiClient } from "@/lib/integrations/gemini/mock";
import { MockHubspotClient } from "@/lib/integrations/hubspot/mock";
import { MockVaaniClient } from "@/lib/integrations/vaani/mock";
import { HubspotError } from "@/lib/integrations/hubspot/types";
import { EmailError } from "@/lib/integrations/email/types";
import { QUALIFYING_FACTS, makeHarness, type Harness } from "./helpers/harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

/** Make every pending/failed job due now (simulates time passing for backoff). */
async function makeJobsDue() {
  await h.db.execute(sql`update outbox_jobs set next_attempt_at = now() - interval '1 second' where status in ('pending','failed')`);
}

const PHONE = "+919822000111";
const start = (callId: string, iso: string, phone = PHONE) => ({ event: "call_started", room_name: callId, phone_number: phone, timestamp: iso, status: "dialing" });

describe("Vaani webhook ingestion", () => {
  it("15. two deliveries of the same event are processed once", async () => {
    const e = start("room-dup", "2026-10-12T05:00:00Z");
    expect((await h.webhook(e)).status).toBe("processed");
    expect((await h.webhook(e)).status).toBe("duplicate");
    expect(await h.db.select().from(calls)).toHaveLength(1);
    const evs = await h.db.select().from(integrationEvents).where(eq(integrationEvents.eventType, "call_started"));
    expect(evs).toHaveLength(1);
  });

  it("13. an after-hours call (10:47 pm IST) is answered, flagged after-hours and still flows through qualification and booking", async () => {
    await h.webhook(start("room-night", "2026-10-12T17:17:00Z")); // 22:47 IST
    const [c] = await h.db.select().from(calls);
    expect(c!.afterHours).toBe(true);
    await h.webhook({ event: "user_picked_up_at", room_name: "room-night", status: "active" });
    const eval1 = await h.tool("evaluate_qualification", QUALIFYING_FACTS, "room-night");
    expect(eval1.body.status).toBe("qualified");
    await h.tool("get_available_slots", {}, "room-night");
    const booked = await h.tool("book_consultation", { slot_option: 1, customer_confirmed: true, customer_confirmation_quote: "yes", invitee_email: "night@example.com" }, "room-night");
    expect(booked.body.status).toBe("booked");
    const [after] = await h.db.select().from(calls);
    expect(after!.answered).toBe(true);
    expect(after!.answeredAt).not.toBeNull();
  });

  it("a daytime call is not flagged after-hours", async () => {
    await h.webhook(start("room-day", "2026-10-12T06:00:00Z")); // 11:30 IST
    expect((await h.db.select().from(calls))[0]!.afterHours).toBe(false);
  });

  it("14. a dropped call followed by a redial shares one enquiry, carries facts over and sends NO call-back email", async () => {
    await h.webhook(start("room-1", "2026-10-12T08:44:00Z"));
    await h.webhook({ event: "user_picked_up_at", room_name: "room-1" });
    await h.tool("save_enquiry_progress", { caller_name: "Ritu Kapoor", location_text: "Pimple Saudagar", bhk: 3 }, "room-1");
    await h.webhook({ event: "call_ended", room_name: "room-1", call_duration: 72, end_reason: "USER_DISCONNECTED" });
    const [first] = await h.db.select().from(calls);
    expect(first!.state).toBe("abandoned");
    expect(first!.answered).toBe(true);

    await h.webhook(start("room-2", "2026-10-12T08:46:00Z"));
    const rows = await h.db.select().from(calls).orderBy(calls.receivedAt);
    expect(rows).toHaveLength(2);
    expect(rows[1]!.enquiryId).toBe(rows[0]!.enquiryId);
    expect(rows[1]!.relatedCallId).toBe(rows[0]!.id);
    expect(await h.db.select().from(enquiries)).toHaveLength(1);

    const ctx = await h.tool("get_call_context", {}, "room-2");
    const known = (ctx.body.data as { already_known: Record<string, unknown>; repeat_call: boolean });
    expect(known.repeat_call).toBe(true);
    expect(known.already_known.location_text).toBe("Pimple Saudagar");
    expect(ctx.body.instruction).toMatch(/do not ask again/i);

    await makeJobsDue();
    await h.db.execute(sql`update outbox_jobs set next_attempt_at = now() - interval '1 second'`);
    await h.drain();
    expect(MockEmailClient.sent.filter((m) => /Call-back needed/.test(m.subject))).toHaveLength(0);
  });

  it("14b. a dropped call with no redial produces exactly one call-back email to the front desk", async () => {
    await h.webhook(start("room-solo", "2026-10-12T08:44:00Z"));
    await h.webhook({ event: "user_picked_up_at", room_name: "room-solo" });
    await h.tool("save_enquiry_progress", { caller_name: "Dropped Caller", location_text: "Baner" }, "room-solo");
    await h.webhook({ event: "call_ended", room_name: "room-solo", call_duration: 40 });
    await h.db.execute(sql`update outbox_jobs set next_attempt_at = now() - interval '1 second'`);
    await h.drain();
    await h.drain();
    const mails = MockEmailClient.sent.filter((m) => /Call-back needed/.test(m.subject));
    expect(mails).toHaveLength(1);
    expect(mails[0]!.to).toBe("frontdesk@aangan.test");
  });

  it("outbound-direction events are ignored (phone-inbound only build)", async () => {
    const r = await h.webhook({ event: "call_started", room_name: "out-1", direction: "outbound", phone_number: PHONE });
    expect(r.status).toBe("ignored");
    expect(await h.db.select().from(calls)).toHaveLength(0);
  });

  it("a connectivity test / unrecognised payload is acknowledged (no Vaani retry storm), logged, and creates no call", async () => {
    expect((await h.webhook({ nothing: true })).status).toBe("ignored");
    expect((await h.webhook({ event: "call_started" })).status).toBe("ignored");
    expect((await h.webhook({ event: "webhook.test", message: "hello" })).status).toBe("ignored");
    expect(await h.db.select().from(calls)).toHaveLength(0);
    const logged = await h.db.select().from(integrationEvents);
    expect(logged).toHaveLength(3);
    expect(logged.every((e) => e.status === "rejected")).toBe(true);
  });

  it("a call with no webhook still works: the first tool call creates the call record", async () => {
    const r = await h.tool("save_enquiry_progress", { caller_name: "No Webhook" }, "room-nohook", { caller_phone: PHONE });
    expect(r.body.ok).toBe(true);
    const [c] = await h.db.select().from(calls);
    expect(c!.fromNumber).toBe(PHONE);
  });
});

describe("post-call processing: Gemini, HubSpot, email, compliance", () => {
  const transcript = (agentLine = "Thank you, a designer will walk you through everything at the consultation.") =>
    `[10:00:01] AGENT: Hello, Aangan Studio.\n\n[10:00:05] USER: Hi, I have a 3BHK in Kothrud and want full design and execution.\n\n[10:00:20] AGENT: ${agentLine}`;

  async function completedCall(callId: string, qualified = true) {
    await h.webhook(start(callId, "2026-10-12T05:00:00Z"));
    await h.webhook({ event: "user_picked_up_at", room_name: callId });
    if (qualified) await h.tool("evaluate_qualification", QUALIFYING_FACTS, callId);
    await h.webhook({ event: "call_ended", room_name: callId, call_duration: 180 });
  }
  const post = (callId: string, tr = transcript()) => ({
    event: "call_postprocessing", call_id: callId, timestamp: "2026-10-12T05:04:00Z",
    data: { room_name: callId, call_id: callId, call_duration: 180_000, end_reason: "Call ended", summary: "vaani summary", transcript: tr },
  });

  it("stores a redacted transcript with an expiry, enriches the call, syncs HubSpot once and emails the handoff for a qualified lead with no booking", async () => {
    await completedCall("room-pc");
    await h.webhook(post("room-pc", transcript() + "\n\n[10:01:00] USER: My card 4111111111111111 and key sk-abcdef1234567890 are secret"));
    const [t] = await h.db.select().from(callTranscripts);
    expect(t!.text).not.toMatch(/4111111111111111|sk-abcdef/);
    expect(t!.expiresAt!.getTime()).toBeGreaterThan(Date.now());

    await h.drain();
    const [c] = await h.db.select().from(calls);
    expect(c!.postProcessedAt).not.toBeNull();
    expect(c!.summary).toMatch(/SIMULATED SUMMARY/); // mock Gemini is always labelled
    expect(MockHubspotClient.snapshot.contacts).toHaveLength(1);
    expect(MockHubspotClient.snapshot.notes).toHaveLength(1);
    const handoff = MockEmailClient.sent.filter((m) => /Qualified lead - arrange consultation/.test(m.subject));
    expect(handoff.length).toBeGreaterThan(0);
    expect(handoff[0]!.html).toContain("No consultation booked yet");
    const usage = await h.db.select().from(usageRecords);
    expect(usage.some((u) => u.provider === "gemini")).toBe(true);
    expect(usage.find((u) => u.provider === "gemini")!.costInr).toBeNull(); // no rate configured => nothing invented
  });

  it("re-delivered post-processing does not duplicate the CRM contact, note, or emails", async () => {
    await completedCall("room-redo");
    await h.webhook(post("room-redo"));
    await h.drain();
    const mailsBefore = MockEmailClient.sent.length;
    expect((await h.webhook(post("room-redo"))).status).toBe("duplicate");
    await h.drain();
    expect(MockHubspotClient.snapshot.contacts).toHaveLength(1);
    expect(MockHubspotClient.snapshot.notes).toHaveLength(1);
    expect(MockEmailClient.sent.length).toBe(mailsBefore);
  });

  it("rejected calls are logged to HubSpot (so reporting is not biased) but trigger no qualified-lead email", async () => {
    await h.webhook(start("room-rej", "2026-10-12T05:00:00Z"));
    await h.tool("evaluate_qualification", { ...QUALIFYING_FACTS, location_text: "Nashik" }, "room-rej");
    await h.webhook({ event: "call_ended", room_name: "room-rej", call_duration: 120 });
    await h.webhook(post("room-rej"));
    await h.drain();
    expect(MockHubspotClient.snapshot.contacts[0]!.properties.aangan_disposition).toBe("rejected");
    expect(MockHubspotClient.snapshot.contacts[0]!.properties.aangan_rejection_reason).toMatch(/out_of_area/);
    expect(MockEmailClient.sent.filter((m) => /Qualified lead|Consultation booked/.test(m.subject))).toHaveLength(0);
  });

  it("19. a HubSpot failure does not break the call; the job retries with backoff and then writes exactly one contact", async () => {
    await completedCall("room-hs");
    MockHubspotClient.failNext(new HubspotError("server_error", "mock 503", 503));
    await h.webhook(post("room-hs"));
    await h.drain();
    const failed = await h.db.select().from(outboxJobs).where(eq(outboxJobs.type, "hubspot_sync"));
    expect(failed[0]!.status).toBe("failed");
    expect(failed[0]!.attempts).toBe(1);
    expect(MockHubspotClient.snapshot.contacts).toHaveLength(0);
    const [sync] = await h.db.select().from(hubspotSyncs);
    expect(sync!.lastStatus).toBe("failed");

    await makeJobsDue();
    await h.drain();
    expect(MockHubspotClient.snapshot.contacts).toHaveLength(1);
    const [sync2] = await h.db.select().from(hubspotSyncs);
    expect(sync2!.lastStatus).toBe("synced");
    const done = await h.db.select().from(outboxJobs).where(eq(outboxJobs.type, "hubspot_sync"));
    expect(done.every((j) => j.status === "done")).toBe(true);
  });

  it("19b. HubSpot permanently failing marks the job dead and alerts ops by email", async () => {
    await completedCall("room-hs2");
    MockHubspotClient.failAlways(new HubspotError("server_error", "mock 500", 500));
    await h.webhook(post("room-hs2"));
    for (let i = 0; i < 8; i++) {
      await h.drain();
      await makeJobsDue();
    }
    await h.drain();
    const jobs = await h.db.select().from(outboxJobs).where(eq(outboxJobs.type, "hubspot_sync"));
    expect(jobs[0]!.status).toBe("dead");
    expect(jobs[0]!.attempts).toBe(6);
    expect(MockEmailClient.sent.some((m) => m.subject.startsWith("[Ops] Background job failed permanently"))).toBe(true);
    MockHubspotClient.failAlways(null);
  });

  it("20. an email delivery failure is recorded, retried, and delivered exactly once to each recipient", async () => {
    await completedCall("room-em");
    MockEmailClient.failNext(new EmailError("server_error", "mock provider 500", 500));
    await h.webhook(post("room-em"));
    await h.drain();
    let rows = await h.db.select().from(notifications);
    expect(rows.some((n) => n.status === "failed" && /mock provider 500/.test(n.error ?? ""))).toBe(true);
    await makeJobsDue();
    await h.drain();
    rows = await h.db.select().from(notifications);
    expect(rows.every((n) => n.status === "sent")).toBe(true);
    const keys = MockEmailClient.sent.map((m) => `${m.to}|${m.subject}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("21. Gemini returning invalid structured output: retried, then falls back to a labelled deterministic summary - no invented facts", async () => {
    await completedCall("room-gm");
    MockGeminiClient.behaviour = "invalid_output";
    await h.webhook(post("room-gm"));
    await h.drain(); // attempt 1 fails -> job scheduled for retry
    const realJob = () => h.db.select().from(outboxJobs).where(sql`idempotency_key like ${"postcall:%"}`);
    let [job] = await realJob();
    expect(job!.status).toBe("failed");
    const [mid] = await h.db.select().from(calls);
    expect(mid!.postProcessedAt).toBeNull();

    await h.db.execute(sql`update outbox_jobs set attempts = max_attempts - 1 where type = 'postcall_enrich'`);
    await makeJobsDue();
    await h.drain(); // final attempt -> fallback path
    [job] = await realJob();
    expect(job!.status).toBe("done");
    const [c] = await h.db.select().from(calls);
    expect(c!.summary).toMatch(/AI summary unavailable/);
    const [e] = await h.db.select().from(enquiries);
    expect(e!.facts.location_text).toBe("Kothrud, Pune"); // unchanged: nothing fabricated
  });

  it("flags and escalates any call where the AGENT stated a price, emailing ops", async () => {
    await completedCall("room-price");
    await h.webhook(post("room-price", transcript("For a 2BHK it's typically around 2 lakhs, our rates start at ₹1,800 per sq ft.")));
    await h.drain();
    const [c] = await h.db.select().from(calls);
    expect(c!.complianceFlags).toContain("agent_price_disclosure");
    const esc = await h.db.select().from(escalations).where(eq(escalations.kind, "compliance_flag"));
    expect(esc).toHaveLength(1);
    expect(MockEmailClient.sent.find((m) => m.subject.includes("Compliance flag"))?.to).toBe("ops@aangan.test");
  });

  it("when Vaani has no transcript in the webhook, post-processing fetches it from the Vaani API", async () => {
    await completedCall("room-api");
    MockVaaniClient.setDetails("room-api", { transcript: transcript(), summary: "from vaani", entities: null, evalTag: null, ready: true });
    await h.webhook({ event: "call_postprocessing", call_id: "room-api", data: { room_name: "room-api", call_id: "room-api", call_duration: 1000 } });
    await h.drain();
    const [t] = await h.db.select().from(callTranscripts);
    expect(t!.text).toContain("Kothrud");
  });

  it("if Vaani never sends call_postprocessing, a delayed fallback still enriches the call, syncs HubSpot and emails the handoff", async () => {
    await completedCall("room-nopp"); // call_ended only - no post-processing webhook
    await h.drain();
    expect(MockHubspotClient.snapshot.contacts).toHaveLength(0); // nothing yet: the fallback is delayed
    await makeJobsDue();
    await h.drain();
    await makeJobsDue();
    await h.drain();
    expect(MockHubspotClient.snapshot.contacts).toHaveLength(1);
    expect(MockEmailClient.sent.some((m) => /Qualified lead - arrange consultation/.test(m.subject))).toBe(true);
    const [c] = await h.db.select().from(calls);
    expect(c!.postProcessedAt).not.toBeNull();
  });

  it("the fallback does nothing when post-processing already ran (no double analysis, no duplicate emails)", async () => {
    await completedCall("room-both");
    await h.webhook(post("room-both"));
    await h.drain();
    const mails = MockEmailClient.sent.length;
    const usageRows = (await h.db.select().from(usageRecords)).length;
    await makeJobsDue();
    await h.drain();
    expect(MockEmailClient.sent.length).toBe(mails);
    expect((await h.db.select().from(usageRecords)).length).toBe(usageRows);
  });

  it("records the audit trail of call state changes for the call", async () => {
    await completedCall("room-audit");
    const evs = await h.db.select().from(callEvents);
    expect(evs.some((e) => e.type === "state_changed")).toBe(true);
    expect(JSON.stringify(evs)).not.toMatch(/priya@|\+9198/); // PII is redacted from event detail
  });
});

describe("Vaani's real webhook payload shape (nested under `data`)", () => {
  let hh: Harness;
  beforeEach(async () => {
    hh = await makeHarness();
  });
  afterEach(async () => {
    await hh.close();
  });

  it("creates the call from data.*, reads duration/end reason from data, and honours picked_up_at", async () => {
    const r = await hh.webhook({ event: "call_started", timestamp: "2026-10-12T05:00:00Z", data: { call_id: "r1", room_name: "r1", call_type: "Inbound", agent_name: "A", phone_number: "+919876500001" } });
    expect(r.status).toBe("processed");
    await hh.webhook({ event: "user_picked_up_at", timestamp: "2026-10-12T05:00:09Z", data: { call_id: "r1", room_name: "r1", picked_up_at: "2026-10-12T05:00:03Z" } });
    await hh.webhook({ event: "call_ended", timestamp: "2026-10-12T05:02:00Z", data: { call_id: "r1", room_name: "r1", end_reason: "completed", call_duration: 120, technical_issue: false } });
    const [c] = await hh.db.select().from(calls);
    expect(c!.fromNumber).toBe("+919876500001");
    expect(c!.answeredAt!.toISOString()).toBe("2026-10-12T05:00:03.000Z");
    expect(c!.durationMs).toBe(120_000);
    expect(c!.endReason).toBe("completed");
  });

  it("Outbound calls (call_type inside data) are ignored: this build is inbound-only", async () => {
    const r = await hh.webhook({ event: "call_started", data: { call_id: "o1", room_name: "o1", call_type: "Outbound", phone_number: "+919876500002" } });
    expect(r.status).toBe("ignored");
    expect(await hh.db.select().from(calls)).toHaveLength(0);
  });

  it("the dashboard connectivity-test payload (a batch under `events`) is acknowledged and logged, creating no call", async () => {
    const r = await hh.webhook({ event: "webhook_test", timestamp: "2026-10-12T05:00:00Z", events: [{ event: "call_started", data: { call_id: "test_room_123", room_name: "test_room_123" } }] });
    expect(r.status).toBe("ignored");
    expect(await hh.db.select().from(calls)).toHaveLength(0);
  });
});
