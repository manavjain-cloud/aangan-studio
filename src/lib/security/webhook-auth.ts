import "server-only";
import { getEnv } from "../env";
import { safeEqual, verifyVaaniSignature } from "./hmac";

export type WebhookAuthResult = { ok: true; method: "hmac" | "token" | "dev_open" } | { ok: false; status: 401 | 503; reason: string };

/**
 * Authenticates an inbound Vaani call-event webhook.
 *
 * Vaani's public docs describe HMAC-SHA256 signing (X-Vaani-Signature / X-Vaani-Timestamp) only for CAMPAIGN
 * webhooks; the standard call webhooks (call_started, call_ended, call_postprocessing...) document no signature
 * and are configured as a bare URL under Settings -> Webhooks. So this accepts either:
 *   1. a valid HMAC (VAANI_WEBHOOK_SECRET) - used automatically if Vaani sends signature headers, or
 *   2. a secret token in the webhook URL (?token=VAANI_WEBHOOK_TOKEN) - the only mechanism available for a bare URL.
 * If a signature IS present it must be valid (a wrong signature is never rescued by the token).
 * With neither secret configured it fails closed in production and in tests; only `next dev` is open.
 */
export function authenticateWebhook(input: { headers: Headers; url: URL; rawBody: string }): WebhookAuthResult {
  const env = getEnv();
  const secret = env.VAANI_WEBHOOK_SECRET;
  const token = env.VAANI_WEBHOOK_TOKEN;

  const signature = input.headers.get("x-vaani-signature");
  const timestamp = input.headers.get("x-vaani-timestamp");

  if (signature || timestamp) {
    if (!secret) return { ok: false, status: 503, reason: "signature present but VAANI_WEBHOOK_SECRET is not configured" };
    const v = verifyVaaniSignature({ secret, signature, timestamp, rawBody: input.rawBody });
    return v.ok ? { ok: true, method: "hmac" } : { ok: false, status: 401, reason: v.reason ?? "bad signature" };
  }

  if (token) {
    const presented = input.url.searchParams.get("token");
    if (presented && safeEqual(presented, token)) return { ok: true, method: "token" };
    return { ok: false, status: 401, reason: "invalid or missing webhook token" };
  }

  if (secret) return { ok: false, status: 401, reason: "signature required" };
  if (env.NODE_ENV === "development") return { ok: true, method: "dev_open" };
  return { ok: false, status: 503, reason: "no webhook secret configured (set VAANI_WEBHOOK_TOKEN or VAANI_WEBHOOK_SECRET)" };
}
