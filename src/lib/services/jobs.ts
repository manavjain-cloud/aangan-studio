import type { Db } from "../db/client";
import { createLogger } from "../logging/logger";
import { reconcileAttempt } from "./booking";
import { hubspotSyncJob } from "./hubspot-sync";
import { sendEmailJob } from "./notifications";
import { PermanentJobError, enqueue, runDueJobs, type JobContext, type JobHandler, type JobType, type RunSummary } from "./outbox";
import { postcallEnrichJob } from "./postcall";

const log = createLogger("jobs");

/** On a job's final failure, alert ops by email once (never from an email job itself, to avoid loops). */
function withOpsAlert(type: JobType, handler: JobHandler): JobHandler {
  return async (ctx: JobContext) => {
    try {
      await handler(ctx);
    } catch (err) {
      const permanent = err instanceof PermanentJobError;
      if ((ctx.isFinalAttempt || permanent) && type !== "send_email") {
        await enqueue(ctx.db, {
          type: "send_email", key: `email:ops:job:${ctx.job.id}`,
          payload: { kind: "ops_alert", title: `Background job failed permanently: ${type}`, detail: `${String((err as Error).message).slice(0, 400)} (job ${ctx.job.id}, ${ctx.job.attempts} attempts).` },
        }).catch((e) => log.error("could not enqueue ops alert", { error: String(e) }));
      }
      throw err;
    }
  };
}

const reconcileJob: JobHandler = async ({ db, job }) => {
  const attemptId = job.payload.attemptId;
  if (typeof attemptId !== "string") throw new PermanentJobError("booking_reconcile requires attemptId");
  const r = await reconcileAttempt(db, attemptId);
  if (r === "still_unknown") throw new Error("booking still not visible in Calendly; will check again");
};

export const HANDLERS: Record<JobType, JobHandler> = {
  hubspot_sync: withOpsAlert("hubspot_sync", hubspotSyncJob),
  send_email: sendEmailJob,
  postcall_enrich: withOpsAlert("postcall_enrich", postcallEnrichJob),
  booking_reconcile: withOpsAlert("booking_reconcile", reconcileJob),
};

/** Drain due jobs. Called after requests (via after()) and by the cron endpoint. */
export async function processOutbox(db: Db, limit = 10, rounds = 3): Promise<RunSummary> {
  const total: RunSummary = { claimed: 0, done: 0, retried: 0, dead: 0 };
  for (let i = 0; i < rounds; i++) {
    const s = await runDueJobs(db, HANDLERS, limit);
    total.claimed += s.claimed;
    total.done += s.done;
    total.retried += s.retried;
    total.dead += s.dead;
    if (s.claimed === 0) break;
  }
  return total;
}
