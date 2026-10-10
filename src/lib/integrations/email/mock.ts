import { randomUUID } from "node:crypto";
import { EmailError, type EmailClient, type EmailMessage } from "./types";

interface MockEmailState {
  sent: Array<EmailMessage & { id: string; at: string }>;
  failNext: EmailError | null;
  seen: Map<string, string>;
}
const g = globalThis as unknown as { __mockEmail?: MockEmailState };
const state = (): MockEmailState => (g.__mockEmail ??= { sent: [], failNext: null, seen: new Map() });

/** Simulated email. Nothing is delivered; messages are kept in memory for the dev outbox and tests. */
export class MockEmailClient implements EmailClient {
  readonly mode = "mock" as const;

  static reset() {
    g.__mockEmail = { sent: [], failNext: null, seen: new Map() };
  }
  static failNext(err: EmailError | null) {
    state().failNext = err;
  }
  static get sent() {
    return [...state().sent];
  }

  async send(msg: EmailMessage) {
    const s = state();
    if (s.failNext) {
      const e = s.failNext;
      s.failNext = null;
      throw e;
    }
    // Same contract as the provider: an identical idempotency key returns the original message.
    const prior = s.seen.get(msg.idempotencyKey);
    if (prior) return { id: prior };
    const id = `mock-email-${randomUUID()}`;
    s.seen.set(msg.idempotencyKey, id);
    s.sent.push({ ...msg, id, at: new Date().toISOString() });
    return { id };
  }

  async health() {
    return { ok: true, detail: "mock client (nothing is delivered)" };
  }
}
