import { z } from "zod";

/**
 * Voice-agent tool arguments come from an LLM filling a cURL template, so numbers and booleans
 * routinely arrive as strings ("1,400", "yes", "null"). These helpers normalise them *before*
 * schema validation. They never invent a value: anything unparseable becomes null (= unknown).
 */

const NULLISH = new Set(["", "null", "none", "n/a", "na", "unknown", "undefined", "not mentioned", "not sure"]);

export function isNullishString(v: unknown): boolean {
  return typeof v === "string" && NULLISH.has(v.trim().toLowerCase());
}

export function looseNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string") {
    if (isNullishString(v)) return null;
    const cleaned = v.replace(/[,\s₹]/g, "").replace(/rs\.?/i, "");
    if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function looseBoolean(v: unknown): boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : null;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["true", "yes", "y", "1"].includes(s)) return true;
    if (["false", "no", "n", "0"].includes(s)) return false;
    return null;
  }
  return null;
}

export function looseString(v: unknown, max = 500): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    return null;
  }
  if (isNullishString(v)) return null;
  // Strip control characters; cap length so a caller cannot smuggle a wall of text into the record.
  const cleaned = v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ").trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export const zNumber = z.preprocess(looseNumber, z.number().nullable());
export const zBool = z.preprocess(looseBoolean, z.boolean().nullable());
export const zText = (max = 500) => z.preprocess((v) => looseString(v, max), z.string().nullable());

/** Enum that maps unknown / nullish / unrecognised values to null instead of throwing. */
export function zLooseEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess((v) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== "string") return null;
    const s = v.trim().toLowerCase().replace(/[\s-]+/g, "_");
    return (values as readonly string[]).includes(s) ? s : null;
  }, z.enum(values).nullable());
}

/** ISO date (YYYY-MM-DD) or full ISO timestamp -> normalised YYYY-MM-DD, otherwise null. */
export const zDateOnly = z.preprocess((v) => {
  const s = looseString(v, 40);
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}, z.string().nullable());
