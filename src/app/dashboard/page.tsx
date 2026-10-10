import Link from "next/link";
import { BarList, FunnelChart, TrendChart } from "@/components/charts";
import { Filters, parseScope } from "@/components/filters";
import { DispositionBadge, Empty, INTEGRATION_LABELS, ModeBadge, PageHeader, Section, Stat, StatusPill, fmtDuration, fmtInr, fmtMinutes, fmtPct } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { getOverview, resolveRange } from "@/lib/services/analytics";
import { formatDateTimeInZone } from "@/lib/time";

export const metadata = { title: "Overview" };
export const dynamic = "force-dynamic";

type SP = { range?: string; from?: string; to?: string; data?: string };

export default async function OverviewPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const range = resolveRange(sp);
  const scope = parseScope(sp.data);
  const o = await getOverview(await getDb(), range, scope);

  const c = o.calls;
  const withinTone = o.response.withinTargetPct === null ? undefined : o.response.withinTargetPct >= 99 ? "ok" : o.response.withinTargetPct >= 90 ? "warn" : "bad";
  const costKnown = o.cost.totalKnownInr !== null;
  const unhealthy = o.health.integrations.filter((i) => i.mode !== "live").length;

  return (
    <>
      <PageHeader eyebrow="Management" title="Overview">
        {range.fromIso} to {range.toIso} (India time). Every figure below comes from persisted records; estimates are labelled as such.
      </PageHeader>
      <Filters base="/dashboard" range={range} scope={scope} />

      {/* ---- volume and response ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-4 fade-rise-d2">
        <Stat label="Calls received" value={c.total} sub={c.inProgress ? `${c.inProgress} in progress` : `${c.repeat} repeat after a dropped call`} />
        <Stat label="Answered" value={c.answered} sub={c.total ? `${fmtPct((c.answered / c.total) * 100)} of calls` : undefined} tone={c.total && c.missed === 0 ? "ok" : undefined} />
        <Stat label="Missed" value={c.missed} sub="ended without the agent answering" tone={c.missed ? "bad" : undefined} />
        <Stat label="After hours" value={c.afterHours} sub={c.afterHoursPct === null ? undefined : `${fmtPct(c.afterHoursPct)} of calls (brief: ~33%)`} />
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8 fade-rise-d2">
        <Stat label="Answered within 5 min" value={fmtPct(o.response.withinTargetPct)} sub="target: 100% (measured, not assumed)" tone={withinTone} hint="Share of calls answered within five minutes of ringing, counting unanswered calls as misses." />
        <Stat label="Median answer time" value={fmtDuration(o.response.medianSec)} sub={`90th percentile ${fmtDuration(o.response.p90Sec)}`} />
        <Stat label="Human follow-ups open" value={o.humanFollowUp.open} sub={`${o.humanFollowUp.acknowledged} acknowledged, ${o.humanFollowUp.resolved} resolved`} tone={o.humanFollowUp.open ? "warn" : undefined} />
        <Stat label="Median time to acknowledge" value={fmtMinutes(o.humanFollowUp.medianAckMinutes)} sub="escalation raised to acknowledged" />
      </div>

      {/* ---- outcomes ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-8">
        <Stat label="Qualified" value={o.outcomes.qualified} tone="ok" />
        <Stat label="Declined" value={o.outcomes.rejected} />
        <Stat label="Still unclear" value={o.outcomes.clarification} />
        <Stat label="Escalated" value={o.outcomes.escalated} tone={o.outcomes.escalated ? "warn" : undefined} />
        <Stat label="Consultations booked" value={o.bookings.confirmed} sub={o.bookings.attempts ? `${o.bookings.attempts} attempts, ${o.bookings.failed + o.bookings.unconfirmed} failed/unconfirmed` : "no attempts yet"} tone={o.bookings.confirmed ? "ok" : undefined} />
      </div>

      <div className="grid lg:grid-cols-[1.4fr_1fr] gap-6 mb-6">
        <Section title="Calls, qualified leads and bookings by day" hint="Daily counts in India time.">
          <TrendChart data={o.trend} />
        </Section>
        <Section title="Qualification funnel" hint="Each bar is a count of calls or enquiries; the percentage is relative to the step above.">
          <FunnelChart steps={o.funnel} />
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        <Section title="Answer-time distribution" hint="Time from the call arriving to the agent picking up. The five-minute target is the last bucket boundary.">
          <BarList items={o.response.buckets.map((b) => ({ label: b.label, value: b.count, tone: b.label === "not answered" || b.label === "over 5 min" ? "var(--bad)" : "var(--chart-1)" }))} empty="No calls in this period." />
        </Section>
        <Section title="Why enquiries were declined" hint="Criterion-level reasons from the qualification rules.">
          <BarList items={o.rejectionReasons.map((r) => ({ label: r.label, value: r.count }))} tone="var(--chart-2)" empty="No declined enquiries in this period." />
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        <Section title="Bookings and failures">
          <dl className="grid grid-cols-2 gap-y-3 text-[14px]">
            <dt className="text-muted">Confirmed in Calendly</dt><dd className="num text-right font-medium">{o.bookings.confirmed}</dd>
            <dt className="text-muted">Slot taken before booking</dt><dd className="num text-right">{o.bookings.slotTaken}</dd>
            <dt className="text-muted">Failed</dt><dd className="num text-right">{o.bookings.failed}</dd>
            <dt className="text-muted">Unconfirmed (needs a human check)</dt><dd className="num text-right">{o.bookings.unconfirmed}</dd>
            <dt className="text-muted">Failure rate</dt><dd className="num text-right">{fmtPct(o.bookings.failureRatePct, 1)}</dd>
          </dl>
          <p className="text-[13px] text-muted mt-4 border-t hairline pt-3">
            <strong className="font-medium text-ink">Lead-to-project conversion: not tracked yet.</strong> It needs HubSpot deal stages to be kept up to date by the sales team;
            this system records enquiries, qualification and bookings but will not invent a conversion figure.
          </p>
        </Section>
        <Section title="Escalations by reason" right={<Link href="/dashboard/exceptions" className="btn btn-ghost btn-sm">Open exceptions</Link>}>
          <BarList items={o.escalationsByKind.map((e) => ({ label: e.kind.replace(/_/g, " "), value: e.count }))} tone="var(--chart-5)" empty="No escalations in this period." />
        </Section>
      </div>

      {/* ---- cost ---- */}
      <Section
        title="Running cost"
        hint="Measured, configured-rate and fixed figures are kept apart. A figure appears only if a real source exists - nothing here is a guess."
        right={<Link href="/dashboard/settings#costs" className="btn btn-ghost btn-sm">Configure rates</Link>}
      >
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <Stat label="Total known cost" value={fmtInr(o.cost.totalKnownInr)} sub={costKnown ? "sum of the lines below" : "no cost data configured yet"} />
          <Stat label="Cost per call" value={fmtInr(o.cost.perCallInr)} sub={`over ${c.total} calls`} />
          <Stat label="Cost per qualified lead" value={fmtInr(o.cost.perQualifiedInr)} sub={`over ${o.outcomes.qualified} qualified`} />
          <Stat label="Cost per booked consultation" value={o.cost.totalKnownInr !== null && o.bookings.confirmed ? fmtInr(o.cost.totalKnownInr / o.bookings.confirmed) : "n/a"} sub={`over ${o.bookings.confirmed} bookings`} />
        </div>
        <div className="table-wrap mt-5">
          <table className="data">
            <thead><tr><th>Source</th><th>Basis</th><th className="text-right">INR</th></tr></thead>
            <tbody>
              <tr><td>Provider-reported usage (Vaani calls)</td><td><StatusPill tone="ok">measured</StatusPill></td><td className="num text-right">{fmtInr(o.cost.measuredInr)}</td></tr>
              <tr><td>Usage x configured rate (Gemini tokens)</td><td><StatusPill tone="info">configured rate</StatusPill></td><td className="num text-right">{fmtInr(o.cost.configuredRateInr)}</td></tr>
              <tr><td>Fixed monthly costs, prorated (seats, number rental, hosting...)</td><td><StatusPill tone="info">configured</StatusPill></td><td className="num text-right">{fmtInr(o.cost.fixedConfiguredInr)}</td></tr>
            </tbody>
          </table>
        </div>
        {o.cost.unpricedUsage.length > 0 && (
          <p className="text-[13px] text-muted mt-4">
            <strong className="font-medium text-ink">Usage recorded but not priced:</strong>{" "}
            {o.cost.unpricedUsage.map((u) => `${u.provider} ${u.metric.replace(/_/g, " ")} (${Number(u.quantity).toLocaleString("en-IN", { maximumFractionDigits: 1 })} ${u.unit})`).join("; ")}. Add the rate in Settings to include it.
          </p>
        )}
      </Section>

      {/* ---- recent calls and health ---- */}
      <div className="grid lg:grid-cols-[1.6fr_1fr] gap-6 mt-6">
        <Section title="Recent calls" right={<Link href="/dashboard/enquiries" className="btn btn-ghost btn-sm">All enquiries</Link>}>
          {o.recentCalls.length === 0 ? (
            <Empty title="No calls yet">Calls appear here as soon as the Vaani agent answers one.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When (IST)</th><th>Caller</th><th>Outcome</th><th className="text-right">Score</th></tr></thead>
                <tbody>
                  {o.recentCalls.map((r) => (
                    <tr key={r.id}>
                      <td className="whitespace-nowrap">
                        {formatDateTimeInZone(new Date(r.at)).replace(/ \(.*\)$/, "")}
                        {r.afterHours && <span className="badge badge-neutral ml-2">after hours</span>}
                      </td>
                      <td>
                        {r.enquiryId ? <Link href={`/dashboard/enquiries/${r.enquiryId}`} className="underline underline-offset-4 decoration-border-strong">{r.name ?? r.phone ?? "Unknown caller"}</Link> : (r.name ?? r.phone ?? "Unknown caller")}
                        <span className="ml-2"><ModeBadge mode={r.mode} /></span>
                        {!r.answered && <span className="badge badge-bad ml-2">not answered</span>}
                      </td>
                      <td><DispositionBadge value={r.disposition} /></td>
                      <td className="num text-right">{r.score ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Integration health" right={<Link href="/dashboard/integrations" className="btn btn-ghost btn-sm">Details</Link>}>
          <ul className="flex flex-col gap-2.5 text-[14px]">
            {o.health.integrations.map((i) => (
              <li key={i.name} className="flex items-center justify-between gap-3">
                <span>{INTEGRATION_LABELS[i.name] ?? i.name}</span>
                <span className="flex items-center gap-2">
                  {i.failures24h > 0 && <span className="badge badge-bad">{i.failures24h} failed (24h)</span>}
                  <StatusPill tone={i.mode === "live" ? "ok" : i.mode === "mock" ? "warn" : "bad"}>{i.mode === "live" ? "live" : i.mode === "mock" ? "simulated" : "not configured"}</StatusPill>
                </span>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted mt-4 border-t hairline pt-3">
            Background jobs: {o.health.outbox.pending} pending, {o.health.outbox.failed} retrying, {o.health.outbox.dead} dead. Emails (24h): {o.health.notifications.sent} sent, {o.health.notifications.failed} failed.
            {unhealthy > 0 && ` ${unhealthy} integration${unhealthy === 1 ? " is" : "s are"} not live.`}
          </p>
        </Section>
      </div>

      <p className="text-[12px] text-subtle mt-8 max-w-3xl">
        Baselines from the case brief (~200 enquiries a month, ~48% unanswered within 48 hours, ~33% outside 10 am - 7 pm, and a 4x conversion advantage for answers within an hour) were reported by
        Aangan; they are context, not measurements made by this system.
      </p>
    </>
  );
}
