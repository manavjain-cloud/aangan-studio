import { NextResponse, type NextRequest } from "next/server";
import { getDb } from "@/lib/db/client";
import { startWebCall } from "@/lib/services/web-call";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 15;

const noStore = { "Cache-Control": "no-store" };

/** Public, same-origin endpoint behind the "Talk to the studio" button. See services/web-call.ts. */
export async function POST(req: NextRequest) {
  const result = await startWebCall(await getDb(), {
    origin: req.headers.get("origin"),
    host: req.headers.get("host"),
    ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown",
  });
  if (!result.ok) return NextResponse.json({ ok: false, error: result.error, message: result.message }, { status: result.status, headers: noStore });
  return NextResponse.json({ ok: true, token: result.token, url: result.url, room: result.room }, { headers: noStore });
}
