import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { getEnv } from "@/lib/env";
import { safeEqual } from "@/lib/security/hmac";
import { processOutbox } from "@/lib/services/jobs";
import { purgeExpiredTranscripts } from "@/lib/services/postcall";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Cron entry point (Vercel Cron sends `Authorization: Bearer $CRON_SECRET`): retries due jobs, enforces retention. */
async function run(req: NextRequest) {
  const secret = getEnv().CRON_SECRET;
  const presented = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (!secret || !presented || !safeEqual(presented, secret)) {
    return NextResponse.json({ ok: false }, { status: secret ? 401 : 503 });
  }
  const db = await getDb();
  const summary = await processOutbox(db, 20, 5);
  const purged = await purgeExpiredTranscripts(db);
  return NextResponse.json({ ok: true, ...summary, transcriptsPurged: purged });
}

export const GET = run;
export const POST = run;
