import "server-only";
import { getEnv } from "../env";
import { safeEqual } from "./hmac";

export type ToolAuthResult = { ok: true } | { ok: false; status: 401 | 503; reason: string };

/**
 * Authenticates a live voice-agent tool call.
 *
 * Vaani's custom tools are plain cURL requests configured in the dashboard, so the supported mechanism is a
 * static secret sent as a header (`X-Aangan-Tool-Key`, or `Authorization: Bearer <secret>`). The secret is
 * server-side only (VOICE_TOOL_SECRET). A dynamic per-request HMAC cannot be produced by a static cURL template,
 * so this is compensated for by: payload schema validation, per-call state-machine checks, DB-backed rate
 * limits, idempotency keys, and a server-side rule that booking needs a prior offered slot + explicit confirmation.
 * Fails CLOSED if no secret is configured.
 */
export function authenticateToolRequest(headers: Headers): ToolAuthResult {
  const secret = getEnv().VOICE_TOOL_SECRET;
  if (!secret) return { ok: false, status: 503, reason: "VOICE_TOOL_SECRET is not configured" };

  const direct = headers.get("x-aangan-tool-key");
  const bearer = /^Bearer\s+(.+)$/i.exec(headers.get("authorization") ?? "")?.[1];
  const presented = direct ?? bearer;
  if (!presented) return { ok: false, status: 401, reason: "missing credentials" };
  return safeEqual(presented, secret) ? { ok: true } : { ok: false, status: 401, reason: "invalid credentials" };
}
