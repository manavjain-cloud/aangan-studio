import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { overrideDisposition } from "@/app/actions/dashboard";
import { DispositionBadge, ModeBadge, PageHeader, Section, StatusPill } from "@/components/ui";
import { requireViewer } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { CRITERION_LABELS, DISPOSITIONS, type CriterionStatus } from "@/lib/domain/types";
import { getLeadDetail } from "@/lib/services/lead-detail";
import { formatDateTimeInZone } from "@/lib/time";
import { z } from "zod";

export const metadata = { title: "Enquiry" };
export const dynamic = "force-dynamic";

const STATUS_TONE: Record<CriterionStatus, "ok" | "bad" | "warn" | "info" | "neutral"> = {
  pass: "ok", fail: "bad", unknown: "info", unknown_neutral: "neutral", human_review: "warn",
};
const STATUS_LABEL: Record<CriterionStatus, string> = {
  pass: "Pass", fail: "Fail", unknown: "Unclear", unknown_neutral: "Not discussed (neutral)", human_review: "Needs a human",
};

const FACT_LABELS: Record<string, string> = {
  caller_name: "Name", caller_email: "Email", project_type: "Project type", property_kind: "Property", service_intent: "Wants", scope: "Scope",
  rooms_count: "Rooms", rooms_description: "Rooms (detail)", bhk: "BHK", carpet_area_sqft: "Carpet area (sq ft)", location_text: "Location",
  site_condition: "Site condition", is_rented: "Rented", structural_changes_required: "Structural changes", desired_completion_date: "Needs completion by",
  timeline_flexible: "Flexible timeline", site_available_date: "Site available from", site_available_now: "Site available now", authority: "Decision-maker",
  decision_makers_will_attend: "Decision-makers will attend", budget_inr_min: "Volunteered budget (min, INR)", budget_inr_max: "Volunteered budget (max, INR)",
  budget_declined: "Declined to share budget", asked_about_pricing: "Asked about pricing", existing_customer_complaint: "Existing-customer complaint",
  requests_senior: "Asked for a senior person", caller_frustrated: "Frustrated", missed_followup: "Reports missed follow-up", availability_notes: "Availability", notes: "Notes",
};

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const admin = await requireViewer();
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) notFound();
  const d = await getLeadDetail(await getDb(), id);
  if (!d) notFound();

  const name = d.contact?.name ?? d.facts.caller_name ?? "Unknown caller";
  const q = d.qualification;
  const facts = Object.entries(d.facts).filter(([, v]) => v !== null && v !== false) as Array<[string, unknown]>;
  const transcript = d.transcripts[0]?.text ?? null;
  const tz = d.booking?.designerTimezone ?? d.booking?.customerTimezone ?? "Asia/Kolkata";

  return (
    <>
      <Link href="/dashboard/enquiries" className="inline-flex items-center gap-2 text-[13px] text-muted mb-5 hover:text-ink"><ArrowLeft size={14} aria-hidden /> All enquiries</Link>
      <PageHeader eyebrow="Enquiry" title={name}>
        <span className="flex flex-wrap items-center gap-2">
          <DispositionBadge value={d.enquiry.disposition} />
          <ModeBadge mode={d.enquiry.mode} />
          {d.enquiry.overridden && <StatusPill tone="neutral">decision overridden by a human</StatusPill>}
          <span className="text-muted">{d.contact?.phoneE164 ?? "no caller ID"}{d.contact?.email ? ` · ${d.contact.email}` : ""}</span>
        </span>
      </PageHeader>

      <div className="grid lg:grid-cols-[1.5fr_1fr] gap-6">
        <div className="flex flex-col gap-6">
          <Section
            title="Why this outcome"
            hint={q ? `Rules ${q.rulesVersion}, evaluation v${q.version} at ${formatDateTimeInZone(q.evaluatedAt)}. The score is a decision aid; it never overrides a failed criterion.` : "Not evaluated yet."}
            right={q ? <span className="num text-[28px] font-semibold">{q.score}<span className="text-subtle text-[14px] font-normal"> / 100</span></span> : null}
          >
            {q ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Criterion</th><th>Result</th><th className="text-right">Points</th><th>Evidence</th></tr></thead>
                  <tbody>
                    {q.criteria.map((c) => (
                      <tr key={c.criterion}>
                        <td className="font-medium whitespace-nowrap">{CRITERION_LABELS[c.criterion]}</td>
                        <td className="whitespace-nowrap">
                          <StatusPill tone={STATUS_TONE[c.status]}>{STATUS_LABEL[c.status]}</StatusPill>
                          {c.hardExclusion && <div className="text-[11px] text-bad mt-1 uppercase tracking-wide">hard exclusion</div>}
                        </td>
                        <td className="num text-right">{c.points}/{c.weight}</td>
                        <td className="text-muted">{c.evidence}{c.caveat && <div className="text-[13px] text-warn mt-1">Note: {c.caveat}</div>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="text-muted text-sm">The call ended before qualification was evaluated.</p>}
            {q?.nextQuestion && <p className="mt-4 text-sm"><strong className="font-medium">Question the agent was told to ask:</strong> {q.nextQuestion}</p>}
          </Section>

          <Section title="Call summary">
            <p className="text-[15px] leading-relaxed">{d.enquiry.summary ?? "Summary will appear once Vaani finishes post-processing the call."}</p>
            {d.enquiry.handoffNote && <p className="text-[14px] text-muted mt-4 border-t hairline pt-4"><strong className="font-medium text-ink">Handoff note:</strong> {d.enquiry.handoffNote}</p>}
          </Section>

          <Section title="Activity">
            <ol className="flex flex-col gap-2.5 text-[13.5px]">
              {d.events.filter((e) => e.type !== "call_created").map((e) => (
                <li key={e.id} className="grid grid-cols-[150px_1fr] gap-3">
                  <time className="text-subtle num" dateTime={e.occurredAt.toISOString()}>{formatDateTimeInZone(e.occurredAt).replace(/ \(.*\)$/, "").replace(/^\w+ /, "")}</time>
                  <span>
                    {e.type === "state_changed" ? <>State <span className="text-muted">{e.fromState?.replace(/_/g, " ")}</span> &rarr; <strong className="font-medium">{e.toState?.replace(/_/g, " ")}</strong></> : e.type.replace(/_/g, " ")}
                  </span>
                </li>
              ))}
              {d.events.length === 0 && <li className="text-muted">No events recorded.</li>}
            </ol>
          </Section>

          {transcript && (
            <Section title="Transcript" hint="Sensitive. Redacted of card-like numbers and keys; deleted automatically after the retention period.">
              <details>
                <summary className="btn btn-ghost btn-sm inline-flex">Show transcript</summary>
                <pre className="mt-4 whitespace-pre-wrap text-[13px] leading-relaxed text-muted font-sans max-h-[420px] overflow-auto">{transcript.slice(0, 12000)}</pre>
              </details>
            </Section>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <Section title="Consultation">
            {d.booking ? (
              <dl className="text-[14px] grid grid-cols-[110px_1fr] gap-y-2">
                <dt className="text-muted">When</dt><dd className="font-medium">{formatDateTimeInZone(d.booking.startTime, tz)}</dd>
                <dt className="text-muted">Designer</dt><dd>{d.designer?.name ?? "-"}</dd>
                <dt className="text-muted">Source</dt><dd>{d.booking.mode === "live" ? "Confirmed by Calendly" : <StatusPill tone="warn">Simulated - not a real booking</StatusPill>}</dd>
              </dl>
            ) : <p className="text-sm text-muted">{d.enquiry.disposition === "qualified" ? "Qualified but not booked on the call; the designer or front desk was emailed to arrange it." : "No booking (not applicable or not made)."}</p>}
            {d.attempts.length > 0 && (
              <div className="mt-4 border-t hairline pt-4">
                <p className="text-[12px] uppercase tracking-[0.1em] text-subtle mb-2">Booking attempts</p>
                <ul className="flex flex-col gap-1.5 text-[13px]">
                  {d.attempts.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-center gap-2">
                      <StatusPill tone={a.status === "confirmed" ? "ok" : a.status === "pending" ? "info" : "bad"}>{a.status.replace(/_/g, " ")}</StatusPill>
                      <span className="text-muted">{formatDateTimeInZone(a.startTime).replace(/ \(.*\)$/, "")}</span>
                      {a.error && <span className="text-bad">{a.error.slice(0, 80)}</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Section>

          <Section title="Needs a human?">
            {d.escalations.length === 0 ? <p className="text-sm text-muted">No escalations.</p> : (
              <ul className="flex flex-col gap-3">
                {d.escalations.map((e) => (
                  <li key={e.id} className="text-[13.5px]">
                    <div className="flex items-center gap-2 mb-1">
                      <StatusPill tone={e.status === "resolved" ? "ok" : e.urgency === "high" ? "bad" : "warn"}>{e.status}</StatusPill>
                      <span className="font-medium">{e.kind.replace(/_/g, " ")}</span>
                    </div>
                    <p className="text-muted">{e.reason}</p>
                  </li>
                ))}
              </ul>
            )}
            <Link href="/dashboard/exceptions" className="btn btn-ghost btn-sm mt-4">Exception queue</Link>
          </Section>

          <Section title="What was captured">
            <dl className="text-[13.5px] grid grid-cols-[1fr_1.2fr] gap-x-3 gap-y-1.5">
              {facts.length === 0 && <p className="text-muted col-span-2">Nothing captured.</p>}
              {facts.map(([k, v]) => (
                <div key={k} className="contents"><dt className="text-muted">{FACT_LABELS[k] ?? k}</dt><dd className="break-words">{v === true ? "Yes" : String(v).replace(/_/g, " ")}</dd></div>
              ))}
            </dl>
          </Section>

          <Section title="Outputs">
            <ul className="text-[13.5px] flex flex-col gap-2">
              <li className="flex items-center justify-between gap-3"><span>HubSpot</span>{d.hubspot ? <span className="flex items-center gap-2"><StatusPill tone={d.hubspot.lastStatus === "synced" ? "ok" : d.hubspot.lastStatus === "failed" ? "bad" : "info"}>{d.hubspot.lastStatus}</StatusPill>{d.hubspot.mode !== "live" && <ModeBadge mode={d.hubspot.mode} />}</span> : <span className="text-subtle">not yet</span>}</li>
              {d.notifications.map((n) => (
                <li key={n.id} className="flex items-start justify-between gap-3">
                  <span className="text-muted break-words">Email to {n.recipient}</span>
                  <span className="flex items-center gap-2 shrink-0"><StatusPill tone={n.status === "sent" ? "ok" : n.status === "failed" ? "bad" : "info"}>{n.status}</StatusPill>{n.mode !== "live" && <ModeBadge mode={n.mode} />}</span>
                </li>
              ))}
            </ul>
          </Section>

          <Section title="Human override" hint="Only for a considered business reason. It is recorded with your name and cannot be undone silently.">
            <form action={overrideDisposition} className="flex flex-col gap-3">
              <input type="hidden" name="enquiryId" value={d.enquiry.id} />
              <div>
                <label className="label" htmlFor="toDisposition">Change outcome to</label>
                <select id="toDisposition" name="toDisposition" className="field" defaultValue={d.enquiry.disposition}>
                  {DISPOSITIONS.map((x) => <option key={x} value={x}>{x.replace(/_/g, " ")}</option>)}
                </select>
              </div>
              <div>
                <label className="label" htmlFor="reason">Reason (required, 10+ characters)</label>
                <textarea id="reason" name="reason" required minLength={10} maxLength={800} className="field" />
              </div>
              <button type="submit" className="btn btn-ghost btn-sm self-start">Record override as {admin.email.split("@")[0]}</button>
            </form>
            {d.overrides.length > 0 && (
              <ul className="mt-4 border-t hairline pt-3 text-[13px] flex flex-col gap-2">
                {d.overrides.map((o) => (
                  <li key={o.id}><span className="text-muted">{formatDateTimeInZone(o.createdAt).replace(/ \(.*\)$/, "")}</span> &middot; {o.overriddenBy}: {o.fromDisposition.replace(/_/g, " ")} &rarr; {o.toDisposition.replace(/_/g, " ")}<div className="text-muted">{o.reason}</div></li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </div>
    </>
  );
}
