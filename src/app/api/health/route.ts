import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** Liveness only. Integration health (which needs authentication) lives in the management dashboard. */
export function GET() {
  return NextResponse.json({ ok: true });
}
