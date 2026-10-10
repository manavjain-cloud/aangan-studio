import { describe, expect, it } from "vitest";
import { LiveCalendlyClient } from "@/lib/integrations/calendly/live";
import { CalendlyError } from "@/lib/integrations/calendly/types";
import { LiveHubspotClient } from "@/lib/integrations/hubspot/live";
import { CUSTOM_PROPERTY_DEFS, FIELD_MAP, HubspotError } from "@/lib/integrations/hubspot/types";
import { LiveResendClient } from "@/lib/integrations/email/live";
import { EmailError } from "@/lib/integrations/email/types";
import { LiveVaaniClient } from "@/lib/integrations/vaani/live";
import { LiveGeminiClient } from "@/lib/integrations/gemini/live";
import { GeminiInvalidOutputError, GeminiUnavailableError, geminiAnalysisSchema } from "@/lib/integrations/gemini/types";
import { httpJson, HttpError, NetworkError } from "@/lib/integrations/http";
import { setTestEnv } from "./helpers/harness";
import { z } from "zod";

type Call = { url: string; method: string; headers: Record<string, string>; body: unknown };
type Responder = (call: Call) => Response | Promise<Response> | "throw-abort";

function fakeFetch(responder: Responder) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}).map(([k, v]) => [k.toLowerCase(), v])),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = await responder(call);
    if (r === "throw-abort") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return r;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("http helper", () => {
  it("retries 429/5xx with backoff for retryable calls and honours Retry-After", async () => {
    let n = 0;
    const f = fakeFetch(() => (++n < 3 ? json({ e: 1 }, n === 1 ? 429 : 503, n === 1 ? { "retry-after": "0" } : {}) : json({ ok: true })));
    const r = await httpJson({ integration: "x", url: "https://example.test/a", retries: 3, retryBaseMs: 1, fetchImpl: f.impl });
    expect(r.data).toEqual({ ok: true });
    expect(f.calls).toHaveLength(3);
  });

  it("does not retry when retries=0, and surfaces a typed error", async () => {
    const f = fakeFetch(() => json({ message: "nope" }, 500));
    await expect(httpJson({ integration: "x", url: "https://example.test/a", fetchImpl: f.impl })).rejects.toBeInstanceOf(HttpError);
    expect(f.calls).toHaveLength(1);
  });

  it("maps an aborted request to a timeout NetworkError", async () => {
    const f = fakeFetch(() => "throw-abort");
    const err = await httpJson({ integration: "x", url: "https://example.test/a", fetchImpl: f.impl }).catch((e) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timedOut).toBe(true);
  });

  it("redacts secrets that appear in error bodies", async () => {
    const f = fakeFetch(() => new Response("bad token Bearer abcdefghijklmnop1234", { status: 401 }));
    const err = await httpJson({ integration: "x", url: "https://example.test/a", fetchImpl: f.impl }).catch((e) => e);
    expect(String((err as HttpError).body)).not.toContain("abcdefghijklmnop1234");
  });
});

describe("Calendly live client (official Scheduling API contract)", () => {
  const ET = "https://api.calendly.com/event_types/AAA";
  const booking = { resource: { uri: "https://api.calendly.com/invitees/INV1", email: "p@example.com", status: "active", timezone: "Asia/Kolkata", event: "https://api.calendly.com/scheduled_events/EV1", cancel_url: "https://calendly.com/cancel/x", reschedule_url: "https://calendly.com/reschedule/x" } };
  const eventRes = { resource: { start_time: "2026-10-20T10:30:00.000000Z", end_time: "2026-10-20T11:15:00.000000Z", event_memberships: [{ user_name: "Asha Designer", user_email: "asha@aangan.test" }] } };

  it("lists available times with the documented query and filters to status=available", async () => {
    const f = fakeFetch(() => json({ collection: [
      { status: "available", start_time: "2026-10-20T10:30:00Z", invitees_remaining: 1, scheduling_url: "https://calendly.com/x" },
      { status: "unavailable", start_time: "2026-10-20T11:30:00Z", invitees_remaining: 0, scheduling_url: "https://calendly.com/x" },
    ] }));
    const c = new LiveCalendlyClient("tok", f.impl);
    const start = new Date(Date.now() + 86_400_000);
    const slots = await c.listAvailableTimes({ eventTypeUri: ET, start, end: new Date(start.getTime() + 5 * 86_400_000) });
    expect(slots).toHaveLength(1);
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe("/event_type_available_times");
    expect(u.searchParams.get("event_type")).toBe(ET);
    expect(f.calls[0]!.headers.authorization).toBe("Bearer tok");
  });

  it("never asks for a range over 31 days or a start time in the past", async () => {
    const f = fakeFetch(() => json({ collection: [] }));
    const c = new LiveCalendlyClient("tok", f.impl);
    await c.listAvailableTimes({ eventTypeUri: ET, start: new Date(Date.now() - 86_400_000), end: new Date(Date.now() + 90 * 86_400_000) });
    const u = new URL(f.calls[0]!.url);
    const s = Date.parse(u.searchParams.get("start_time")!);
    const e = Date.parse(u.searchParams.get("end_time")!);
    expect(s).toBeGreaterThan(Date.now());
    expect(e - s).toBeLessThan(31 * 86_400_000);
  });

  it("creates the booking through POST /invitees with event_type, UTC start_time and invitee (incl. timezone)", async () => {
    const f = fakeFetch((call) => (call.url.endsWith("/invitees") ? json(booking, 201) : json(eventRes)));
    const c = new LiveCalendlyClient("tok", f.impl);
    const b = await c.createInvitee({ eventTypeUri: ET, startTime: "2026-10-20T10:30:00Z", invitee: { name: "Priya T", email: "p@example.com", timezone: "Asia/Kolkata" } });
    const post = f.calls.find((x) => x.method === "POST")!;
    expect(post.url).toBe("https://api.calendly.com/invitees");
    expect(post.body).toMatchObject({ event_type: ET, start_time: "2026-10-20T10:30:00Z", invitee: { name: "Priya T", email: "p@example.com", timezone: "Asia/Kolkata" } });
    expect(b.eventUri).toBe("https://api.calendly.com/scheduled_events/EV1");
    expect(b.hostName).toBe("Asha Designer");
    expect(b.cancelUrl).toContain("cancel");
  });

  it("403 (free plan / missing scope) -> forbidden, with an explanatory message", async () => {
    const f = fakeFetch(() => json({ title: "Permission Denied" }, 403));
    const err = await new LiveCalendlyClient("tok", f.impl).createInvitee({ eventTypeUri: ET, startTime: "2026-10-20T10:30:00Z", invitee: { name: "A", email: "a@b.co", timezone: "Asia/Kolkata" } }).catch((e) => e);
    expect(err).toBeInstanceOf(CalendlyError);
    expect(err.code).toBe("forbidden");
    expect(err.message).toMatch(/paid plan/);
  });

  it("slot already taken -> slot_unavailable", async () => {
    const f = fakeFetch(() => json({ title: "Invalid Argument", message: "The time is no longer available" }, 400));
    const err = await new LiveCalendlyClient("tok", f.impl).createInvitee({ eventTypeUri: ET, startTime: "2026-10-20T10:30:00Z", invitee: { name: "A", email: "a@b.co", timezone: "Asia/Kolkata" } }).catch((e) => e);
    expect(err.code).toBe("slot_unavailable");
  });

  it("timeout and 5xx are 'outcome unknown' and are sent exactly ONCE (no blind retry of a booking)", async () => {
    for (const responder of ["throw-abort", json({}, 502)] as const) {
      const f = fakeFetch(() => responder as never);
      const err = await new LiveCalendlyClient("tok", f.impl).createInvitee({ eventTypeUri: ET, startTime: "2026-10-20T10:30:00Z", invitee: { name: "A", email: "a@b.co", timezone: "Asia/Kolkata" } }).catch((e) => e);
      expect((err as CalendlyError).outcomeUnknown).toBe(true);
      expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
    }
  });

  it("looks up an existing event by invitee email within the organisation (used to resolve unknown outcomes)", async () => {
    const f = fakeFetch((call) =>
      call.url.includes("/users/me") ? json({ resource: { name: "N", current_organization: "https://api.calendly.com/organizations/ORG" } })
      : json({ collection: [{ uri: "https://api.calendly.com/scheduled_events/EV9", start_time: "2026-10-20T10:30:00Z", end_time: "2026-10-20T11:15:00Z", status: "active" }] }),
    );
    const found = await new LiveCalendlyClient("tok", f.impl).findScheduledEvent({ inviteeEmail: "p@example.com", startTime: "2026-10-20T10:30:00Z" });
    expect(found?.eventUri).toContain("EV9");
    const u = new URL(f.calls.find((c) => c.url.includes("/scheduled_events"))!.url);
    expect(u.searchParams.get("invitee_email")).toBe("p@example.com");
    expect(u.searchParams.get("organization")).toContain("ORG");
  });
});

describe("HubSpot live client", () => {
  it("creates a contact when none matches, searching by email then phone first (no duplicates)", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/search") ? json({ results: [] }) : json({ id: "101" }, 201)));
    const r = await new LiveHubspotClient("pat", f.impl).upsertContact({ email: "p@example.com", phone: "+919800000001", name: "Priya Test", properties: { [FIELD_MAP.disposition]: "qualified" } });
    expect(r).toEqual({ id: "101", created: true, matchedBy: null });
    expect(f.calls.filter((c) => c.url.endsWith("/search"))).toHaveLength(2);
    const create = f.calls.find((c) => c.method === "POST" && !c.url.endsWith("/search"))!;
    expect(create.body).toMatchObject({ properties: { email: "p@example.com", firstname: "Priya", lastname: "Test", aangan_disposition: "qualified" } });
    expect(f.calls[0]!.headers.authorization).toBe("Bearer pat");
  });

  it("an existing contact is updated WITHOUT overwriting its name/phone; only blanks are filled", async () => {
    const f = fakeFetch((c) => (c.url.endsWith("/search") ? json({ results: [{ id: "7", properties: { firstname: "Existing", lastname: "Name", email: null, phone: "+919800000001", mobilephone: null } }] }) : json({ id: "7" })));
    const r = await new LiveHubspotClient("pat", f.impl).upsertContact({ email: null, phone: "+919800000001", name: "Different Person", properties: { [FIELD_MAP.score]: 90 } });
    expect(r).toMatchObject({ id: "7", created: false, matchedBy: "phone" });
    const patch = f.calls.find((c) => c.method === "PATCH")!;
    const props = (patch.body as { properties: Record<string, unknown> }).properties;
    expect(props.firstname).toBeUndefined();
    expect(props.lastname).toBeUndefined();
    expect(props.phone).toBeUndefined();
    expect(props[FIELD_MAP.score]).toBe(90);
  });

  it("a 409 on create (race / retry) resolves to the existing contact instead of failing or duplicating", async () => {
    let searches = 0;
    const f = fakeFetch((c) => {
      if (c.url.endsWith("/search")) return json({ results: ++searches > 1 ? [{ id: "55", properties: { email: "p@example.com" } }] : [] });
      if (c.method === "POST") return json({ message: "Contact already exists" }, 409);
      return json({ id: "55" });
    });
    const r = await new LiveHubspotClient("pat", f.impl).upsertContact({ email: "p@example.com", phone: null, name: "P", properties: {} });
    expect(r).toMatchObject({ id: "55", created: false });
  });

  it("ensureProperties checks existing definitions and only creates the missing ones", async () => {
    const existing = CUSTOM_PROPERTY_DEFS.slice(0, 5).map((d) => ({ name: d.name }));
    const f = fakeFetch((c) => (c.method === "GET" ? json({ results: existing }) : json({}, 201)));
    const r = await new LiveHubspotClient("pat", f.impl).ensureProperties(CUSTOM_PROPERTY_DEFS);
    expect(r.existing).toHaveLength(5);
    expect(r.created).toHaveLength(CUSTOM_PROPERTY_DEFS.length - 5);
    const created = f.calls.filter((c) => c.method === "POST" && c.url.endsWith("/properties/contacts"));
    expect(created).toHaveLength(CUSTOM_PROPERTY_DEFS.length - 5);
  });

  it("writes a note and associates it with the contact via the default v4 association", async () => {
    const f = fakeFetch((c) => (c.method === "POST" ? json({ id: "n1" }, 201) : json({})));
    const r = await new LiveHubspotClient("pat", f.impl).upsertNote({ contactId: "7", body: "hello", timestamp: new Date() });
    expect(r.id).toBe("n1");
    expect(f.calls.some((c) => c.method === "PUT" && c.url.endsWith("/crm/v4/objects/notes/n1/associations/default/contacts/7"))).toBe(true);
  });

  it("an existing note is updated rather than duplicated", async () => {
    const f = fakeFetch(() => json({ id: "n1" }));
    await new LiveHubspotClient("pat", f.impl).upsertNote({ contactId: "7", existingNoteId: "n1", body: "v2", timestamp: new Date() });
    expect(f.calls.every((c) => c.method === "PATCH")).toBe(true);
  });

  it("maps auth failures", async () => {
    const f = fakeFetch(() => json({ message: "expired" }, 401));
    const err = await new LiveHubspotClient("bad", f.impl).upsertContact({ email: "a@b.co", phone: null, name: null, properties: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(HubspotError);
    expect(err.code).toBe("unauthorized");
  });
});

describe("Resend (email) live client", () => {
  const msg = { to: "d@aangan.test", subject: "S", html: "<p>h</p>", text: "t", idempotencyKey: "handoff:abc:d@aangan.test" };

  it("sends with Bearer auth and the Idempotency-Key header", async () => {
    const f = fakeFetch(() => json({ id: "em_1" }));
    const r = await new LiveResendClient("re_key", "Aangan <desk@aangan.test>", f.impl).send(msg);
    expect(r.id).toBe("em_1");
    expect(f.calls[0]!.headers["idempotency-key"]).toBe(msg.idempotencyKey);
    expect(f.calls[0]!.headers.authorization).toBe("Bearer re_key");
    expect(f.calls[0]!.body).toMatchObject({ from: "Aangan <desk@aangan.test>", to: ["d@aangan.test"], subject: "S" });
  });

  it("retries a rate-limit then succeeds; a 422 is a non-retryable invalid_request", async () => {
    let n = 0;
    const f = fakeFetch(() => (++n === 1 ? json({}, 429, { "retry-after": "0" }) : json({ id: "em_2" })));
    expect((await new LiveResendClient("k", "a@b.co", f.impl).send(msg)).id).toBe("em_2");
    const bad = fakeFetch(() => json({ message: "invalid to" }, 422));
    const err = await new LiveResendClient("k", "a@b.co", bad.impl).send(msg).catch((e) => e);
    expect(err).toBeInstanceOf(EmailError);
    expect(err.code).toBe("invalid_request");
    expect(err.retryable).toBe(false);
  });
});

describe("Vaani live client", () => {
  it("authenticates with X-API-Key and maps call history incl. cost credits", async () => {
    const f = fakeFetch(() => json({ data: [{ call_id: "c1", call_type: "Inbound", direction: "Incoming", call_status: "completed", agent_id: "a", from_number: "+919800000001", to_number: "+911234", Start_time: "2026-10-12T05:00:00", End_time: "2026-10-12T05:03:00", duration_ms: 180000, call_cost: 4.2, call_summary: "s", post_processing_status: "completed" }], pagination: { has_next: false } }));
    const r = await new LiveVaaniClient("vaani_k", "https://api.vaanivoice.ai", f.impl).getCallHistory({ page: 1, pageSize: 50 });
    expect(f.calls[0]!.headers["x-api-key"]).toBe("vaani_k");
    expect(r.records[0]).toMatchObject({ callId: "c1", costCredits: 4.2, durationMs: 180000, direction: "Incoming" });
  });

  it("reports 'not ready' while Vaani has not post-processed the call", async () => {
    const f = fakeFetch(() => json({ transcription: "Transcript is not available for further evaluations.", entity: "x", summary: "x", conversation_eval: "x", call_eval_tag: null }));
    const d = await new LiveVaaniClient("k", "https://api.vaanivoice.ai", f.impl).getCallDetails("c1");
    expect(d.ready).toBe(false);
    expect(d.transcript).toBeNull();
  });
});

describe("Gemini live client (SDK stubbed)", () => {
  const good = { facts: Object.fromEntries(Object.keys(geminiAnalysisSchema.shape.facts.shape).map((k) => [k, null])), summary: "ok", handoff_note: "note", customer_confirmed_slot: null, agent_stated_price: false };
  const input = { transcript: "AGENT: hi\nUSER: hello", currentFacts: {} as never, now: new Date("2026-10-12T05:00:00Z"), timezone: "Asia/Kolkata" };

  function client(generate: (args: { model: string }) => Promise<unknown>) {
    setTestEnv({ GEMINI_MODEL: "model-a", GEMINI_MODEL_FALLBACKS: "model-b" });
    const c = new LiveGeminiClient("key");
    (c as unknown as { ai: unknown }).ai = { models: { generateContent: generate } };
    return c;
  }

  it("requests schema-constrained JSON at temperature 0 and validates the answer", async () => {
    let seen: Record<string, unknown> = {};
    const c = client(async (a) => {
      seen = a as never;
      return { text: JSON.stringify(good), usageMetadata: { promptTokenCount: 120, candidatesTokenCount: 30 } };
    });
    const r = await c.analyzeTranscript(input);
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 30, model: "model-a" });
    const cfg = (seen as { config: Record<string, unknown> }).config;
    expect(cfg.responseMimeType).toBe("application/json");
    expect(cfg.temperature).toBe(0);
    expect(cfg.responseJsonSchema).toBeTruthy();
    expect(String(cfg.systemInstruction)).toMatch(/UNTRUSTED DATA/);
  });

  it("21. non-JSON or schema-violating output -> GeminiInvalidOutputError (never trusted)", async () => {
    await expect(client(async () => ({ text: "sure! here you go" })).analyzeTranscript(input)).rejects.toBeInstanceOf(GeminiInvalidOutputError);
    await expect(client(async () => ({ text: JSON.stringify({ ...good, summary: 5 }) })).analyzeTranscript(input)).rejects.toBeInstanceOf(GeminiInvalidOutputError);
    const withPrice = { ...good, facts: { ...good.facts, service_intent: "make_up_a_value" } };
    await expect(client(async () => ({ text: JSON.stringify(withPrice) })).analyzeTranscript(input)).rejects.toBeInstanceOf(GeminiInvalidOutputError);
  });

  it("falls over to the next model when one is overloaded, and reports unavailable when all fail", async () => {
    const used: string[] = [];
    const c = client(async (a) => {
      used.push(a.model);
      if (a.model === "model-a") throw new Error("503 UNAVAILABLE overloaded");
      return { text: JSON.stringify(good), usageMetadata: {} };
    });
    expect((await c.analyzeTranscript(input)).usage.model).toBe("model-b");
    expect(used).toEqual(["model-a", "model-b"]);
    const dead = client(async () => {
      throw new Error("503 UNAVAILABLE");
    });
    await expect(dead.analyzeTranscript(input)).rejects.toBeInstanceOf(GeminiUnavailableError);
  });

  it("the response JSON schema can be generated and has no numeric price/cost/rate fields for the model to fill", () => {
    const js = z.toJSONSchema(geminiAnalysisSchema, { target: "draft-7" }) as unknown as { properties: { facts: { properties: Record<string, { type?: unknown }> } } };
    const numeric = Object.entries(js.properties.facts.properties).filter(([, v]) => JSON.stringify(v).includes('"number"')).map(([k]) => k);
    expect(numeric.filter((k) => /price|cost|rate|quote/i.test(k))).toEqual([]);
    // The only budget figures the model may extract are what the caller volunteered.
    expect(numeric).toEqual(expect.arrayContaining(["budget_inr_min", "budget_inr_max"]));
  });
});

import { LiveCalcomClient, parseEventTypeId } from "@/lib/integrations/calcom/live";
import { calendarProvider, getEnv, integrationStatus } from "@/lib/env";
import { getCalendly } from "@/lib/integrations";

describe("Cal.com live client (free-plan alternative to Calendly)", () => {
  const ET = "calcom:4242";
  const booking = { status: "success", data: { uid: "bk_123", status: "accepted", start: "2026-10-20T10:30:00.000Z", end: "2026-10-20T11:15:00.000Z", hosts: [{ name: "Asha", email: "asha@aangan.test" }] } };

  it("parses event type references and rejects junk", () => {
    expect(parseEventTypeId("calcom:42")).toBe(42);
    expect(parseEventTypeId("42")).toBe(42);
    expect(() => parseEventTypeId("https://api.calendly.com/event_types/AAA")).toThrow();
  });

  it("lists slots with the documented query/headers and flattens per-day buckets to UTC instants", async () => {
    const f = fakeFetch(() => json({ status: "success", data: { "2026-10-20": [{ start: "2026-10-20T10:30:00.000+05:30" }], "2026-10-21": [{ start: "2026-10-21T04:30:00.000Z" }] } }));
    const start = new Date(Date.now() + 86_400_000);
    const slots = await new LiveCalcomClient("cal_live_x", f.impl).listAvailableTimes({ eventTypeUri: ET, start, end: new Date(start.getTime() + 5 * 86_400_000) });
    expect(slots.map((s) => s.startTime)).toEqual(["2026-10-20T05:00:00.000Z", "2026-10-21T04:30:00.000Z"]);
    const u = new URL(f.calls[0]!.url);
    expect(u.pathname).toBe("/v2/slots");
    expect(u.searchParams.get("eventTypeId")).toBe("4242");
    expect(f.calls[0]!.headers.authorization).toBe("Bearer cal_live_x");
    expect(f.calls[0]!.headers["cal-api-version"]).toBe("2024-09-04");
  });

  it("books through POST /v2/bookings with eventTypeId, UTC start and attendee (name, email, timeZone)", async () => {
    const f = fakeFetch(() => json(booking, 201));
    const b = await new LiveCalcomClient("k", f.impl).createInvitee({ eventTypeUri: ET, startTime: "2026-10-20T10:30:00Z", invitee: { name: "Priya T", email: "p@example.com", timezone: "Asia/Kolkata" } });
    const post = f.calls[0]!;
    expect(post.url).toBe("https://api.cal.com/v2/bookings");
    expect(post.headers["cal-api-version"]).toBe("2026-02-25");
    expect(post.body).toMatchObject({ eventTypeId: 4242, start: "2026-10-20T10:30:00.000Z", attendee: { name: "Priya T", email: "p@example.com", timeZone: "Asia/Kolkata" } });
    expect(b.eventUri).toBe("calcom:booking:bk_123");
    expect(b.hostName).toBe("Asha");
  });

  it("a booking that Cal.com leaves 'pending' (host confirmation required) is NOT reported as confirmed", async () => {
    const f = fakeFetch(() => json({ status: "success", data: { ...booking.data, status: "pending" } }, 201));
    const err = await new LiveCalcomClient("k", f.impl).createInvitee({ eventTypeUri: ET, startTime: "2026-10-20T10:30:00Z", invitee: { name: "A", email: "a@b.co", timezone: "Asia/Kolkata" } }).catch((e) => e);
    expect(err).toBeInstanceOf(CalendlyError);
    expect(err.code).toBe("invalid_request");
    expect(err.message).toMatch(/requires confirmation/);
  });

  it("maps taken slot / bad key / rate limit, and sends a booking exactly once on timeout or 5xx (outcome unknown)", async () => {
    const make = (r: Response | "throw-abort") => fakeFetch(() => r as never);
    const book = (f: ReturnType<typeof fakeFetch>) => new LiveCalcomClient("k", f.impl).createInvitee({ eventTypeUri: ET, startTime: "2026-10-20T10:30:00Z", invitee: { name: "A", email: "a@b.co", timezone: "Asia/Kolkata" } }).catch((e) => e);
    expect((await book(make(json({ error: { message: "User either already has booking at this time or is not available" } }, 400)))).code).toBe("slot_unavailable");
    expect((await book(make(json({}, 401)))).code).toBe("unauthorized");
    expect((await book(make(json({}, 429)))).code).toBe("rate_limited");
    for (const r of [json({}, 502), "throw-abort"] as const) {
      const f = make(r);
      const e = await book(f);
      expect((e as CalendlyError).outcomeUnknown).toBe(true);
      expect(f.calls).toHaveLength(1);
    }
  });

  it("finds an existing accepted booking by attendee email near the start time", async () => {
    const f = fakeFetch(() => json({ status: "success", data: [{ uid: "bk_9", status: "accepted", start: "2026-10-20T10:30:00.000Z", end: "2026-10-20T11:15:00.000Z" }] }));
    const found = await new LiveCalcomClient("k", f.impl).findScheduledEvent({ inviteeEmail: "p@example.com", startTime: "2026-10-20T10:30:00Z" });
    expect(found?.eventUri).toBe("calcom:booking:bk_9");
    expect(new URL(f.calls[0]!.url).searchParams.get("attendeeEmail")).toBe("p@example.com");
  });

  it("when the event type needs the caller's address, the site address is passed as an attendee location", async () => {
    const f = fakeFetch(() => json(booking, 201));
    await new LiveCalcomClient("k", f.impl).createInvitee({ eventTypeUri: ET, startTime: "2026-10-20T10:30:00Z", invitee: { name: "A", email: "a@b.co", timezone: "Asia/Kolkata" }, location: { kind: "ask_invitee", location: "Kothrud, Pune" } });
    expect((f.calls[0]!.body as { location: unknown }).location).toEqual({ type: "attendeeAddress", address: "Kothrud, Pune" });
  });

  it("provider selection: Cal.com when only its key is set; explicit CALENDAR_PROVIDER wins; status asks for the right variable", () => {
    setTestEnv({ FORCE_MOCK_INTEGRATIONS: undefined, NODE_ENV: "development", CALCOM_API_KEY: "cal_live_x", CALENDLY_ACCESS_TOKEN: undefined, CALENDAR_PROVIDER: undefined });
    expect(calendarProvider(getEnv())).toBe("calcom");
    expect(integrationStatus("calendly").mode).toBe("live");
    expect(getCalendly()).toBeInstanceOf(LiveCalcomClient);
    setTestEnv({ FORCE_MOCK_INTEGRATIONS: undefined, NODE_ENV: "development", CALCOM_API_KEY: undefined, CALENDLY_ACCESS_TOKEN: undefined, CALENDAR_PROVIDER: "calcom" });
    expect(integrationStatus("calendly").missing).toEqual(["CALCOM_API_KEY"]);
    setTestEnv({ NODE_ENV: "test", FORCE_MOCK_INTEGRATIONS: "1", CALCOM_API_KEY: undefined, CALENDAR_PROVIDER: undefined });
  });
});
