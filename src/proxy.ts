import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/security/session";

/**
 * First line of defence for the management dashboard: no valid signed session cookie -> back to the entry page.
 * Pages and server actions re-verify against the database (requireAdmin), so this is never the only check.
 * The voice tool and webhook API routes are deliberately NOT matched here; they carry their own authentication.
 */
export async function proxy(req: NextRequest) {
  // PUBLIC_DASHBOARD: viewing is open to anyone with the link; every server action still requires an admin session.
  if (/^(1|true)$/i.test(process.env.PUBLIC_DASHBOARD ?? "")) {
    const open = NextResponse.next();
    open.headers.set("Cache-Control", "private, no-store");
    return open;
  }
  const session = await verifySessionToken(req.cookies.get(SESSION_COOKIE)?.value, process.env.SESSION_SECRET);
  if (!session) {
    const url = req.nextUrl.clone();
    url.pathname = "/";
    url.search = "";
    return NextResponse.redirect(url);
  }
  const res = NextResponse.next();
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

export const config = { matcher: ["/dashboard/:path*"] };
