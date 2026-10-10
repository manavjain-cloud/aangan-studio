import { and, gte, inArray, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { fixedCosts, usageRecords, type DataMode } from "../db/schema";
import type { CostSettings } from "./settings";

/**
 * Cost bookkeeping. Every record states its basis:
 *  - measured         : the provider reported the cost itself (and, for Vaani, a credit->INR rate was configured).
 *  - configured_rate  : usage was measured (e.g. tokens) and priced with a rate management configured.
 *  - unknown          : usage was measured but no rate is configured. Cost stays NULL; nothing is invented.
 */

export async function recordUsage(
  db: Db,
  r: {
    dedupeKey: string;
    provider: "vaani" | "gemini" | "calendly" | "hubspot" | "email" | "neon";
    metric: string;
    quantity: number;
    unit: string;
    costInr: number | null;
    costBasis: "measured" | "configured_rate" | "unknown";
    callId?: string | null;
    mode: DataMode;
    meta?: Record<string, unknown>;
    occurredAt?: Date;
  },
): Promise<void> {
  await db
    .insert(usageRecords)
    .values({
      dedupeKey: r.dedupeKey, provider: r.provider, metric: r.metric, quantity: String(r.quantity), unit: r.unit,
      costInr: r.costInr === null ? null : String(r.costInr), costBasis: r.costBasis, callId: r.callId ?? null, mode: r.mode,
      meta: r.meta ?? {}, ...(r.occurredAt ? { occurredAt: r.occurredAt } : {}),
    })
    .onConflictDoNothing({ target: usageRecords.dedupeKey });
}

export async function recordGeminiUsage(
  db: Db,
  input: { callId: string; model: string; inputTokens: number; outputTokens: number; settings: CostSettings; mode: DataMode; dedupe: string },
) {
  const { inputTokens, outputTokens, settings } = input;
  const priced = settings.geminiInputInrPerMillion !== null && settings.geminiOutputInrPerMillion !== null;
  const cost = priced ? (inputTokens / 1e6) * settings.geminiInputInrPerMillion! + (outputTokens / 1e6) * settings.geminiOutputInrPerMillion! : null;
  await recordUsage(db, {
    dedupeKey: `gemini:${input.dedupe}`, provider: "gemini", metric: "tokens", quantity: inputTokens + outputTokens, unit: "tokens",
    costInr: cost, costBasis: priced ? "configured_rate" : "unknown", callId: input.callId, mode: input.mode,
    meta: { model: input.model, inputTokens, outputTokens },
  });
}

export async function recordVaaniUsage(
  db: Db,
  input: { callId: string; vaaniCallId: string; credits: number | null; durationMs: number | null; settings: CostSettings; mode: DataMode },
) {
  if (input.durationMs !== null) {
    await recordUsage(db, {
      dedupeKey: `vaani:minutes:${input.vaaniCallId}`, provider: "vaani", metric: "call_minutes", quantity: input.durationMs / 60_000, unit: "minutes",
      costInr: null, costBasis: "unknown", callId: input.callId, mode: input.mode,
    });
  }
  if (input.credits !== null) {
    const rate = input.settings.vaaniCreditInr;
    await recordUsage(db, {
      dedupeKey: `vaani:credits:${input.vaaniCallId}`, provider: "vaani", metric: "credits", quantity: input.credits, unit: "credits",
      costInr: rate !== null ? input.credits * rate : null, costBasis: rate !== null ? "measured" : "unknown", callId: input.callId, mode: input.mode,
    });
  }
}

export interface CostSummary {
  /** INR figures by basis. null = nothing of that kind available. */
  measuredInr: number | null;
  configuredRateInr: number | null;
  fixedConfiguredInr: number | null;
  totalKnownInr: number | null;
  unpricedUsage: Array<{ provider: string; metric: string; quantity: number; unit: string }>;
  byProvider: Array<{ provider: string; inr: number }>;
}

export async function costSummary(db: Db, from: Date, to: Date, modes: DataMode[]): Promise<CostSummary> {
  const rows = await db
    .select({
      provider: usageRecords.provider, metric: usageRecords.metric, unit: usageRecords.unit, basis: usageRecords.costBasis,
      qty: sql<string>`coalesce(sum(${usageRecords.quantity}), 0)`, cost: sql<string | null>`sum(${usageRecords.costInr})`,
    })
    .from(usageRecords)
    .where(and(gte(usageRecords.occurredAt, from), lt(usageRecords.occurredAt, to), inArray(usageRecords.mode, modes)))
    .groupBy(usageRecords.provider, usageRecords.metric, usageRecords.unit, usageRecords.costBasis);

  let measured: number | null = null;
  let configured: number | null = null;
  const unpriced: CostSummary["unpricedUsage"] = [];
  const byProvider = new Map<string, number>();
  for (const r of rows) {
    const cost = r.cost === null ? null : Number(r.cost);
    if (r.basis === "measured" && cost !== null) measured = (measured ?? 0) + cost;
    else if (r.basis === "configured_rate" && cost !== null) configured = (configured ?? 0) + cost;
    else if (cost === null) unpriced.push({ provider: r.provider, metric: r.metric, quantity: Number(r.qty), unit: r.unit });
    if (cost !== null) byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + cost);
  }

  // Fixed monthly costs, prorated by days in the window (labelled "configured" - never presented as measured).
  const fixed = await db.select().from(fixedCosts);
  let fixedTotal: number | null = null;
  for (const f of fixed) {
    const start = new Date(`${f.activeFrom}T00:00:00Z`);
    const end = f.activeTo ? new Date(`${f.activeTo}T00:00:00Z`) : null;
    const s = Math.max(start.getTime(), from.getTime());
    const e = Math.min(end?.getTime() ?? to.getTime(), to.getTime());
    if (e <= s) continue;
    const share = (e - s) / 86_400_000 / 30.4375;
    const amt = Number(f.monthlyInr) * share;
    fixedTotal = (fixedTotal ?? 0) + amt;
    byProvider.set(f.provider, (byProvider.get(f.provider) ?? 0) + amt);
  }

  const parts = [measured, configured, fixedTotal].filter((x): x is number => x !== null);
  return {
    measuredInr: measured,
    configuredRateInr: configured,
    fixedConfiguredInr: fixedTotal,
    totalKnownInr: parts.length ? parts.reduce((a, b) => a + b, 0) : null,
    unpricedUsage: unpriced,
    byProvider: [...byProvider.entries()].map(([provider, inr]) => ({ provider, inr })),
  };
}

