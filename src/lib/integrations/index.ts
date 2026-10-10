import "server-only";
import { IntegrationNotConfiguredError, calendarProvider, getEnv, integrationStatus, type IntegrationName } from "../env";
import type { CalendlyClient } from "./calendly/types";
import type { EmailClient } from "./email/types";
import type { GeminiClient } from "./gemini/types";
import type { HubspotClient } from "./hubspot/types";
import type { VaaniClient } from "./vaani/types";
import { LiveCalcomClient } from "./calcom/live";
import { LiveCalendlyClient } from "./calendly/live";
import { MockCalendlyClient } from "./calendly/mock";
import { LiveResendClient } from "./email/live";
import { MockEmailClient } from "./email/mock";
import { LiveGeminiClient } from "./gemini/live";
import { MockGeminiClient } from "./gemini/mock";
import { LiveHubspotClient } from "./hubspot/live";
import { MockHubspotClient } from "./hubspot/mock";
import { LiveVaaniClient } from "./vaani/live";
import { MockVaaniClient } from "./vaani/mock";

/**
 * Integration factory. Business logic only ever depends on the interfaces above. Mode resolution (live / mock /
 * unconfigured) lives in env.ts; in production, missing credentials FAIL CLOSED instead of silently mocking.
 */

interface Overrides {
  calendly?: CalendlyClient;
  hubspot?: HubspotClient;
  email?: EmailClient;
  gemini?: GeminiClient;
  vaani?: VaaniClient;
}
const overrides: Overrides = {};

/** Test hook: inject a client (e.g. one wrapping a fake fetch). Pass undefined to clear. */
export function setIntegrationOverride<K extends keyof Overrides>(name: K, client: Overrides[K] | undefined) {
  if (client === undefined) delete overrides[name];
  else overrides[name] = client;
}

function resolve<T>(name: IntegrationName, make: { live: () => T; mock: () => T }): T {
  const s = integrationStatus(name);
  if (s.mode === "live") return make.live();
  if (s.mode === "mock") return make.mock();
  throw new IntegrationNotConfiguredError(name, s.missing);
}

export function getCalendly(): CalendlyClient {
  return (
    overrides.calendly ??
    resolve<CalendlyClient>("calendly", {
      live: () => (calendarProvider() === "calcom" ? new LiveCalcomClient(getEnv().CALCOM_API_KEY!) : new LiveCalendlyClient(getEnv().CALENDLY_ACCESS_TOKEN!)),
      mock: () => new MockCalendlyClient(),
    })
  );
}

/** The scheduling provider client (Calendly or Cal.com). */
export const getCalendar = getCalendly;

export function getHubspot(): HubspotClient {
  return overrides.hubspot ?? resolve<HubspotClient>("hubspot", { live: () => new LiveHubspotClient(getEnv().HUBSPOT_ACCESS_TOKEN!), mock: () => new MockHubspotClient() });
}

export function getEmail(): EmailClient {
  return (
    overrides.email ??
    resolve<EmailClient>("email", { live: () => new LiveResendClient(getEnv().RESEND_API_KEY!, getEnv().EMAIL_FROM!), mock: () => new MockEmailClient() })
  );
}

export function getGemini(): GeminiClient {
  return overrides.gemini ?? resolve<GeminiClient>("gemini", { live: () => new LiveGeminiClient(getEnv().GEMINI_API_KEY!), mock: () => new MockGeminiClient() });
}

export function getVaani(): VaaniClient {
  return (
    overrides.vaani ??
    resolve<VaaniClient>("vaani", { live: () => new LiveVaaniClient(getEnv().VAANI_API_KEY!, getEnv().VAANI_BASE_URL), mock: () => new MockVaaniClient() })
  );
}

export function integrationModeLabel(name: IntegrationName): "live" | "mock" {
  return integrationStatus(name).mode === "live" ? "live" : "mock";
}
