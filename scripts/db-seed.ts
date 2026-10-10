import { sql } from "drizzle-orm";
import { closeDb, getDb, migrateDb } from "@/lib/db/client";
import { teamMembers } from "@/lib/db/schema";
import { FIXTURES } from "../tests/fixtures/transcripts";
import { handleToolRequest } from "@/lib/services/voice-tools";
import { handleVaaniEvent } from "@/lib/services/calls";
import { processOutbox } from "@/lib/services/jobs";
import { MockCalendlyClient } from "@/lib/integrations/calendly/mock";
import { addDaysIso, isoDateInZone } from "@/lib/time";

/**
 * DEVELOPMENT SAMPLE DATA. Replays the September transcripts T01-T20 (as structured facts) plus a few extra
 * scenarios through the REAL webhook + tool + job code, using the simulated adapters, then relabels every row
 * mode='seed' so the dashboard shows a "Development sample data" banner and the "Live" filter excludes it.
 * Refuses to run in production or against an external database unless --force is passed.
 */
const force = process.argv.includes("--force");
if (process.env.NODE_ENV === "production" || (process.env.DATABASE_URL && !force)) {
  console.error("Refusing to seed: this writes SAMPLE data. Run only against a development database (pass --force to override).");
  process.exit(1);
}
process.env.FORCE_MOCK_INTEGRATIONS = "1";
process.env.VOICE_TOOL_SECRET ??= "seed-script";
process.env.VAANI_WEBHOOK_TOKEN ??= "seed-script";

await migrateDb();
const db = await getDb();

const existing = await db.select().from(teamMembers);
if (existing.length === 0) {
  await db.insert(teamMembers).values([
    { name: "Dev Designer 1", email: "designer1@example.invalid", role: "designer", calendlyEventTypeUri: "https://api.calendly.com/event_types/DEV-DESIGNER-1" },
    { name: "Dev Designer 2", email: "designer2@example.invalid", role: "designer", calendlyEventTypeUri: "https://api.calendly.com/event_types/DEV-DESIGNER-2", handles: ["residential"] },
    { name: "Dev Designer 3", email: "designer3@example.invalid", role: "designer", calendlyEventTypeUri: "https://api.calendly.com/event_types/DEV-DESIGNER-3", handles: ["commercial"] },
    { name: "Dev Front Desk", email: "frontdesk@example.invalid", role: "front_desk", calendlyEventTypeUri: null },
    { name: "Dev Senior (Nikhil placeholder)", email: "senior@example.invalid", role: "senior", calendlyEventTypeUri: null },
  ]);
  console.log("Inserted 5 development team members (example.invalid addresses).");
}

MockCalendlyClient.reset();
const today = isoDateInZone(new Date());
const shiftDate = (iso: unknown, fromNow: string): unknown => {
  if (typeof iso !== "string") return iso;
  const days = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${fromNow.slice(0, 10)}T00:00:00Z`)) / 86_400_000);
  return addDaysIso(today, days);
};

let n = 0;
const tool = (action: string, callId: string, data: Record<string, unknown>) =>
  handleToolRequest(db, { action, call_id: callId, request_id: `seed-${++n}`, args: data }, { ip: "seed" });
const hook = (payload: Record<string, unknown>) => handleVaaniEvent(db, payload);

function callTimeFor(i: number, fixtureNow: string): Date {
  const base = new Date(fixtureNow);
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.round(1 + i * 1.4));
  d.setUTCHours(base.getUTCHours(), base.getUTCMinutes(), 0, 0);
  return d;
}
const iso = (d: Date, plusSec = 0) => new Date(d.getTime() + plusSec * 1000).toISOString();

function transcriptFor(facts: Record<string, unknown>): string {
  const bits = [facts.bhk ? `${facts.bhk}BHK` : null, facts.property_kind, facts.location_text].filter(Boolean).join(", ");
  return [
    "[10:00:01] AGENT: Hello, you've reached Aangan Studio. How can I help you today?",
    `[10:00:08] USER: (sample data) I'm enquiring about a project: ${bits || "details given on the call"}.`,
    facts.asked_about_pricing ? `[10:01:10] USER: Can you give me a rough price?\n\n[10:01:14] AGENT: ${"Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like."}` : "[10:01:10] AGENT: Thank you, let me note that down.",
  ].join("\n\n");
}

let bookedCount = 0;
for (const [i, fx] of FIXTURES.entries()) {
  const callId = `seed-${fx.id}`;
  const t = callTimeFor(i, fx.now);
  const phone = `+9199000${String(1000 + i)}`;
  const facts = { ...fx.facts } as Record<string, unknown>;
  facts.desired_completion_date = shiftDate(facts.desired_completion_date, fx.now);
  facts.site_available_date = shiftDate(facts.site_available_date, fx.now);

  await hook({ event: "call_started", room_name: callId, phone_number: phone, timestamp: iso(t) });
  await hook({ event: "user_picked_up_at", room_name: callId, timestamp: iso(t, 2 + (i % 5)) });
  await tool("save_enquiry_progress", callId, facts);
  const ev = await tool("evaluate_qualification", callId, {});
  if (ev.body.status === "qualified" && i % 4 !== 3) {
    const slots = await tool("get_available_slots", callId, {});
    if (slots.body.status === "slots_available") {
      const r = await tool("book_consultation", callId, { slot_option: 1, customer_confirmed: true, customer_confirmation_quote: "Yes, please book that.", invitee_email: `sample.${fx.id.toLowerCase()}@example.invalid`, invitee_name: String(facts.caller_name ?? `Sample ${fx.id}`) });
      if (r.body.status === "booked") bookedCount++;
    }
  }
  await hook({ event: "call_ended", room_name: callId, timestamp: iso(t, 240), call_duration: 240, end_reason: "USER_DISCONNECTED" });
  await hook({ event: "call_postprocessing", call_id: callId, timestamp: iso(t, 300), data: { room_name: callId, call_id: callId, call_duration: 240_000, end_reason: "Call ended", transcript: transcriptFor(facts) } });
}

// Extra scenarios: a missed late-night call (T08), and a drop + redial (T17).
const night = new Date(); night.setUTCDate(night.getUTCDate() - 3); night.setUTCHours(17, 17, 0, 0);
await hook({ event: "call_started", room_name: "seed-T08", phone_number: "+919900009001", timestamp: iso(night) });
await hook({ event: "call_ended", room_name: "seed-T08", timestamp: iso(night, 3), call_duration: 3, end_reason: "NO_ANSWER" });

const drop = new Date(); drop.setUTCDate(drop.getUTCDate() - 2); drop.setUTCHours(8, 44, 0, 0);
await hook({ event: "call_started", room_name: "seed-T17a", phone_number: "+919900009002", timestamp: iso(drop) });
await hook({ event: "user_picked_up_at", room_name: "seed-T17a", timestamp: iso(drop, 2) });
await hook({ event: "call_ended", room_name: "seed-T17a", timestamp: iso(drop, 72), call_duration: 72, end_reason: "USER_DISCONNECTED" });

await processOutbox(db, 50, 20);

// ---- relabel and re-time so the sample data looks like it happened on the call dates ----
const tables = ["contacts", "enquiries", "calls", "escalations", "offered_slots", "booking_attempts", "bookings", "notifications", "hubspot_syncs", "integration_events", "tool_invocations", "usage_records"];
for (const t of tables) await db.execute(sql.raw(`update ${t} set mode = 'seed' where mode = 'mock'`));
await db.execute(sql`update enquiries e set created_at = c.received_at, updated_at = c.received_at from calls c where c.enquiry_id = e.id and e.mode = 'seed'`);
await db.execute(sql`update escalations x set created_at = c.received_at + interval '4 minutes' from calls c where x.call_id = c.id and x.mode = 'seed'`);
await db.execute(sql`update booking_attempts a set created_at = c.received_at + interval '3 minutes' from calls c where a.call_id = c.id and a.mode = 'seed'`);
await db.execute(sql`update bookings b set created_at = a.created_at from booking_attempts a where b.attempt_id = a.id and b.mode = 'seed'`);
await db.execute(sql`update usage_records u set occurred_at = c.received_at + interval '5 minutes' from calls c where u.call_id = c.id and u.mode = 'seed'`);
await db.execute(sql`update notifications n set created_at = c.received_at + interval '5 minutes', sent_at = c.received_at + interval '5 minutes' from calls c where n.call_id = c.id and n.mode = 'seed'`);

const countRes = (await db.execute(sql`select count(*)::int as n from calls where mode = 'seed'`)) as unknown as { rows: Array<{ n: number }> };
const callCount = countRes.rows[0]?.n ?? 0;
console.log(`Seeded ${callCount} sample calls (${bookedCount} simulated bookings). All rows are labelled mode='seed'.`);
await closeDb();
