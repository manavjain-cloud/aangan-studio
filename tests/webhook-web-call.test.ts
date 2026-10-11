import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calls } from "@/lib/db/schema";
import { makeHarness, type Harness } from "./helpers/harness";

/** Shapes seen from Vaani for in-browser (WebRTC) calls: no call_id, only room_name; no caller number. */
describe("web (WebRTC) call webhooks", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it("call_ended with only room_name, a null number and a list transcript is processed, not rejected", async () => {
    const room = "webrtc-1791713233-beee5fc8";
    expect((await h.webhook({ event: "call_started", from: "web-user", to: "N/A", data: { caller: "web-user", call_type: "WebRTC_Inbound", room_name: room } })).status).toBe("processed");
    const ended = await h.webhook({
      event: "call_ended", from: "N/A", to: "N/A",
      data: { room_name: room, end_reason: "Call ended", phone_number: null, call_duration: 12.65, technical_issue: false, transcript: [{ role: "agent", text: "Hello" }, { role: "user", text: "I want to build my house" }] },
    });
    expect(ended.status).toBe("processed");
    const [c] = await h.db.select().from(calls);
    expect(c!.vaaniCallId).toBe(room);
    expect(c!.endedAt).not.toBeNull();
    expect(c!.durationMs).toBe(12650);
  });
});
