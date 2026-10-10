import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { calls, fixedCosts, usageRecords } from "@/lib/db/schema";
import { getOverview, listEnquiries, resolveRange, SCOPE_MODES } from "@/lib/services/analytics";
import { setCostSettings } from "@/lib/services/settings";
import { recordUsage } from "@/lib/services/usage";
import { QUALIFYING_FACTS, makeHarness, type Harness } from "./helpers/harness";

let h: Harness;
beforeEach(async () => {
  h = await makeHarness();
});
afterEach(async () => {
  await h.close();
});

const now = new Date();
const iso = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();
const range = () => resolveRange({ range: "7d" });

async function call(id: string, opts: { afterSec?: number | null; ended?: boolean; facts?: Record<string, unknown>; book?: boolean; at?: number }) {
  const t = opts.at ?? -3_600_000;
  await h.webhook({ event: "call_started", room_name: id, phone_number: `+9199${String(Math.abs(hash(id))).slice(0, 8).padEnd(8, "0")}`, timestamp: iso(t) });
  if (opts.afterSec !== null && opts.afterSec !== undefined) await h.webhook({ event: "user_picked_up_at", room_name: id, timestamp: iso(t + opts.afterSec * 1000) });
  if (opts.facts) await h.tool("evaluate_qualification", opts.facts, id);
  if (opts.book) {
    await h.tool("get_available_slots", {}, id);
    await h.tool("book_consultation", { slot_option: 1, customer_confirmed: true, customer_confirmation_quote: "yes", invitee_email: `${id}@example.com` }, id);
  }
  if (opts.ended !== false) await h.webhook({ event: "call_ended", room_name: id, timestamp: iso(t + 120_000), call_duration: opts.afterSec === null || opts.afterSec === undefined ? 3 : 120 });
}
function hash(s: string) {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) | 0;
  return x;
}

describe("dashboard analytics are computed from persisted records only", () => {
  it("counts calls, answered, missed, after-hours and builds the funnel and rejection reasons", async () => {
    await call("a1", { afterSec: 2, facts: QUALIFYING_FACTS, book: true });
    await call("a2", { afterSec: 4, facts: QUALIFYING_FACTS }); // qualified, not booked
    await call("a3", { afterSec: 3, facts: { ...QUALIFYING_FACTS, location_text: "Nashik" } }); // declined: out of area
    await call("a4", { afterSec: 3, facts: { ...QUALIFYING_FACTS, service_intent: "styling_only" } }); // declined: advice
    await call("a5", { afterSec: null }); // missed
    await call("a6", { afterSec: 2 }); // answered, abandoned before evaluation
    const o = await getOverview(h.db, range(), "all");

    expect(o.calls.total).toBe(6);
    expect(o.calls.answered).toBe(5);
    expect(o.calls.missed).toBe(1);
    expect(o.outcomes).toMatchObject({ qualified: 2, rejected: 2, clarification: 2 });
    expect(o.bookings.confirmed).toBe(1);
    expect(o.funnel.map((f) => f.count)).toEqual([6, 5, 4, 2, 1]);
    expect(o.rejectionReasons.map((r) => r.code).sort()).toEqual(["advice_only", "out_of_area"]);

    // Response-time: 5 answered within seconds, 1 never answered -> 5/6 within five minutes.
    expect(o.response.buckets.find((b) => b.label === "under 10 s")!.count).toBe(5);
    expect(o.response.buckets.find((b) => b.label === "not answered")!.count).toBe(1);
    expect(Math.round(o.response.withinTargetPct!)).toBe(83);
  });

  it("separates simulated from live data and reports nothing for an empty scope", async () => {
    await call("s1", { afterSec: 2, facts: QUALIFYING_FACTS });
    const live = await getOverview(h.db, range(), "live");
    const sim = await getOverview(h.db, range(), "simulated");
    expect(live.calls.total).toBe(0);
    expect(live.response.withinTargetPct).toBeNull(); // no data -> no invented percentage
    expect(live.cost.perCallInr).toBeNull();
    expect(sim.calls.total).toBe(1);
    expect(sim.composition).toMatchObject({ mock: 1, live: 0, seed: 0 });
    expect(SCOPE_MODES.live).toEqual(["live"]);
  });

  it("an after-hours call is counted from the timestamp, not assumed", async () => {
    const night = new Date();
    night.setUTCHours(17, 17, 0, 0); // 22:47 IST
    if (night > new Date()) night.setUTCDate(night.getUTCDate() - 1);
    await h.webhook({ event: "call_started", room_name: "n1", phone_number: "+919833300001", timestamp: night.toISOString() });
    await h.webhook({ event: "user_picked_up_at", room_name: "n1", timestamp: new Date(night.getTime() + 2000).toISOString() });
    const day = new Date(night);
    day.setUTCHours(6, 0, 0, 0); // 11:30 IST
    await h.webhook({ event: "call_started", room_name: "d1", phone_number: "+919833300002", timestamp: day.toISOString() });
    const o = await getOverview(h.db, range(), "all");
    expect(o.calls.afterHours).toBe(1);
    expect(o.calls.afterHoursPct).toBe(50);
  });

  it("costs: nothing is invented without a rate; measured and configured figures stay separate", async () => {
    await call("c1", { afterSec: 2, facts: QUALIFYING_FACTS, book: true });
    await call("c2", { afterSec: 2, facts: { ...QUALIFYING_FACTS, location_text: "Nashik" } });
    let o = await getOverview(h.db, range(), "all");
    expect(o.cost.totalKnownInr).toBeNull();
    expect(o.cost.perCallInr).toBeNull();

    const [c] = await h.db.select().from(calls).limit(1);
    // Vaani reports 5 credits for one call; with no credit->INR rate it is recorded but unpriced.
    await recordUsage(h.db, { dedupeKey: "t:credits", provider: "vaani", metric: "credits", quantity: 5, unit: "credits", costInr: null, costBasis: "unknown", callId: c!.id, mode: "mock" });
    o = await getOverview(h.db, range(), "all");
    expect(o.cost.totalKnownInr).toBeNull();
    expect(o.cost.unpricedUsage.some((u) => u.provider === "vaani" && u.metric === "credits")).toBe(true);

    // Once management supplies a rate, measured cost appears and per-call / per-qualified costs are derived from it.
    await h.db.delete(usageRecords).where(sql`dedupe_key = 't:credits'`);
    await recordUsage(h.db, { dedupeKey: "t:credits2", provider: "vaani", metric: "credits", quantity: 5, unit: "credits", costInr: 10, costBasis: "measured", callId: c!.id, mode: "mock" });
    await h.db.insert(fixedCosts).values({ provider: "calendly", label: "Seat", monthlyInr: "3000", activeFrom: range().fromIso });
    o = await getOverview(h.db, range(), "all");
    expect(o.cost.measuredInr).toBe(10);
    expect(o.cost.fixedConfiguredInr).toBeGreaterThan(0); // prorated, labelled configured
    expect(o.cost.totalKnownInr).toBeCloseTo(10 + o.cost.fixedConfiguredInr!, 4);
    expect(o.cost.perCallInr).toBeCloseTo(o.cost.totalKnownInr! / 2, 4);
    expect(o.cost.perQualifiedInr).toBeCloseTo(o.cost.totalKnownInr! / 1, 4);
    await setCostSettings(h.db, { vaaniCreditInr: 2, geminiInputInrPerMillion: null, geminiOutputInrPerMillion: null }, "test");
  });

  it("the enquiry list filters by outcome, searches by name/location/phone and paginates", async () => {
    await call("l1", { afterSec: 2, facts: QUALIFYING_FACTS });
    await call("l2", { afterSec: 2, facts: { ...QUALIFYING_FACTS, caller_name: "Rajesh Test", location_text: "Nashik" } });
    const all = await listEnquiries(h.db, { scope: "all", range: range() });
    expect(all.total).toBe(2);
    expect((await listEnquiries(h.db, { scope: "all", range: range(), disposition: "rejected" })).rows).toHaveLength(1);
    expect((await listEnquiries(h.db, { scope: "all", range: range(), q: "Nashik" })).rows[0]!.location).toBe("Nashik");
    expect((await listEnquiries(h.db, { scope: "all", range: range(), q: "Priya" })).total).toBe(1);
    // Wildcards in the search box are neutralised.
    expect((await listEnquiries(h.db, { scope: "all", range: range(), q: "%" })).total).toBe(2);
  });

  it("range presets resolve in India time and cap hand-edited ranges", () => {
    const r = resolveRange({ from: "2026-01-01", to: "2026-12-31" });
    expect(r.preset).toBe("custom");
    const huge = resolveRange({ from: "1990-01-01", to: "2026-10-01" });
    expect(Date.parse(`${huge.toIso}T00:00:00Z`) - Date.parse(`${huge.fromIso}T00:00:00Z`)).toBeLessThanOrEqual(366 * 86_400_000);
    expect(resolveRange({ range: "garbage" }).preset).toBe("30d");
  });
});
