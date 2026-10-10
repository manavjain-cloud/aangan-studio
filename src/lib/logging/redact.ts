/** Redaction for logs and for anything persisted as "payload". Secrets and personal data never reach logs. */

const SECRET_KEY = /(api[-_]?key|secret|token|password|passwd|authorization|cookie|signature|x-api-key|bearer|credential|session)/i;
const PERSONAL_KEY = /^(phone|phone_number|from_number|to_number|contact_number|caller_phone|email|caller_email|invitee_email|name|caller_name|invitee_name|transcript|transcription|address)$/i;

export function maskPhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 6) return "***";
  return `${value.startsWith("+") ? "+" : ""}${digits.slice(0, 2)}${"*".repeat(Math.max(digits.length - 5, 3))}${digits.slice(-3)}`;
}

export function maskEmail(value: string): string {
  const [local, domain] = value.split("@");
  if (!domain) return "***";
  return `${(local ?? "").slice(0, 1)}***@${domain}`;
}

const INLINE_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [REDACTED]"],
  [/\b(sk|pk|vaani|hs|pat|AIza)[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED_KEY]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[REDACTED_KEY]"],
  [/([?&](?:token|key|secret|api_key|apikey)=)[^&\s]+/gi, "$1[REDACTED]"],
  [/\b\d{13,19}\b/g, "[REDACTED_NUMBER]"], // card-like digit runs
];

export function redactString(s: string): string {
  let out = s;
  for (const [re, rep] of INLINE_PATTERNS) out = out.replace(re, rep);
  return out;
}

export interface RedactOptions {
  /** Mask personal data too (default). Set false only for secrets-only redaction. */
  personal?: boolean;
  maxString?: number;
  maxDepth?: number;
}

export function redact(value: unknown, opts: RedactOptions = {}, depth = 0): unknown {
  const { personal = true, maxString = 400, maxDepth = 6 } = opts;
  if (value === null || value === undefined) return value;
  if (typeof value === "string") {
    const s = redactString(value);
    return s.length > maxString ? `${s.slice(0, maxString)}...[+${s.length - maxString}]` : s;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: redactString(value.message) };
  if (depth >= maxDepth) return "[depth]";
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, opts, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_KEY.test(k)) {
        out[k] = "[REDACTED]";
      } else if (personal && PERSONAL_KEY.test(k)) {
        if (typeof v === "string") {
          out[k] = /^(transcript|transcription)$/i.test(k)
            ? `[transcript ${v.length} chars]`
            : /email/i.test(k)
              ? maskEmail(v)
              : /phone|number/i.test(k)
                ? maskPhone(v)
                : `${v.slice(0, 1)}***`;
        } else out[k] = "[redacted]";
      } else out[k] = redact(v, opts, depth + 1);
    }
    return out;
  }
  return String(value);
}
