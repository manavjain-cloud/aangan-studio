import crypto from "node:crypto";

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // Compare fixed-length digests so neither length nor content leaks through timing.
  const ha = crypto.createHash("sha256").update(ab).digest();
  const hb = crypto.createHash("sha256").update(bb).digest();
  return crypto.timingSafeEqual(ha, hb) && ab.length === bb.length;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export function hmacSha256Hex(secret: string, message: string): string {
  return crypto.createHmac("sha256", secret).update(message).digest("hex");
}

/**
 * Vaani's documented webhook signature scheme (Campaign Webhooks > Webhook Security):
 *   X-Vaani-Timestamp: <unix seconds>
 *   X-Vaani-Signature: sha256=<hex hmac-sha256(secret, `${timestamp}.${rawBody}`)>
 * with a 5 minute replay window.
 */
export function verifyVaaniSignature(input: {
  secret: string;
  signature: string | null;
  timestamp: string | null;
  rawBody: string;
  nowSec?: number;
  toleranceSec?: number;
}): { ok: boolean; reason?: string } {
  const { secret, signature, timestamp, rawBody, nowSec = Math.floor(Date.now() / 1000), toleranceSec = 300 } = input;
  if (!signature || !timestamp) return { ok: false, reason: "missing_signature_headers" };
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad_timestamp" };
  if (Math.abs(nowSec - ts) > toleranceSec) return { ok: false, reason: "stale_timestamp" };
  const expected = `sha256=${hmacSha256Hex(secret, `${timestamp}.${rawBody}`)}`;
  return safeEqual(expected, signature) ? { ok: true } : { ok: false, reason: "signature_mismatch" };
}

export function randomToken(bytes = 16): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
