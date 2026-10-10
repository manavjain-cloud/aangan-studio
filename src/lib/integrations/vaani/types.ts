/**
 * Vaani Backend API client contract (https://docs.vaanivoice.ai, header `X-API-Key`).
 *
 * VERIFIED against the public docs:   GET /api/call-history, GET /api/call_details/{id}, GET /api/transcript/{id},
 *                                     GET /api/agents, PATCH /api/agent/{id}/deployment (inbound number), webhooks
 *                                     (call_started, user_picked_up_at, call_ended, call_postprocessing,
 *                                     human_transfer_*) and dashboard-configured custom cURL tools.
 * NOT documented publicly:            the request template syntax of custom cURL tools, and request signing on
 *                                     the standard (non-campaign) call webhooks. See docs/vaani-integration.md.
 */

export interface VaaniCallRecord {
  callId: string;
  direction: string | null;
  callType: string | null;
  status: string | null;
  agentId: string | null;
  fromNumber: string | null;
  toNumber: string | null;
  startTime: string | null;
  endTime: string | null;
  durationMs: number | null;
  /** Provider "credits". Conversion to INR needs VAANI_CREDIT_INR; it is never guessed. */
  costCredits: number | null;
  summary: string | null;
  postProcessingStatus: string | null;
}

export interface VaaniCallDetails {
  transcript: string | null;
  summary: string | null;
  entities: Record<string, unknown> | null;
  evalTag: string | null;
  /** False while Vaani has not finished post-processing. */
  ready: boolean;
}

export interface VaaniWebSession {
  /** Short-lived participant token for the LiveKit browser client. */
  token: string;
  /** LiveKit server URL (https or wss). */
  url: string;
  /** Room name; Vaani reports the same name as the call id in its webhooks. */
  room: string;
}

export interface VaaniClient {
  readonly mode: "live" | "mock";
  /** Starts an in-browser (WebRTC) call with the agent: no telephone number is involved. */
  createWebSession(input: { agentId: string }): Promise<VaaniWebSession>;
  getCallDetails(callId: string): Promise<VaaniCallDetails>;
  getCallHistory(input: { page: number; pageSize: number }): Promise<{ records: VaaniCallRecord[]; hasNext: boolean }>;
  health(): Promise<{ ok: boolean; detail: string }>;
}

export class VaaniError extends Error {
  constructor(
    public readonly code: "unauthorized" | "not_found" | "rate_limited" | "server_error" | "timeout" | "unknown",
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "VaaniError";
  }
  get retryable() {
    return this.code === "rate_limited" || this.code === "server_error" || this.code === "timeout";
  }
}
