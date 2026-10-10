import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { getDb } from "./db/client";
import { adminUsers } from "./db/schema";
import { getEnv } from "./env";
import { SESSION_COOKIE, verifySessionToken } from "./security/session";

export interface AdminSession {
  email: string;
}

function allowlist(): string[] | null {
  const raw = getEnv().ADMIN_EMAILS;
  if (!raw) return null;
  return raw.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
}

/** Verified admin session or null. Re-checks the database and the allowlist on every call (not just the cookie). */
export async function getSession(): Promise<AdminSession | null> {
  const store = await cookies();
  const payload = await verifySessionToken(store.get(SESSION_COOKIE)?.value, getEnv().SESSION_SECRET);
  if (!payload) return null;
  const email = payload.email.toLowerCase();
  const list = allowlist();
  if (list && !list.includes(email)) return null;
  const db = await getDb();
  const [row] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
  return row ? { email } : null;
}

/** Use at the top of every dashboard page and server action. Management only. */
export async function requireAdmin(): Promise<AdminSession> {
  const s = await getSession();
  if (!s) redirect("/");
  return s;
}
