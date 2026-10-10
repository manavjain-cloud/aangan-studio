import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { integrationEvents, outboxJobs } from "../db/schema";
import { createLogger } from "../logging/logger";
import { redactString } from "../logging/redact";

const log = createLogger("outbox");

export type JobType = "hubspot_sync" | "send_email" | "postcall_enrich" | "booking_reconcile";

export interface JobContext {
  db: Db;
  job: { id: string; type: JobType; payload: Record<string, unknown>; attempts: number; maxAttempts: number };
  isFinalAttempt: boolean;
}

export type JobHandler = (ctx: JobContext) => Promise<void>;

/** Throw from a handler to stop retrying (bad payload, record deleted...). */
export class PermanentJobError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentJobError";
  }
}

/**
 * Durable outbox: every external side effect (HubSpot write, email, post-call enrichment, booking reconcile)
 * is a job with a unique idempotency key. Enqueueing the same key twice is a no-op, so retried webhooks and
 * repeated tool calls cannot create duplicate CRM writes or emails.
 */
export async function enqueue(
  db: Db,
  job: { type: JobType; key: string; payload: Record<string, unknown>; delaySec?: number; maxAttempts?: number },
): Promise<{ id: string | null; created: boolean }> {
  const rows = await db
    .insert(outboxJobs)
    .values({
      type: job.type,
      idempotencyKey: job.key,
      payload: job.payload,
      nextAttemptAt: new Date(Date.now() + (job.delaySec ?? 0) * 1000),
      ...(job.maxAttempts ? { maxAttempts: job.maxAttempts } : {}),
    })
    .onConflictDoNothing({ target: outboxJobs.idempotencyKey })
    .returning({ id: outboxJobs.id });
  return { id: rows[0]?.id ?? null, created: rows.length > 0 };
}

interface ClaimedRow {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

async function claim(db: Db, limit: number): Promise<ClaimedRow[]> {
  const res = await db.execute(sql`
    UPDATE outbox_jobs
       SET status = 'running', locked_at = now(), attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM outbox_jobs
        WHERE (status IN ('pending','failed') AND next_attempt_at <= now())
           OR (status = 'running' AND locked_at < now() - interval '5 minutes')
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
    RETURNING id, type, payload, attempts, max_attempts`);
  return ((res as unknown as { rows: ClaimedRow[] }).rows ?? []) as ClaimedRow[];
}

export function backoffSeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 30 * 60);
}

export interface RunSummary {
  claimed: number;
  done: number;
  retried: number;
  dead: number;
}

export async function runDueJobs(db: Db, handlers: Partial<Record<JobType, JobHandler>>, limit = 10): Promise<RunSummary> {
  const rows = await claim(db, limit);
  const summary: RunSummary = { claimed: rows.length, done: 0, retried: 0, dead: 0 };

  for (const row of rows) {
    const handler = handlers[row.type];
    const isFinalAttempt = row.attempts >= row.max_attempts;
    try {
      if (!handler) throw new PermanentJobError(`no handler registered for job type ${row.type}`);
      await handler({ db, job: { id: row.id, type: row.type, payload: row.payload, attempts: row.attempts, maxAttempts: row.max_attempts }, isFinalAttempt });
      await db.execute(sql`UPDATE outbox_jobs SET status = 'done', done_at = now(), last_error = NULL WHERE id = ${row.id}`);
      summary.done++;
    } catch (err) {
      const message = redactString(String((err as Error)?.message ?? err)).slice(0, 500);
      const permanent = err instanceof PermanentJobError;
      if (permanent || isFinalAttempt) {
        await db.execute(sql`UPDATE outbox_jobs SET status = 'dead', last_error = ${message} WHERE id = ${row.id}`);
        await db.insert(integrationEvents).values({
          integration: "outbox", direction: "outbound", eventType: `job_dead:${row.type}`, status: "failed", error: message,
          payload: { jobId: row.id, attempts: row.attempts },
        });
        log.error("job dead", { jobId: row.id, type: row.type, error: message });
        summary.dead++;
      } else {
        const delay = backoffSeconds(row.attempts);
        await db.execute(
          sql`UPDATE outbox_jobs SET status = 'failed', last_error = ${message}, next_attempt_at = now() + (${delay} * interval '1 second') WHERE id = ${row.id}`,
        );
        log.warn("job failed, will retry", { jobId: row.id, type: row.type, attempt: row.attempts, retryInSec: delay, error: message });
        summary.retried++;
      }
    }
  }
  return summary;
}
