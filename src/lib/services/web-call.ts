import type { Db } from "../db/client";
import { getVaani } from "../integrations";
import { getEnv, integrationStatus } from "../env";
import { createLogger } from "../logging/logger";
import { checkRateLimit } from "../security/rate-limit";

const log = createLogger("web-call");

export type WebCallResult =
  | { ok: true; status: 200; token: string; url: string; room: string }
  | { ok: false; status: 403 | 429 | 502 | 503; error: string; message: string };

const fail = (status: 403 | 429 | 502 | 503, error: string, message: string): WebCallResult => ({ ok: false, status, error, message });

/**
 * Starts an in-browser (WebRTC) call with the Vaani agent: the only way into the system, no telephone number involved.
 * The Vaani API key stays on the server; the browser only receives a short-lived LiveKit token. Because every session costs
 * credits and the page is public, it is same-origin only and limited per visitor and per day.
 */
export async function startWebCall(db: Db, input: { origin: string | null; host: string | null; ip: string; now?: Date }): Promise<WebCallResult> {
  let sameOrigin = false;
  try {
    sameOrigin = !!input.origin && !!input.host && new URL(input.origin).host === input.host;
  } catch {
    sameOrigin = false;
  }
  if (!sameOrigin) return fail(403, "forbidden", "Web calls can only be started from this site.");

  if (integrationStatus("vaani").mode !== "live") return fail(503, "web_call_unavailable", "The voice assistant is not connected on this server yet.");

  const visitor = await checkRateLimit(db, `webcall:ip:${input.ip}`, 4, 600, input.now);
  if (!visitor.allowed) return fail(429, "rate_limited", `Please wait ${Math.ceil(visitor.retryAfterSec / 60)} minute(s) before starting another call.`);
  const configured = Number(getEnv().WEB_CALL_DAILY_CAP);
  const daily = await checkRateLimit(db, "webcall:daily", configured > 0 ? configured : 40, 86_400, input.now);
  if (!daily.allowed) return fail(429, "daily_limit", "The assistant is very busy today. Please try again tomorrow.");

  try {
    const session = await getVaani().createWebSession({ agentId: getEnv().VAANI_AGENT_ID! });
    return { ok: true, status: 200, token: session.token, url: session.url, room: session.room };
  } catch (err) {
    log.error("could not create web session", { error: String((err as Error).message) });
    return fail(502, "session_failed", "The assistant could not be reached right now. Please try again in a moment.");
  }
}
