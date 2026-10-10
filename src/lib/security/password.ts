import crypto from "node:crypto";

/** scrypt password hashing (node:crypto, no dependency). Format: scrypt$N$r$p$salt$hash (base64url). */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64url"), hash.toString("base64url")].join("$");
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  try {
    const expected = Buffer.from(hashB64, "base64url");
    const actual = crypto.scryptSync(password, Buffer.from(saltB64, "base64url"), expected.length, {
      N: Number(n), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function validatePasswordStrength(password: string): string | null {
  if (password.length < 12) return "Password must be at least 12 characters.";
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password) || !/\d/.test(password)) return "Use upper-case, lower-case letters and a digit.";
  return null;
}
