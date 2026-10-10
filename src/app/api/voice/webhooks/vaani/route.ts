import { after, NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { createLogger } from "@/lib/logging/logger";
import { authenticateWebhook } from "@/lib/security/webhook-auth";
import { handleVaaniEvent } from "@/lib/services/calls";
import { processOutbox } from "@/lib/services/jobs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const log = createLogger("api.vaani.webhook");

/** Signed/tokenised receiver for Vaani call lifecycle events. Always 2xx for duplicates so Vaani stops retrying. */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  if (rawBody.length > 512 * 1024) return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });

  const auth = authenticateWebhook({ headers: req.headers, url: new URL(req.url), rawBody });
  if (!auth.ok) {
    log.warn("webhook rejected", { reason: auth.reason });
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: auth.status });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  try {
    const db = await getDb();
    const result = await handleVaaniEvent(db, payload);
    if (result.status === "invalid") return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
    after(async () => {
      try {
        await processOutbox(await getDb());
      } catch (err) {
        log.error("post-response outbox run failed", { error: String((err as Error).message) });
      }
    });
    return NextResponse.json({ ok: true, status: result.status });
  } catch (err) {
    log.error("webhook handler error", { error: String((err as Error).message) });
    // 500 makes Vaani retry with backoff; our dedupe key makes the retry safe.
    return NextResponse.json({ ok: false, error: "processing_failed" }, { status: 500 });
  }
}

export function GET() {
  return NextResponse.json({ ok: false }, { status: 405 });
}
