import "server-only";
import { HttpError, NetworkError, httpJson } from "../http";
import { EmailError, type EmailClient, type EmailMessage } from "./types";

/**
 * Email via Resend's HTTP API (POST https://api.resend.com/emails, Bearer auth, Idempotency-Key header).
 * A verified sending domain is required for production: Resend's test sender can only deliver to the
 * account owner's own address. EMAIL_TEST_RECIPIENT redirects every message to one address for pilots.
 */
export class LiveResendClient implements EmailClient {
  readonly mode = "live" as const;
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(msg: EmailMessage): Promise<{ id: string }> {
    try {
      const { data } = await httpJson<{ id: string }>({
        integration: "resend", url: "https://api.resend.com/emails", method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Idempotency-Key": msg.idempotencyKey.slice(0, 256) },
        body: { from: this.from, to: [msg.to], subject: msg.subject, html: msg.html, text: msg.text, ...(msg.replyTo ? { reply_to: msg.replyTo } : {}) },
        retries: 2, timeoutMs: 8_000, fetchImpl: this.fetchImpl,
      });
      return { id: data.id };
    } catch (err) {
      if (err instanceof NetworkError) throw new EmailError(err.timedOut ? "timeout" : "server_error", err.message);
      if (err instanceof HttpError) {
        const code = err.status === 401 || err.status === 403 ? "unauthorized" : err.status === 429 ? "rate_limited" : err.status >= 500 ? "server_error" : "invalid_request";
        throw new EmailError(code, `Resend HTTP ${err.status}: ${err.body.slice(0, 160)}`, err.status);
      }
      throw new EmailError("unknown", String((err as Error)?.message ?? err));
    }
  }

  async health() {
    try {
      await httpJson({ integration: "resend", url: "https://api.resend.com/domains", headers: { Authorization: `Bearer ${this.apiKey}` }, timeoutMs: 6_000, fetchImpl: this.fetchImpl });
      return { ok: true, detail: "authenticated (domains readable)" };
    } catch (err) {
      // A send-only restricted key cannot list domains (403) but is still valid for sending.
      if (err instanceof HttpError && err.status === 401) return { ok: false, detail: "API key rejected" };
      return { ok: true, detail: "key accepted (restricted keys cannot list domains)" };
    }
  }
}
