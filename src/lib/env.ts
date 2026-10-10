import "server-only";
import { z } from "zod";

/**
 * Server-side configuration. Nothing here is ever exposed to the browser: there are deliberately no
 * NEXT_PUBLIC_* variables and `server-only` makes bundling this into client code a build error.
 */

/** Values pasted into hosting dashboards often keep their wrapping quotes; they are never part of the value. */
const unquote = (v: unknown) => (typeof v === "string" ? v.trim().replace(/^(["'])(.*)\1$/s, "$2") : v);
const optional = z.preprocess(unquote, z.string().trim().min(1).optional());
const flag = z
  .enum(["1", "0", "true", "false", ""])
  .optional()
  .transform((v) => v === "1" || v === "true");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  APP_URL: z.string().url().default("http://localhost:3000"),
  DEFAULT_TIMEZONE: z.string().default("Asia/Kolkata"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).default("info"),

  DATABASE_URL: optional,

  SESSION_SECRET: optional,
  ADMIN_EMAILS: optional,
  CRON_SECRET: optional,

  FORCE_MOCK_INTEGRATIONS: flag,
  ALLOW_MOCK_IN_PRODUCTION: flag,

  VAANI_API_KEY: optional,
  VAANI_BASE_URL: z.string().url().default("https://api.vaanivoice.ai"),
  VAANI_AGENT_ID: optional,
  /** Maximum public web calls started per 24 h (each costs Vaani credits). */
  WEB_CALL_DAILY_CAP: optional,
  VAANI_WEBHOOK_SECRET: optional,
  VAANI_WEBHOOK_TOKEN: optional,
  VOICE_TOOL_SECRET: optional,
  VAANI_CREDIT_INR: optional,

  GEMINI_API_KEY: optional,
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),
  GEMINI_MODEL_FALLBACKS: z.string().default("gemini-3.6-flash,gemini-flash-latest"),
  GEMINI_INPUT_INR_PER_MILLION_TOKENS: optional,
  GEMINI_OUTPUT_INR_PER_MILLION_TOKENS: optional,

  HUBSPOT_ACCESS_TOKEN: optional,
  HUBSPOT_CREATE_DEALS: flag,
  HUBSPOT_DEAL_PIPELINE: optional,
  HUBSPOT_DEAL_STAGE_QUALIFIED: optional,
  HUBSPOT_DEAL_STAGE_BOOKED: optional,

  CALENDAR_PROVIDER: z.enum(["calendly", "calcom"]).optional(),
  CALCOM_API_KEY: optional,
  CALENDLY_ACCESS_TOKEN: optional,
  CALENDLY_DEFAULT_EVENT_TYPE_URI: optional,
  CALENDLY_LOCATION_TEXT: optional,

  RESEND_API_KEY: optional,
  EMAIL_FROM: optional,
  EMAIL_TEST_RECIPIENT: optional,
  FRONT_DESK_EMAIL: optional,
  SENIOR_ESCALATION_EMAIL: optional,
  OPS_ALERT_EMAIL: optional,

  TRANSCRIPT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  ESCALATION_CALLBACK_MINUTES: optional,
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  cached = parsed.data;
  return cached;
}

/** Test hook: re-read process.env on next getEnv(). */
export function resetEnvCache(): void {
  cached = null;
}

/* ------------------------------------------------------------------ */
/* Integration modes                                                   */
/* ------------------------------------------------------------------ */

export const INTEGRATIONS = ["vaani", "gemini", "hubspot", "calendly", "email", "neon"] as const;
export type IntegrationName = (typeof INTEGRATIONS)[number];

/** live = real credentials in use. mock = simulated, clearly labelled. unconfigured = production without credentials: fails closed. */
export type IntegrationMode = "live" | "mock" | "unconfigured";

export interface IntegrationStatus {
  name: IntegrationName;
  mode: IntegrationMode;
  credentialsPresent: boolean;
  missing: string[];
  note: string | null;
}

/** Which scheduling provider is in use: explicit CALENDAR_PROVIDER, else Cal.com only when it is the only one with credentials. */
export function calendarProvider(env: Env = getEnv()): "calendly" | "calcom" {
  if (env.CALENDAR_PROVIDER) return env.CALENDAR_PROVIDER;
  return env.CALCOM_API_KEY && !env.CALENDLY_ACCESS_TOKEN ? "calcom" : "calendly";
}

function requirements(env: Env): Record<IntegrationName, { present: boolean; missing: string[] }> {
  const need = (pairs: Array<[string, unknown]>) => {
    const missing = pairs.filter(([, v]) => !v).map(([k]) => k);
    return { present: missing.length === 0, missing };
  };
  return {
    vaani: need([["VAANI_API_KEY", env.VAANI_API_KEY], ["VAANI_AGENT_ID", env.VAANI_AGENT_ID]]),
    gemini: need([["GEMINI_API_KEY", env.GEMINI_API_KEY]]),
    hubspot: need([["HUBSPOT_ACCESS_TOKEN", env.HUBSPOT_ACCESS_TOKEN]]),
    // The "calendly" integration key means "the scheduling provider": Calendly or Cal.com (see calendarProvider()).
    calendly: calendarProvider(env) === "calcom" ? need([["CALCOM_API_KEY", env.CALCOM_API_KEY]]) : need([["CALENDLY_ACCESS_TOKEN", env.CALENDLY_ACCESS_TOKEN]]),
    email: need([["RESEND_API_KEY", env.RESEND_API_KEY], ["EMAIL_FROM", env.EMAIL_FROM]]),
    neon: need([["DATABASE_URL", env.DATABASE_URL]]),
  };
}

export function integrationStatus(name: IntegrationName): IntegrationStatus {
  const env = getEnv();
  const req = requirements(env)[name];
  const forceMock = env.FORCE_MOCK_INTEGRATIONS;
  const mockAllowed = env.NODE_ENV !== "production" || env.ALLOW_MOCK_IN_PRODUCTION;

  if (name === "neon") {
    return {
      name,
      mode: req.present ? "live" : mockAllowed ? "mock" : "unconfigured",
      credentialsPresent: req.present,
      missing: req.missing,
      note: req.present ? null : "No DATABASE_URL: using a local in-process PostgreSQL (PGlite) for development only.",
    };
  }
  if (req.present && !forceMock) return { name, mode: "live", credentialsPresent: true, missing: [], note: null };
  if (mockAllowed) {
    return {
      name,
      mode: "mock",
      credentialsPresent: req.present,
      missing: req.missing,
      note: forceMock ? "FORCE_MOCK_INTEGRATIONS is set: simulated responses only." : "Credentials missing: simulated responses only.",
    };
  }
  return { name, mode: "unconfigured", credentialsPresent: false, missing: req.missing, note: "Credentials missing in production: the integration fails closed." };
}

export function allIntegrationStatuses(): IntegrationStatus[] {
  return INTEGRATIONS.map(integrationStatus);
}

export class IntegrationNotConfiguredError extends Error {
  constructor(public readonly integration: IntegrationName, public readonly missing: string[]) {
    super(`${integration} is not configured (missing: ${missing.join(", ") || "n/a"})`);
    this.name = "IntegrationNotConfiguredError";
  }
}

export function requireNumber(value: string | undefined): number | null {
  if (!value) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
