import Link from "next/link";
import { Filters, buildHref, parseScope } from "@/components/filters";
import { DispositionBadge, Empty, ModeBadge, PageHeader, Section } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { listEnquiries, resolveRange } from "@/lib/services/analytics";
import { formatDateTimeInZone } from "@/lib/time";

export const metadata = { title: "Enquiries" };
export const dynamic = "force-dynamic";

type SP = { range?: string; from?: string; to?: string; data?: string; q?: string; d?: string; page?: string };

const DISPOSITIONS: Array<[string, string]> = [
  ["", "All outcomes"],
  ["qualified", "Qualified"],
  ["rejected", "Declined"],
  ["human_escalation", "Escalated"],
  ["clarification_required", "Unclear"],
];

export default async function EnquiriesPage({ searchParams }: { searchParams: Promise<SP> }) {
  await requireAdmin();
  const sp = await searchParams;
  const range = resolveRange(sp);
  const scope = parseScope(sp.data);
  const page = Math.max(Number(sp.page ?? 1) || 1, 1);
  const res = await listEnquiries(await getDb(), { q: sp.q, disposition: sp.d, scope, range, page });
  const pages = Math.max(Math.ceil(res.total / res.pageSize), 1);
  const keep = { q: sp.q, d: sp.d, ...(range.preset === "custom" ? { from: range.fromIso, to: range.toIso } : { range: range.preset }), data: scope === "all" ? undefined : scope };

  return (
    <>
      <PageHeader eyebrow="Records" title="Enquiries">
        Every inbound call that reached the agent, with the decision and the evidence behind it. {res.total} match{res.total === 1 ? "" : "es"} in this period.
      </PageHeader>
      <Filters base="/dashboard/enquiries" range={range} scope={scope} extra={{ q: sp.q, d: sp.d }} />

      <form method="get" action="/dashboard/enquiries" className="flex flex-wrap items-end gap-3 mb-6">
        {Object.entries(keep).map(([k, v]) => (v && k !== "q" && k !== "d" ? <input key={k} type="hidden" name={k} value={v} /> : null))}
        <div className="grow max-w-md">
          <label className="label" htmlFor="q">Search name, phone, email or location</label>
          <input id="q" name="q" defaultValue={sp.q ?? ""} className="field" placeholder="e.g. Kothrud or +9198" />
        </div>
        <div>
          <label className="label" htmlFor="d">Outcome</label>
          <select id="d" name="d" defaultValue={sp.d ?? ""} className="field !w-[190px]">
            {DISPOSITIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <button type="submit" className="btn btn-primary btn-sm">Search</button>
        {(sp.q || sp.d) && <Link href={buildHref("/dashboard/enquiries", { ...keep, q: undefined, d: undefined })} className="btn btn-ghost btn-sm">Clear</Link>}
      </form>

      <Section title="Results">
        {res.rows.length === 0 ? (
          <Empty title="Nothing matches">Try a wider date range, or switch the data scope.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Received (IST)</th><th>Caller</th><th>Project</th><th>Location</th><th>Outcome</th><th className="text-right">Score</th><th>Consultation</th></tr></thead>
              <tbody>
                {res.rows.map((r) => (
                  <tr key={r.id}>
                    <td className="whitespace-nowrap">{formatDateTimeInZone(r.createdAt).replace(/ \(.*\)$/, "")}</td>
                    <td>
                      <Link href={`/dashboard/enquiries/${r.id}`} className="font-medium underline underline-offset-4 decoration-border-strong">{r.name ?? r.phone ?? "Unknown caller"}</Link>
                      <div className="text-[12px] text-subtle">{r.name ? r.phone : null}</div>
                      <ModeBadge mode={r.mode} />
                    </td>
                    <td className="text-muted">{r.project || "-"}</td>
                    <td className="text-muted">{r.location ?? "-"}</td>
                    <td>
                      <DispositionBadge value={r.disposition} />
                      {r.overridden && <span className="badge badge-neutral ml-2" title="A human changed the automated decision">overridden</span>}
                    </td>
                    <td className="num text-right">{r.score}</td>
                    <td className="whitespace-nowrap">{r.bookedAt ? formatDateTimeInZone(r.bookedAt).replace(/ \(.*\)$/, "") : <span className="text-subtle">-</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages > 1 && (
          <nav className="flex items-center justify-between mt-5" aria-label="Pagination">
            <span className="text-[13px] text-muted">Page {page} of {pages}</span>
            <div className="flex gap-2">
              {page > 1 && <Link className="btn btn-ghost btn-sm" href={buildHref("/dashboard/enquiries", { ...keep, page: String(page - 1) })}>Previous</Link>}
              {page < pages && <Link className="btn btn-ghost btn-sm" href={buildHref("/dashboard/enquiries", { ...keep, page: String(page + 1) })}>Next</Link>}
            </div>
          </nav>
        )}
      </Section>
    </>
  );
}
