import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { integrationEvents } from "@/lib/db/schema";
import { checkRateLimit } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const body = z.object({
  room: z.string().max(80),
  events: z.array(z.object({ t: z.number(), e: z.string().max(60), d: z.string().max(200).optional() })).max(60),
});

/** Same-origin diagnostics beacon from the web-call widget (what the browser saw: disconnect reason, visibility, ...). No personal data. */
export async function POST(req: NextRequest) {
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  let same = false;
  try {
    same = !!origin && !!host && new URL(origin).host === host;
  } catch {
    same = false;
  }
  if (!same) return NextResponse.json({ ok: false }, { status: 403 });
  const text = await req.text();
  if (text.length > 8_000) return NextResponse.json({ ok: false }, { status: 413 });
  const parsed = body.safeParse((() => { try { return JSON.parse(text); } catch { return null; } })());
  if (!parsed.success) return NextResponse.json({ ok: false }, { status: 400 });
  const db = await getDb();
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (!(await checkRateLimit(db, `webdiag:ip:${ip}`, 120, 600)).allowed) return NextResponse.json({ ok: false }, { status: 429 });
  await db.insert(integrationEvents).values({
    integration: "vaani", direction: "inbound", eventType: "web_call_client", status: "received",
    payload: { room: parsed.data.room, events: parsed.data.events, userAgent: (req.headers.get("user-agent") ?? "").slice(0, 160) },
  });
  return NextResponse.json({ ok: true });
}
