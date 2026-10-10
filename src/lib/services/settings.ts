import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { appSettings, auditEvents } from "../db/schema";
import { DEFAULT_QUALIFICATION_CONFIG, qualificationConfigSchema, type QualificationConfig } from "../domain/config";

const QUAL_KEY = "qualification_config";

/** Stored override merged over defaults and re-validated; an invalid stored value falls back to defaults. */
export async function getQualificationConfig(db: Db): Promise<QualificationConfig> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, QUAL_KEY)).limit(1);
  if (!row) return DEFAULT_QUALIFICATION_CONFIG;
  const merged = deepMerge(DEFAULT_QUALIFICATION_CONFIG as unknown as Record<string, unknown>, row.value as Record<string, unknown>);
  const parsed = qualificationConfigSchema.safeParse(merged);
  return parsed.success ? parsed.data : DEFAULT_QUALIFICATION_CONFIG;
}

export async function setQualificationConfig(db: Db, config: QualificationConfig, actor: string): Promise<void> {
  const parsed = qualificationConfigSchema.parse(config);
  await db
    .insert(appSettings)
    .values({ key: QUAL_KEY, value: parsed, updatedBy: actor })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: parsed, updatedAt: new Date(), updatedBy: actor } });
  await db.insert(auditEvents).values({ actor, action: "settings.qualification_config.updated", entityType: "app_settings", entityId: QUAL_KEY, detail: { config: parsed } });
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    const b = out[k];
    out[k] = v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)
      ? deepMerge(b as Record<string, unknown>, v as Record<string, unknown>)
      : v;
  }
  return out;
}

/* Cost-rate settings (all optional; nothing is invented when unset). */
export const costSettingsSchema = z.object({
  vaaniCreditInr: z.number().positive().nullable(),
  geminiInputInrPerMillion: z.number().positive().nullable(),
  geminiOutputInrPerMillion: z.number().positive().nullable(),
});
export type CostSettings = z.infer<typeof costSettingsSchema>;
const COST_KEY = "cost_settings";

export async function getCostSettings(db: Db, envFallback: Partial<CostSettings> = {}): Promise<CostSettings> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, COST_KEY)).limit(1);
  const stored = row ? costSettingsSchema.safeParse(row.value) : null;
  const s = stored?.success ? stored.data : { vaaniCreditInr: null, geminiInputInrPerMillion: null, geminiOutputInrPerMillion: null };
  return {
    vaaniCreditInr: s.vaaniCreditInr ?? envFallback.vaaniCreditInr ?? null,
    geminiInputInrPerMillion: s.geminiInputInrPerMillion ?? envFallback.geminiInputInrPerMillion ?? null,
    geminiOutputInrPerMillion: s.geminiOutputInrPerMillion ?? envFallback.geminiOutputInrPerMillion ?? null,
  };
}

export async function setCostSettings(db: Db, s: CostSettings, actor: string): Promise<void> {
  const parsed = costSettingsSchema.parse(s);
  await db
    .insert(appSettings)
    .values({ key: COST_KEY, value: parsed, updatedBy: actor })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: parsed, updatedAt: new Date(), updatedBy: actor } });
  await db.insert(auditEvents).values({ actor, action: "settings.cost_settings.updated", entityType: "app_settings", entityId: COST_KEY, detail: parsed });
}
