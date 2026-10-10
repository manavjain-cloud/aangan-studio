import Link from "next/link";
import type { DashboardRange, DataScope } from "@/lib/services/analytics";

const PRESETS: Array<[string, string]> = [
  ["today", "Today"],
  ["7d", "7 days"],
  ["30d", "30 days"],
  ["90d", "90 days"],
  ["mtd", "Month to date"],
];

const SCOPES: Array<[DataScope, string]> = [
  ["all", "All data"],
  ["live", "Live only"],
  ["simulated", "Simulated / sample"],
];

export function buildHref(base: string, params: Record<string, string | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}

/** Date range + data-scope controls. Pure links and a GET form: works without client JS and is shareable. */
export function Filters({ base, range, scope, extra = {} }: { base: string; range: DashboardRange; scope: DataScope; extra?: Record<string, string | undefined> }) {
  const pill = (active: boolean) =>
    `btn btn-sm ${active ? "btn-primary" : "btn-ghost"}`;
  return (
    <div className="flex flex-col gap-3 mb-6">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Date range">
        {PRESETS.map(([key, label]) => (
          <Link key={key} href={buildHref(base, { ...extra, range: key, data: scope === "all" ? undefined : scope })} className={pill(range.preset === key)} aria-current={range.preset === key ? "true" : undefined}>
            {label}
          </Link>
        ))}
        <form action={base} method="get" className="flex flex-wrap items-center gap-2 ml-0 md:ml-3">
          {Object.entries(extra).map(([k, v]) => (v ? <input key={k} type="hidden" name={k} value={v} /> : null))}
          {scope !== "all" && <input type="hidden" name="data" value={scope} />}
          <label className="sr-only" htmlFor="f-from">From</label>
          <input id="f-from" name="from" type="date" defaultValue={range.fromIso} className="field !h-[34px] !w-[150px] !text-[13px]" />
          <span className="text-subtle text-sm">to</span>
          <label className="sr-only" htmlFor="f-to">To</label>
          <input id="f-to" name="to" type="date" defaultValue={range.toIso} className="field !h-[34px] !w-[150px] !text-[13px]" />
          <button type="submit" className="btn btn-ghost btn-sm">Apply</button>
        </form>
      </div>
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Data scope">
        <span className="text-[12px] uppercase tracking-[0.1em] text-subtle mr-1">Data</span>
        {SCOPES.map(([key, label]) => (
          <Link
            key={key}
            href={buildHref(base, { ...extra, ...(range.preset === "custom" ? { from: range.fromIso, to: range.toIso } : { range: range.preset }), data: key === "all" ? undefined : key })}
            className={pill(scope === key)}
            aria-current={scope === key ? "true" : undefined}
          >
            {label}
          </Link>
        ))}
      </div>
    </div>
  );
}

export function parseScope(v: string | undefined): DataScope {
  return v === "live" || v === "simulated" ? v : "all";
}
