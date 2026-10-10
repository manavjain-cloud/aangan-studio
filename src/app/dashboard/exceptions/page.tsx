import Link from "next/link";
import { ackEscalationAction, assignEscalationAction, resolveEscalationAction } from "@/app/actions/dashboard";
import { Filters, buildHref, parseScope } from "@/components/filters";
import { Empty, ModeBadge, PageHeader, Section, StatusPill } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { resolveRange } from "@/lib/services/analytics";
import { getExceptions } from "@/lib/services/exceptions";
import { formatDateTimeInZone } from "@/lib/time";

export const metadata = { title: "Exceptions" };
export const dynamic = "force-dynamic";

type SP = { range?: string; from?: string; to?: string; data?: string; show?: string };

const KIND_LABEL: Record<string, string> = {
  existing_customer_complaint: "Existing-customer complaint",
  frustrated_returning_lead: "Frustrated returning lead",
  senior_requested: "Senior person requested",
  borderline_review: "Human decision needed",
  booking_failure: "Booking failure",
  integration_failure: "Integration failure",
  compliance_flag: "Compliance flag",
  post_call_review: "Post-call review",
  other: "Other",
};

export default async function ExceptionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const scope = parseScope(sp.data);
  const range = resolveRange(sp);
  const showAll = sp.show === "all";
  const ex = await getExceptions(await getDb(), scope, showAll ? "all" : "active");

  return (
    <>
      <PageHeader eyebrow="Needs a human" title="Exceptions">
        Complaints, borderline decisions, booking failures and unfinished enquiries. These are also emailed to the responsible person &mdash; this page tracks status and ownership, it is not another alert channel.
      </PageHeader>
      <Filters base="/dashboard/exceptions" range={range} scope={scope} extra={{ show: sp.show }} />

      <div className="flex gap-2 mb-5">
        <Link className={`btn btn-sm ${!showAll ? "btn-primary" : "btn-ghost"}`} href={buildHref("/dashboard/exceptions", { data: scope === "all" ? undefined : scope })}>Open and acknowledged</Link>
        <Link className={`btn btn-sm ${showAll ? "btn-primary" : "btn-ghost"}`} href={buildHref("/dashboard/exceptions", { show: "all", data: scope === "all" ? undefined : scope })}>Include resolved</Link>
      </div>

      <div className="flex flex-col gap-6">
        <Section title="Escalations" hint="Raised by the voice agent, the qualification rules or post-call checks.">
          {ex.escRows.length === 0 ? (
            <Empty title="All clear">No {showAll ? "" : "open "}escalations.</Empty>
          ) : (
            <ul className="flex flex-col divide-y hairline">
              {ex.escRows.map(({ e, enq, c, owner }) => (
                <li key={e.id} className="py-5 first:pt-0 last:pb-0 grid gap-4 lg:grid-cols-[1.4fr_1fr]">
                  <div>
                    <div className="flex flex-wrap items-center gap-2 mb-2">
                      <StatusPill tone={e.status === "resolved" ? "ok" : e.status === "acknowledged" ? "info" : e.urgency === "high" ? "bad" : "warn"}>{e.status}</StatusPill>
                      {e.urgency === "high" && e.status !== "resolved" && <StatusPill tone="bad">urgent</StatusPill>}
                      <span className="font-medium">{KIND_LABEL[e.kind] ?? e.kind}</span>
                      <ModeBadge mode={e.mode} />
                    </div>
                    <p className="text-[14px] text-muted">{e.reason}</p>
                    <p className="text-[13px] mt-2">
                      {enq ? <Link href={`/dashboard/enquiries/${enq.id}`} className="underline underline-offset-4 decoration-border-strong">{c?.name ?? enq.facts.caller_name ?? c?.phoneE164 ?? "Unknown caller"}</Link> : "No linked enquiry"}
                      <span className="text-subtle"> &middot; raised {formatDateTimeInZone(e.createdAt).replace(/ \(.*\)$/, "")}</span>
                      {e.acknowledgedAt && <span className="text-subtle"> &middot; acknowledged {formatDateTimeInZone(e.acknowledgedAt).replace(/ \(.*\)$/, "")}</span>}
                    </p>
                    {e.requestedResponse && <p className="text-[13px] text-subtle mt-1">Requested: {e.requestedResponse}</p>}
                    {e.resolutionNote && <p className="text-[13px] mt-1"><strong className="font-medium">Resolution:</strong> {e.resolutionNote}</p>}
                  </div>
                  {e.status !== "resolved" && (
                    <div className="flex flex-col gap-3">
                      <form action={assignEscalationAction} className="flex gap-2 items-end">
                        <input type="hidden" name="id" value={e.id} />
                        <div className="grow">
                          <label className="label" htmlFor={`own-${e.id}`}>Owner</label>
                          <select id={`own-${e.id}`} name="memberId" defaultValue={owner?.id ?? ""} className="field !h-[38px] !text-[14px]">
                            <option value="">Unassigned</option>
                            {ex.team.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role.replace("_", " ")})</option>)}
                          </select>
                        </div>
                        <button className="btn btn-ghost btn-sm" type="submit">Assign</button>
                      </form>
                      {e.status === "open" && (
                        <form action={ackEscalationAction}><input type="hidden" name="id" value={e.id} /><button className="btn btn-ghost btn-sm" type="submit">Mark acknowledged</button></form>
                      )}
                      <form action={resolveEscalationAction} className="flex gap-2 items-end">
                        <input type="hidden" name="id" value={e.id} />
                        <div className="grow">
                          <label className="label" htmlFor={`res-${e.id}`}>Resolution note</label>
                          <input id={`res-${e.id}`} name="note" required minLength={3} maxLength={800} className="field !h-[38px] !text-[14px]" placeholder="What was done?" />
                        </div>
                        <button className="btn btn-primary btn-sm" type="submit">Resolve</button>
                      </form>
                    </div>
                  )}
                  {e.status === "resolved" && owner && <p className="text-[13px] text-muted">Owner: {owner.name}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>

        <Section title="Booking failures" hint="Qualified callers whose consultation could not be confirmed. An email has been sent to the front desk and senior team.">
          {ex.failedBookings.length === 0 ? <p className="text-sm text-muted">None.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Caller</th><th>Status</th><th>Detail</th></tr></thead>
                <tbody>
                  {ex.failedBookings.map(({ a, enq, c }) => (
                    <tr key={a.id}>
                      <td className="whitespace-nowrap">{formatDateTimeInZone(a.createdAt).replace(/ \(.*\)$/, "")}</td>
                      <td>{enq ? <Link className="underline underline-offset-4 decoration-border-strong" href={`/dashboard/enquiries/${enq.id}`}>{c?.name ?? enq.facts.caller_name ?? c?.phoneE164 ?? "Unknown"}</Link> : "-"} <ModeBadge mode={a.mode} /></td>
                      <td><StatusPill tone="bad">{a.status}</StatusPill></td>
                      <td className="text-muted">{a.error ?? "-"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>

        <Section title="Unclear enquiries" hint="The call ended before criteria 1-3 (project, location, timeline) could be settled. The front desk is emailed to call back when a number is known.">
          {ex.uncertainRows.length === 0 ? <p className="text-sm text-muted">None.</p> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>When</th><th>Caller</th><th>Known so far</th></tr></thead>
                <tbody>
                  {ex.uncertainRows.map(({ enq, c, call }) => (
                    <tr key={enq.id}>
                      <td className="whitespace-nowrap">{formatDateTimeInZone(call.receivedAt).replace(/ \(.*\)$/, "")}</td>
                      <td><Link className="underline underline-offset-4 decoration-border-strong" href={`/dashboard/enquiries/${enq.id}`}>{c?.name ?? enq.facts.caller_name ?? c?.phoneE164 ?? "Unknown"}</Link> <ModeBadge mode={enq.mode} /></td>
                      <td className="text-muted">{[enq.facts.location_text, enq.facts.scope?.replace(/_/g, " "), enq.facts.bhk ? `${enq.facts.bhk}BHK` : null].filter(Boolean).join(" · ") || "Nothing captured"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Section>
      </div>
    </>
  );
}
