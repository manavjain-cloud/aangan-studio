export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Provider-level idempotency so a retried send is not delivered twice. */
  idempotencyKey: string;
  replyTo?: string;
}

export class EmailError extends Error {
  constructor(
    public readonly code: "unauthorized" | "invalid_request" | "rate_limited" | "server_error" | "timeout" | "unknown",
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = "EmailError";
  }
  get retryable() {
    return this.code === "rate_limited" || this.code === "server_error" || this.code === "timeout";
  }
}

export interface EmailClient {
  readonly mode: "live" | "mock";
  send(msg: EmailMessage): Promise<{ id: string }>;
  health(): Promise<{ ok: boolean; detail: string }>;
}
