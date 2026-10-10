import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setIntegrationOverride } from "@/lib/integrations";
import type { VaaniClient } from "@/lib/integrations/vaani/types";
import { MockVaaniClient } from "@/lib/integrations/vaani/mock";
import { startWebCall } from "@/lib/services/web-call";
import { makeHarness, setTestEnv, type Harness } from "./helpers/harness";

// Fixed clock: rate-limit windows are aligned to wall-clock boundaries.
const SAME = { origin: "https://studio.example", host: "studio.example", ip: "203.0.113.5", now: new Date("2026-10-12T05:00:00Z") };

describe("public web call (no telephone number)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(() => {
    setTestEnv({ FORCE_MOCK_INTEGRATIONS: "1", VAANI_API_KEY: undefined, VAANI_AGENT_ID: undefined, WEB_CALL_DAILY_CAP: undefined });
    setIntegrationOverride("vaani", undefined);
  });

  const goLive = (client?: Partial<VaaniClient>) => {
    setTestEnv({ FORCE_MOCK_INTEGRATIONS: undefined, VAANI_API_KEY: "vaani_test", VAANI_AGENT_ID: "agent-1" });
    setIntegrationOverride("vaani", Object.assign(new MockVaaniClient(), client) as VaaniClient);
  };

  it("refuses cross-site and header-less requests", async () => {
    goLive();
    expect((await startWebCall(h.db, { ...SAME, origin: "https://evil.example" })).status).toBe(403);
    expect((await startWebCall(h.db, { ...SAME, origin: null })).status).toBe(403);
    expect((await startWebCall(h.db, { ...SAME, origin: "not a url" })).status).toBe(403);
  });

  it("says plainly that voice is unavailable when Vaani is not connected (never fakes a call)", async () => {
    const r = await startWebCall(h.db, SAME);
    expect(r).toMatchObject({ ok: false, status: 503, error: "web_call_unavailable" });
  });

  it("returns only the short-lived token, url and room for a same-origin visitor", async () => {
    goLive({ createWebSession: async () => ({ token: "jwt", url: "https://server.vaani.example", room: "webrtc-1" }) });
    const r = await startWebCall(h.db, SAME);
    expect(r).toEqual({ ok: true, status: 200, token: "jwt", url: "https://server.vaani.example", room: "webrtc-1" });
  });

  it("limits each visitor and the whole site per day", async () => {
    goLive({ createWebSession: async () => ({ token: "t", url: "u", room: "r" }) });
    for (let i = 0; i < 4; i++) expect((await startWebCall(h.db, SAME)).ok).toBe(true);
    expect((await startWebCall(h.db, SAME)).status).toBe(429);
    setTestEnv({ FORCE_MOCK_INTEGRATIONS: undefined, VAANI_API_KEY: "vaani_test", VAANI_AGENT_ID: "agent-1", WEB_CALL_DAILY_CAP: "4" });
    expect((await startWebCall(h.db, { ...SAME, ip: "203.0.113.9" })).ok).toBe(false); // daily counter already at the cap of 4
  });

  it("reports a provider failure without leaking details", async () => {
    goLive({ createWebSession: async () => { throw new Error("Vaani exploded: key=secret"); } });
    const r = await startWebCall(h.db, SAME);
    expect(r).toMatchObject({ ok: false, status: 502, error: "session_failed" });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
