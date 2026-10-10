export {};
/**
 * Drives a scripted phone call against a RUNNING app over real HTTP: the same webhook and tool endpoints
 * that Vaani uses, with the same authentication. Use it to demonstrate the full request/response flow in mock
 * mode, and to smoke-test a live deployment once credentials are configured.
 *
 *   npm run dev                                   (terminal 1)
 *   npm run simulate:call -- qualified            (terminal 2)   scenarios: qualified | rejected | complaint | pricing | dropped
 *   APP_URL=https://your-app.vercel.app npm run simulate:call -- qualified
 *
 * Note: this exercises OUR side only. It does not prove Vaani can reach the endpoint; do a real test call for that.
 */
const scenario = process.argv[2] ?? "qualified";
const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const toolKey = process.env.VOICE_TOOL_SECRET;
const hookToken = process.env.VAANI_WEBHOOK_TOKEN;
if (!toolKey) {
  console.error("VOICE_TOOL_SECRET must be set (it is read from .env.local).");
  process.exit(1);
}

const callId = `sim-${Date.now().toString(36)}`;
const phone = `+9199${String(Math.floor(Math.random() * 1e8)).padStart(8, "0")}`;
const nowIso = () => new Date().toISOString();

async function webhook(payload: Record<string, unknown>) {
  const r = await fetch(`${base}/api/voice/webhooks/vaani${hookToken ? `?token=${encodeURIComponent(hookToken)}` : ""}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timestamp: nowIso(), ...payload }),
  });
  console.log(`  webhook ${String(payload.event).padEnd(20)} -> HTTP ${r.status}`);
}

async function tool(action: string, args: Record<string, unknown> = {}) {
  const r = await fetch(`${base}/api/voice/tools/aangan-workflow-action`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Aangan-Tool-Key": toolKey! },
    body: JSON.stringify({ action, call_id: callId, caller_phone: phone, args }),
  });
  const body = (await r.json()) as { ok: boolean; status: string; say?: string; instruction?: string; data?: Record<string, unknown> };
  console.log(`\n  TOOL ${action}  -> HTTP ${r.status}  ok=${body.ok}  status=${body.status}`);
  if (body.say) console.log(`    agent says : "${body.say}"`);
  if (body.data) console.log(`    data       : ${JSON.stringify(body.data).slice(0, 300)}`);
  return body;
}

const QUALIFYING = {
  caller_name: "Simulated Caller", service_intent: "design_and_execution", project_type: "residential", property_kind: "apartment",
  scope: "full_home", bhk: 3, carpet_area_sqft: 1400, location_text: "Kothrud", timeline_flexible: true, authority: "authorised_representative",
};

console.log(`Scenario "${scenario}" against ${base}  (call ${callId})\n`);
await webhook({ event: "call_started", room_name: callId, phone_number: phone });
await webhook({ event: "user_picked_up_at", room_name: callId });
const ctx = await tool("get_call_context");
void ctx;

if (scenario === "qualified" || scenario === "pricing") {
  await tool("save_enquiry_progress", { ...QUALIFYING, ...(scenario === "pricing" ? { asked_about_pricing: true } : {}) });
  const ev = await tool("evaluate_qualification");
  if (ev.status === "qualified") {
    const slots = await tool("get_available_slots", { time_of_day: "afternoon" });
    if (slots.status === "slots_available") {
      await tool("book_consultation", { slot_option: 1, customer_confirmed: true, customer_confirmation_quote: "Yes, please book that one.", invitee_email: process.env.SIM_EMAIL ?? "simulated.caller@example.invalid", invitee_name: "Simulated Caller" });
    }
  }
} else if (scenario === "rejected") {
  await tool("evaluate_qualification", { ...QUALIFYING, location_text: "Nashik" });
  await tool("get_available_slots");
} else if (scenario === "complaint") {
  await tool("escalate_to_human", { reason: "complaint", details: "My designer hasn't replied in five days", caller_name: "Simulated Customer" });
} else if (scenario === "dropped") {
  await tool("save_enquiry_progress", { caller_name: "Dropped Caller", location_text: "Pimple Saudagar", bhk: 3 });
} else {
  console.error(`Unknown scenario "${scenario}"`);
  process.exit(1);
}

await webhook({ event: "call_ended", room_name: callId, call_duration: scenario === "dropped" ? 60 : 210, end_reason: "USER_DISCONNECTED" });
if (scenario !== "dropped") {
  await webhook({
    event: "call_postprocessing", call_id: callId,
    data: { room_name: callId, call_id: callId, call_duration: 210_000, end_reason: "Call ended", transcript: "[10:00:01] AGENT: Hello, Aangan Studio.\n\n[10:00:05] USER: (simulated call)" },
  });
}
console.log("\nDone. Open the dashboard (/dashboard) and look for the simulated call - it is labelled as simulated data in mock mode.");
