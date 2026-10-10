import { afterEach, beforeEach, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { hmacSha256Hex, safeEqual, verifyVaaniSignature } from "@/lib/security/hmac";
import { authenticateToolRequest } from "@/lib/security/tool-auth";
import { authenticateWebhook } from "@/lib/security/webhook-auth";
import { hashPassword, validatePasswordStrength, verifyPassword } from "@/lib/security/password";
import { createSessionToken, verifySessionToken } from "@/lib/security/session";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { maskEmail, maskPhone, redact, redactString } from "@/lib/logging/redact";
import { allIntegrationStatuses, integrationStatus, IntegrationNotConfiguredError } from "@/lib/env";
import { getCalendly } from "@/lib/integrations";
import { loadKnowledge, resetKnowledgeCache } from "@/lib/knowledge";
import { APPROVED_PRICING_RESPONSE, auditAgentPriceDisclosure, containsPriceDisclosure, parseTranscript } from "@/lib/domain/pricing-guard";
import { QUALIFYING_FACTS, makeHarness, setTestEnv, type Harness } from "./helpers/harness";
import { escalations } from "@/lib/db/schema";

const NOW_SEC = 1_790_000_000;

describe("webhook signature (Vaani documented scheme)", () => {
  const body = JSON.stringify({ event: "call_started" });
  const sign = (secret: string, ts: number) => `sha256=${hmacSha256Hex(secret, `${ts}.${body}`)}`;

  it("accepts a valid signature inside the replay window", () => {
    expect(verifyVaaniSignature({ secret: "s", signature: sign("s", NOW_SEC), timestamp: String(NOW_SEC), rawBody: body, nowSec: NOW_SEC + 60 }).ok).toBe(true);
  });
  it("rejects stale timestamps, bad signatures, tampered bodies and missing headers", () => {
    expect(verifyVaaniSignature({ secret: "s", signature: sign("s", NOW_SEC), timestamp: String(NOW_SEC), rawBody: body, nowSec: NOW_SEC + 301 })).toMatchObject({ ok: false, reason: "stale_timestamp" });
    expect(verifyVaaniSignature({ secret: "other", signature: sign("s", NOW_SEC), timestamp: String(NOW_SEC), rawBody: body, nowSec: NOW_SEC })).toMatchObject({ ok: false, reason: "signature_mismatch" });
    expect(verifyVaaniSignature({ secret: "s", signature: sign("s", NOW_SEC), timestamp: String(NOW_SEC), rawBody: body + " ", nowSec: NOW_SEC })).toMatchObject({ ok: false });
    expect(verifyVaaniSignature({ secret: "s", signature: null, timestamp: null, rawBody: body })).toMatchObject({ ok: false, reason: "missing_signature_headers" });
  });
  it("safeEqual is constant-shape and correct", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("webhook authentication modes", () => {
  const url = (t?: string) => new URL(`https://app.example.test/api/voice/webhooks/vaani${t ? `?token=${t}` : ""}`);
  const body = "{}";
  const set = (e: Record<string, string | undefined>) => setTestEnv({ VAANI_WEBHOOK_SECRET: undefined, VAANI_WEBHOOK_TOKEN: undefined, ...e });
  afterEach(() => setTestEnv({ NODE_ENV: "test", VAANI_WEBHOOK_TOKEN: "test-webhook-token", VAANI_WEBHOOK_SECRET: undefined }));

  it("token in the URL authenticates a bare-URL webhook; a wrong or missing token does not", () => {
    set({ VAANI_WEBHOOK_TOKEN: "tok" });
    expect(authenticateWebhook({ headers: new Headers(), url: url("tok"), rawBody: body })).toEqual({ ok: true, method: "token" });
    expect(authenticateWebhook({ headers: new Headers(), url: url("nope"), rawBody: body })).toMatchObject({ ok: false, status: 401 });
    expect(authenticateWebhook({ headers: new Headers(), url: url(), rawBody: body })).toMatchObject({ ok: false, status: 401 });
  });
  it("when Vaani sends signature headers they must verify - a valid token cannot rescue a bad signature", () => {
    set({ VAANI_WEBHOOK_TOKEN: "tok", VAANI_WEBHOOK_SECRET: "sec" });
    const ts = String(Math.floor(Date.now() / 1000));
    const good = new Headers({ "x-vaani-timestamp": ts, "x-vaani-signature": `sha256=${hmacSha256Hex("sec", `${ts}.${body}`)}` });
    expect(authenticateWebhook({ headers: good, url: url(), rawBody: body })).toEqual({ ok: true, method: "hmac" });
    const bad = new Headers({ "x-vaani-timestamp": ts, "x-vaani-signature": "sha256=deadbeef" });
    expect(authenticateWebhook({ headers: bad, url: url("tok"), rawBody: body })).toMatchObject({ ok: false, status: 401 });
  });
  it("fails CLOSED with no secrets configured (tests/production); only `next dev` is open", () => {
    set({});
    expect(authenticateWebhook({ headers: new Headers(), url: url(), rawBody: body })).toMatchObject({ ok: false, status: 503 });
    set({ NODE_ENV: "production" });
    expect(authenticateWebhook({ headers: new Headers(), url: url(), rawBody: body })).toMatchObject({ ok: false, status: 503 });
    set({ NODE_ENV: "development" });
    expect(authenticateWebhook({ headers: new Headers(), url: url(), rawBody: body })).toEqual({ ok: true, method: "dev_open" });
  });
});

describe("voice tool authentication", () => {
  afterEach(() => setTestEnv({ VOICE_TOOL_SECRET: "test-tool-secret-0123456789abcdef" }));
  it("accepts the shared secret via X-Aangan-Tool-Key or Bearer, rejects everything else", () => {
    setTestEnv({ VOICE_TOOL_SECRET: "s3cret-s3cret-s3cret-s3cret" });
    expect(authenticateToolRequest(new Headers({ "x-aangan-tool-key": "s3cret-s3cret-s3cret-s3cret" })).ok).toBe(true);
    expect(authenticateToolRequest(new Headers({ authorization: "Bearer s3cret-s3cret-s3cret-s3cret" })).ok).toBe(true);
    expect(authenticateToolRequest(new Headers({ "x-aangan-tool-key": "wrong" }))).toMatchObject({ ok: false, status: 401 });
    expect(authenticateToolRequest(new Headers())).toMatchObject({ ok: false, status: 401 });
  });
  it("22. fails closed when the secret is not configured", () => {
    setTestEnv({ VOICE_TOOL_SECRET: undefined });
    expect(authenticateToolRequest(new Headers({ "x-aangan-tool-key": "anything" }))).toMatchObject({ ok: false, status: 503 });
  });
});

describe("admin credentials and sessions", () => {
  it("hashes with scrypt, verifies, and rejects wrong passwords / malformed hashes", () => {
    const h = hashPassword("Correct-Horse-9-Battery");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(h).not.toContain("Correct-Horse");
    expect(verifyPassword("Correct-Horse-9-Battery", h)).toBe(true);
    expect(verifyPassword("wrong", h)).toBe(false);
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(hashPassword("Correct-Horse-9-Battery")).not.toBe(h); // salted
  });
  it("enforces a minimum password strength", () => {
    expect(validatePasswordStrength("short")).toMatch(/12/);
    expect(validatePasswordStrength("alllowercaseletters")).toMatch(/upper/i);
    expect(validatePasswordStrength("Str0ng-enough-Passw0rd")).toBeNull();
  });
  it("signs sessions; tampered, wrong-secret and missing tokens are rejected", async () => {
    const secret = "a".repeat(40);
    const t = await createSessionToken("nikhil@aangan.test", secret);
    expect(await verifySessionToken(t, secret)).toEqual({ email: "nikhil@aangan.test" });
    expect(await verifySessionToken(t + "x", secret)).toBeNull();
    expect(await verifySessionToken(t, "b".repeat(40))).toBeNull();
    expect(await verifySessionToken(undefined, secret)).toBeNull();
    expect(await verifySessionToken(t, undefined)).toBeNull();
    // alg=none forgery
    const forged = `${Buffer.from('{"alg":"none"}').toString("base64url")}.${Buffer.from('{"email":"x@y.z","iss":"aangan-studio"}').toString("base64url")}.`;
    expect(await verifySessionToken(forged, secret)).toBeNull();
    // an expired token
    const { SignJWT } = await import("jose");
    const expired = await new SignJWT({ email: "n@a.t" }).setProtectedHeader({ alg: "HS256" }).setIssuer("aangan-studio").setExpirationTime(Math.floor(Date.now() / 1000) - 10).sign(new TextEncoder().encode(secret));
    expect(await verifySessionToken(expired, secret)).toBeNull();
  });
});

describe("database rate limiter", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  it("allows up to the limit within a window, then blocks, then resets in the next window", async () => {
    const t0 = new Date("2026-10-12T05:00:10Z");
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await checkRateLimit(h.db, "k", 3, 60, t0));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false, false]);
    expect(results[3]!.retryAfterSec).toBeGreaterThan(0);
    expect((await checkRateLimit(h.db, "k", 3, 60, new Date("2026-10-12T05:01:05Z"))).allowed).toBe(true);
    expect((await checkRateLimit(h.db, "other-key", 3, 60, t0)).allowed).toBe(true);
  });
  it("the tool endpoint returns 429 once a call exceeds its budget", async () => {
    let last = 0;
    for (let i = 0; i < 95; i++) last = (await h.tool("get_call_context", { n: i }, "call-rl")).httpStatus;
    expect(last).toBe(429);
  });
});

describe("log and payload redaction", () => {
  it("redacts secrets by key and by pattern, masks personal data, and bounds size", () => {
    const out = redact({
      api_key: "sk-secretsecretsecret", authorization: "Bearer abcdefghijklmnop", phone_number: "+919822000111", email: "priya@example.com",
      transcript: "very long private words".repeat(5), nested: { token: "t0k3n", msg: "call me, key AIzaSyA1234567890abcdefghijklmnop ok", card: "4111111111111111" },
    }) as Record<string, unknown>;
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/secretsecret|abcdefghijklmnop|9822000111|priya@example|t0k3n|AIzaSy|4111111111111111|private words/);
    expect(out.phone_number).toBe(maskPhone("+919822000111"));
    expect(out.email).toBe(maskEmail("priya@example.com"));
    expect(redactString("https://x.test/hook?token=abc123&b=1")).toContain("token=[REDACTED]");
  });
});

describe("credentials and integration modes", () => {
  afterEach(() => setTestEnv({ NODE_ENV: "test", FORCE_MOCK_INTEGRATIONS: "1", ALLOW_MOCK_IN_PRODUCTION: undefined, CALENDLY_ACCESS_TOKEN: undefined }));

  it("22. production without credentials FAILS CLOSED instead of silently mocking", () => {
    setTestEnv({ NODE_ENV: "production", FORCE_MOCK_INTEGRATIONS: undefined, CALENDLY_ACCESS_TOKEN: undefined });
    const s = integrationStatus("calendly");
    expect(s.mode).toBe("unconfigured");
    expect(s.missing).toEqual(["CALENDLY_ACCESS_TOKEN"]);
    expect(() => getCalendly()).toThrow(IntegrationNotConfiguredError);
    expect(allIntegrationStatuses().every((x) => x.mode !== "mock")).toBe(true);
  });
  it("outside production missing credentials means labelled mock mode; real credentials mean live; FORCE_MOCK wins", () => {
    setTestEnv({ NODE_ENV: "development", FORCE_MOCK_INTEGRATIONS: undefined, CALENDLY_ACCESS_TOKEN: undefined });
    expect(integrationStatus("calendly").mode).toBe("mock");
    setTestEnv({ NODE_ENV: "development", FORCE_MOCK_INTEGRATIONS: undefined, CALENDLY_ACCESS_TOKEN: "pat" });
    expect(integrationStatus("calendly").mode).toBe("live");
    setTestEnv({ FORCE_MOCK_INTEGRATIONS: "1" });
    expect(integrationStatus("calendly").mode).toBe("mock");
  });
  it("22b. with Calendly unconfigured in production, offering slots fails honestly and alerts a human (no invented availability)", async () => {
    const h = await makeHarness();
    await h.tool("evaluate_qualification", QUALIFYING_FACTS, "call-nc");
    setTestEnv({ NODE_ENV: "production", FORCE_MOCK_INTEGRATIONS: undefined, CALENDLY_ACCESS_TOKEN: undefined });
    const r = await h.tool("get_available_slots", {}, "call-nc");
    expect(r.body.ok).toBe(false);
    expect(r.body.status).toBe("calendar_unavailable");
    expect(r.body.say).toMatch(/colleague will confirm/);
    expect(JSON.stringify(r.body)).not.toMatch(/option 1/);
    const esc = await h.db.select().from(escalations);
    expect(esc[0]!.kind).toBe("booking_failure");
  });
});

describe("knowledge layer and pricing policy", () => {
  it("the hard-coded approved pricing response matches pricing.md verbatim and the source documents are all present", () => {
    resetKnowledgeCache();
    const k = loadKnowledge();
    expect(k.pricingResponseMatchesSource).toBe(true);
    expect(k.approvedPricingResponse).toBe(APPROVED_PRICING_RESPONSE);
    expect(k.sources.every((s) => s.present)).toBe(true);
    expect(k.mustNeverSay.length).toBeGreaterThan(0);
  });
  it("internal price bands are NOT exposed by the knowledge layer", () => {
    const dump = JSON.stringify(loadKnowledge());
    expect(dump).not.toMatch(/1,?800|2,?400|3,?500|per sq ft.*₹|Indicative range|Luxury specification/i);
  });
  it("detects price disclosures but not ordinary speech", () => {
    for (const bad of ["It'll cost around two lakhs", "Our rates start at 1800", "₹1,800 per sq ft", "for a 2BHK it's typically 6 lakh", "starting at 3 lakhs", "about Rs 4,00,000", "25 lakh"]) {
      expect(containsPriceDisclosure(bad), bad).toBe(true);
    }
    for (const ok of [APPROVED_PRICING_RESPONSE, "Which locality is the property in?", "We take 8 to 16 weeks for execution.", "Your 3BHK in Kothrud sounds great."]) {
      expect(containsPriceDisclosure(ok), ok).toBe(false);
    }
  });
  it("audits only what the AGENT said, parsing Vaani's transcript format", () => {
    const t = "[10:00:01] AGENT: Hello.\n\n[10:00:05] USER: Will it be around 5 lakhs?\n\n[10:00:09] AGENT: The designer will explain everything.";
    expect(parseTranscript(t).map((x) => x.speaker)).toEqual(["agent", "user", "agent"]);
    expect(auditAgentPriceDisclosure(t).violated).toBe(false);
    expect(auditAgentPriceDisclosure(t + "\n\n[10:00:30] AGENT: Typically 2 lakhs for that.").violated).toBe(true);
  });
  it("random HMAC sanity: different secrets differ", () => {
    expect(hmacSha256Hex("a", "m")).not.toBe(hmacSha256Hex("b", "m"));
    expect(crypto.randomBytes(4)).toHaveLength(4);
  });
});
