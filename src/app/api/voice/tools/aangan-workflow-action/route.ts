import { after, NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { createLogger } from "@/lib/logging/logger";
import { authenticateToolRequest } from "@/lib/security/tool-auth";
import { processOutbox } from "@/lib/services/jobs";
import { handleToolRequest } from "@/lib/services/voice-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const log = createLogger("api.voice.tool");
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Live backend tool endpoint for the Vaani voice agent (custom cURL tool, invoked mid-call over HTTPS).
 * See docs/vaani-integration.md for the exact tool configuration to paste into the Vaani dashboard.
 */
export async function POST(req: NextRequest) {
  const auth = authenticateToolRequest(req.headers);
  if (!auth.ok) {
    log.warn("tool request rejected", { reason: auth.reason });
    return NextResponse.json({ ok: false, status: "unauthorized", error: { code: "unauthorized", message: auth.reason } }, { status: auth.status });
  }

  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, status: "payload_too_large", error: { code: "payload_too_large", message: "Body too large" } }, { status: 413 });
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, status: "invalid_json", error: { code: "invalid_json", message: "Body must be JSON" } }, { status: 400 });
  }

  // Vaani's tool form has static headers / query parameters and agent-extracted body parameters, so the action may
  // arrive as ?action=... (static) instead of in the body.
  const url = new URL(req.url);
  const qAction = url.searchParams.get("action");
  if (qAction && body && typeof body === "object" && !Array.isArray(body) && !("action" in (body as Record<string, unknown>))) {
    (body as Record<string, unknown>).action = qAction;
  }
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const db = await getDb();
  const result = await handleToolRequest(db, body, { ip, headerNames: [...req.headers.keys()].filter((h) => !/^(authorization|cookie|x-aangan-tool-key)$/i.test(h)) });
  // Side effects (HubSpot, email) run after the response so the caller is never kept waiting on them.
  after(async () => {
    try {
      await processOutbox(await getDb());
    } catch (err) {
      log.error("post-response outbox run failed", { error: String((err as Error).message) });
    }
  });
  return NextResponse.json(result.body, { status: result.httpStatus, headers: { "Cache-Control": "no-store" } });
}

export function GET() {
  return NextResponse.json({ ok: false, status: "method_not_allowed" }, { status: 405 });
}
