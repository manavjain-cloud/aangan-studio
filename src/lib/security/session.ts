import { SignJWT, jwtVerify } from "jose";

/**
 * Admin session = a signed, HttpOnly, SameSite=Lax JWT cookie. No third-party auth provider is required.
 * proxy.ts uses verifySessionToken() for a cheap redirect; pages and server actions call requireAdmin()
 * (db-backed) again, so the proxy is never the only line of defence.
 */

export const SESSION_COOKIE = "aangan_session";
export const SESSION_TTL_SEC = 12 * 60 * 60;

export interface SessionPayload {
  email: string;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(email: string, secret: string): Promise<string> {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setIssuer("aangan-studio")
    .setExpirationTime(`${SESSION_TTL_SEC}s`)
    .sign(key(secret));
}

export async function verifySessionToken(token: string | undefined, secret: string | undefined): Promise<SessionPayload | null> {
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer: "aangan-studio", algorithms: ["HS256"] });
    return typeof payload.email === "string" ? { email: payload.email } : null;
  } catch {
    return null;
  }
}
