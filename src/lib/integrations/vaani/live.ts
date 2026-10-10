import "server-only";
import { HttpError, NetworkError, httpJson } from "../http";
import { VaaniError, type VaaniCallDetails, type VaaniCallRecord, type VaaniClient, type VaaniWebSession } from "./types";

function mapError(err: unknown, what: string): VaaniError {
  if (err instanceof VaaniError) return err;
  if (err instanceof NetworkError) return new VaaniError(err.timedOut ? "timeout" : "server_error", `${what}: ${err.message}`);
  if (err instanceof HttpError) {
    const code = err.status === 401 || err.status === 403 ? "unauthorized" : err.status === 404 ? "not_found" : err.status === 429 ? "rate_limited" : err.status >= 500 ? "server_error" : "unknown";
    return new VaaniError(code, `${what}: HTTP ${err.status}`, err.status);
  }
  return new VaaniError("unknown", `${what}: ${String((err as Error)?.message ?? err)}`);
}

const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export class LiveVaaniClient implements VaaniClient {
  readonly mode = "live" as const;
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private get<T>(path: string, query?: Record<string, string | number>) {
    return httpJson<T>({
      integration: "vaani", url: `${this.baseUrl}${path}`, query, headers: { "X-API-Key": this.apiKey },
      retries: 2, timeoutMs: 8_000, fetchImpl: this.fetchImpl,
    });
  }

  async createWebSession(input: { agentId: string }): Promise<VaaniWebSession> {
    try {
      const { data } = await httpJson<Record<string, unknown>>({
        integration: "vaani", method: "POST", url: `${this.baseUrl}/api/trigger-call/`, headers: { "X-API-Key": this.apiKey },
        body: { agent_id: input.agentId, medium: "webrtc", primary_language: "en", secondary_language: "hi" },
        retries: 0, timeoutMs: 8_000, fetchImpl: this.fetchImpl,
      });
      const token = str(data.token);
      const url = str(data.connection_url);
      const room = str(data.room_name);
      if (!token || !url || !room) throw new VaaniError("unknown", "web session response was missing token, connection_url or room_name");
      return { token, url, room };
    } catch (err) {
      throw mapError(err, "create web session");
    }
  }

  async getCallDetails(callId: string): Promise<VaaniCallDetails> {
    try {
      const { data } = await this.get<Record<string, unknown>>(`/api/call_details/${encodeURIComponent(callId)}`);
      const transcript = str(data.transcription);
      const notReady = !transcript || /not available for further evaluations/i.test(transcript);
      const entity = data.entity && typeof data.entity === "object" ? (data.entity as Record<string, unknown>) : null;
      return {
        transcript: notReady ? null : transcript,
        summary: notReady ? null : str(data.summary),
        entities: notReady ? null : entity,
        evalTag: str(data.call_eval_tag),
        ready: !notReady,
      };
    } catch (err) {
      throw mapError(err, "get call details");
    }
  }

  async getCallHistory(input: { page: number; pageSize: number }) {
    try {
      const { data } = await this.get<{ data?: Array<Record<string, unknown>>; pagination?: { has_next?: boolean } }>("/api/call-history", {
        page: input.page, page_size: Math.min(input.pageSize, 200),
      });
      const records: VaaniCallRecord[] = (data.data ?? []).map((r) => ({
        callId: String(r.call_id ?? ""),
        direction: str(r.direction),
        callType: str(r.call_type),
        status: str(r.call_status),
        agentId: str(r.agent_id),
        fromNumber: str(r.from_number),
        toNumber: str(r.to_number),
        startTime: str(r.Start_time),
        endTime: str(r.End_time),
        durationMs: num(r.duration_ms),
        costCredits: num(r.call_cost),
        summary: str(r.call_summary),
        postProcessingStatus: str(r.post_processing_status),
      }));
      return { records: records.filter((r) => r.callId), hasNext: data.pagination?.has_next === true };
    } catch (err) {
      throw mapError(err, "get call history");
    }
  }

  async health() {
    try {
      await this.get("/api/agents", { page: 1, page_size: 1 });
      return { ok: true, detail: "API key accepted (agents endpoint reachable)" };
    } catch (err) {
      return { ok: false, detail: mapError(err, "health check").message };
    }
  }
}
