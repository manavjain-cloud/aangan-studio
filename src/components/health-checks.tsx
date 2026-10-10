"use client";

import { useState, useTransition } from "react";
import { runHealthChecks, runJobsNowAction, type HealthResult } from "@/app/actions/dashboard";
import { INTEGRATION_LABELS, StatusPill } from "@/components/ui";

export function HealthChecks() {
  const [results, setResults] = useState<HealthResult[] | null>(null);
  const [jobs, setJobs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                setResults(await runHealthChecks());
              } catch (e) {
                setError((e as Error).message);
              }
            })
          }
        >
          {pending ? "Checking..." : "Run health checks"}
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              try {
                const r = await runJobsNowAction();
                setJobs(`${r.claimed} job(s) picked up: ${r.done} done, ${r.retried} will retry, ${r.dead} dead.`);
              } catch (e) {
                setError((e as Error).message);
              }
            })
          }
        >
          Retry background jobs now
        </button>
      </div>
      <div aria-live="polite">
        {error && <p className="badge badge-bad !h-auto !py-2 !whitespace-normal">{error}</p>}
        {jobs && <p className="text-[13px] text-muted">{jobs}</p>}
        {results && (
          <ul className="flex flex-col gap-2 mt-2">
            {results.map((r) => (
              <li key={r.name} className="flex flex-wrap items-center gap-3 text-[14px]">
                <span className="w-20 font-medium">{INTEGRATION_LABELS[r.name] ?? r.name}</span>
                {r.ok === null ? <StatusPill tone="warn">not live</StatusPill> : r.ok ? <StatusPill tone="ok">OK</StatusPill> : <StatusPill tone="bad">failing</StatusPill>}
                <span className="text-muted text-[13px]">{r.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
