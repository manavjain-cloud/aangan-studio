import { and, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { rateLimitCounters } from "../db/schema";

/**
 * Fixed-window rate limiter backed by the database, so the limit holds across serverless instances.
 * One atomic upsert per check; stale windows are pruned opportunistically.
 */
export async function checkRateLimit(
  db: Db,
  key: string,
  limit: number,
  windowSec: number,
  now: Date = new Date(),
): Promise<{ allowed: boolean; count: number; retryAfterSec: number }> {
  const windowMs = windowSec * 1000;
  const windowStart = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
  const rows = await db
    .insert(rateLimitCounters)
    .values({ key, windowStart, count: 1 })
    .onConflictDoUpdate({
      target: [rateLimitCounters.key, rateLimitCounters.windowStart],
      set: { count: sql`${rateLimitCounters.count} + 1` },
    })
    .returning({ count: rateLimitCounters.count });
  const count = rows[0]?.count ?? 1;

  if (Math.random() < 0.02) {
    await db
      .delete(rateLimitCounters)
      .where(and(lt(rateLimitCounters.windowStart, new Date(now.getTime() - 3600_000))))
      .catch(() => undefined);
  }
  const retryAfterSec = Math.max(1, Math.ceil((windowStart.getTime() + windowMs - now.getTime()) / 1000));
  return { allowed: count <= limit, count, retryAfterSec };
}
