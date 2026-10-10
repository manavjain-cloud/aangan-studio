import { sql } from "drizzle-orm";
import { createMemoryDb, type Db } from "@/lib/db/client";
import { teamMembers } from "@/lib/db/schema";
import { MockCalendlyClient } from "@/lib/integrations/calendly/mock";
import { MockEmailClient } from "@/lib/integrations/email/mock";
import { MockGeminiClient } from "@/lib/integrations/gemini/mock";
import { MockHubspotClient } from "@/lib/integrations/hubspot/mock";
import { MockVaaniClient } from "@/lib/integrations/vaani/mock";
import { setIntegrationOverride } from "@/lib/integrations";
import { resetEnvCache } from "@/lib/env";
import { handleToolRequest, type ToolResult } from "@/lib/services/voice-tools";
import { handleVaaniEvent } from "@/lib/services/calls";
import { processOutbox } from "@/lib/services/jobs";

export const TOOL_SECRET = "test-tool-secret-0123456789abcdef";

export interface Harness {
  db: Db;
  close: () => Promise<void>;
  tool: (action: string, data?: Record<string, unknown>, callId?: string, extra?: Record<string, unknown>) => Promise<ToolResult>;
  webhook: (payload: Record<string, unknown>) => ReturnType<typeof handleVaaniEvent>;
  drain: () => ReturnType<typeof processOutbox>;
}

export function setTestEnv(extra: Record<string, string | undefined> = {}) {
  Object.assign(process.env, {
    FORCE_MOCK_INTEGRATIONS: "1",
    VOICE_TOOL_SECRET: TOOL_SECRET,
    VAANI_WEBHOOK_TOKEN: "test-webhook-token",
    FRONT_DESK_EMAIL: "frontdesk@aangan.test",
    SENIOR_ESCALATION_EMAIL: "nikhil@aangan.test",
    OPS_ALERT_EMAIL: "ops@aangan.test",
    LOG_LEVEL: "silent",
    ...extra,
  });
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete process.env[k];
  resetEnvCache();
}

let shared: Promise<{ db: Db; close: () => Promise<void> }> | null = null;

/** One migrated in-memory Postgres per test file; tables are truncated between tests (much faster than rebuilding). */
async function sharedDb() {
  shared ??= createMemoryDb();
  const handle = await shared;
  const res = await handle.db.execute(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = ((res as unknown as { rows: Array<{ tablename: string }> }).rows ?? []).map((r) => `"${r.tablename}"`);
  if (names.length) await handle.db.execute(sql.raw(`truncate table ${names.join(", ")} restart identity cascade`));
  return handle;
}

export async function closeSharedDb() {
  if (shared) await (await shared).close();
  shared = null;
}

export async function makeHarness(opts: { designers?: number } = {}): Promise<Harness> {
  setTestEnv();
  const { db } = await sharedDb();
  const close = async () => undefined;
  MockCalendlyClient.reset();
  MockHubspotClient.reset();
  MockEmailClient.reset();
  MockVaaniClient.reset();
  MockGeminiClient.behaviour = "ok";
  for (const k of ["calendly", "hubspot", "email", "gemini", "vaani"] as const) setIntegrationOverride(k, undefined);

  const n = opts.designers ?? 2;
  for (let i = 1; i <= n; i++) {
    await db.insert(teamMembers).values({
      name: `Designer ${i}`, email: `designer${i}@aangan.test`, role: "designer",
      calendlyEventTypeUri: `https://api.calendly.com/event_types/DESIGNER${i}`,
    });
  }
  await db.insert(teamMembers).values({ name: "Front Desk", email: "frontdesk@aangan.test", role: "front_desk" });
  await db.insert(teamMembers).values({ name: "Nikhil", email: "nikhil@aangan.test", role: "senior" });

  let seq = 0;
  return {
    db,
    close,
    tool: (action, data = {}, callId = "call-test-1", extra = {}) =>
      handleToolRequest(db, { action, call_id: callId, request_id: `req-${++seq}`, ...extra, args: data }, { ip: "127.0.0.1" }),
    webhook: (payload) => handleVaaniEvent(db, payload),
    drain: () => processOutbox(db, 20, 6),
  };
}

/** A fully qualifying residential enquiry (no price talk, flexible timeline). */
export const QUALIFYING_FACTS = {
  caller_name: "Priya Test",
  service_intent: "design_and_execution",
  project_type: "residential",
  property_kind: "apartment",
  scope: "full_home",
  bhk: 3,
  carpet_area_sqft: 1400,
  location_text: "Kothrud, Pune",
  timeline_flexible: true,
  authority: "authorised_representative",
};
