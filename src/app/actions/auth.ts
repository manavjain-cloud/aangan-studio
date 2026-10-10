"use server";

import { eq } from "drizzle-orm";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db/client";
import { adminUsers, auditEvents } from "@/lib/db/schema";
import { getEnv } from "@/lib/env";
import { hashPassword, verifyPassword } from "@/lib/security/password";
import { checkRateLimit } from "@/lib/security/rate-limit";
import { SESSION_COOKIE, SESSION_TTL_SEC, createSessionToken } from "@/lib/security/session";

const DUMMY_HASH = hashPassword("dummy-password-for-timing-equalisation");
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

function safeNext(raw: FormDataEntryValue | null): string {
  const s = typeof raw === "string" ? raw : "";
  return s.startsWith("/dashboard") && !s.startsWith("//") ? s : "/dashboard";
}

export async function signIn(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = safeNext(formData.get("next"));
  const fail = (code: string): never => redirect(`/?error=${code}`);

  const env = getEnv();
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) fail("config");
  if (!email || !password || email.length > 200 || password.length > 200) fail("invalid");

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
  const db = await getDb();
  const [ipLimit, emailLimit] = await Promise.all([
    checkRateLimit(db, `login:ip:${ip}`, 20, 600),
    checkRateLimit(db, `login:email:${email}`, 8, 900),
  ]);
  if (!ipLimit.allowed || !emailLimit.allowed) fail("rate");

  const allow = env.ADMIN_EMAILS?.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const [user] = await db.select().from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
  const allowed = !allow || allow.includes(email);

  if (user?.lockedUntil && user.lockedUntil > new Date()) {
    verifyPassword(password, DUMMY_HASH);
    fail("locked");
  }

  const ok = user && allowed ? verifyPassword(password, user.passwordHash) : (verifyPassword(password, DUMMY_HASH), false);
  if (!ok || !user) {
    if (user) {
      const attempts = user.failedAttempts + 1;
      await db
        .update(adminUsers)
        .set({ failedAttempts: attempts, lockedUntil: attempts >= MAX_FAILS ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null })
        .where(eq(adminUsers.id, user.id));
    }
    await db.insert(auditEvents).values({ actor: email.slice(0, 80), action: "auth.login_failed", detail: { ip } });
    fail("credentials");
  }

  await db.update(adminUsers).set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(adminUsers.id, user!.id));
  await db.insert(auditEvents).values({ actor: email, action: "auth.login", detail: { ip } });

  const token = await createSessionToken(email, env.SESSION_SECRET!);
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SEC,
  });
  redirect(next);
}

export async function signOut(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/");
}
