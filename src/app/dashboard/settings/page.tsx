import { asc } from "drizzle-orm";
import { addFixedCostAction, addTeamMemberAction, removeFixedCostAction, saveCostSettingsAction, savePolicyAction, toggleTeamMemberAction } from "@/app/actions/dashboard";
import { PageHeader, Section, StatusPill, fmtInr } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { fixedCosts } from "@/lib/db/schema";
import { CRITERION_KEYS, CRITERION_LABELS } from "@/lib/domain/types";
import { getEnv, requireNumber } from "@/lib/env";
import { getCostSettings, getQualificationConfig } from "@/lib/services/settings";
import { listTeam } from "@/lib/services/team";

export const metadata = { title: "Settings" };
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ saved?: string }> }) {
  await requireAdmin();
  const { saved } = await searchParams;
  const db = await getDb();
  const env = getEnv();
  const cfg = await getQualificationConfig(db);
  const team = await listTeam(db);
  const fixed = await db.select().from(fixedCosts).orderBy(asc(fixedCosts.createdAt));
  const costs = await getCostSettings(db, {
    vaaniCreditInr: requireNumber(env.VAANI_CREDIT_INR),
    geminiInputInrPerMillion: requireNumber(env.GEMINI_INPUT_INR_PER_MILLION_TOKENS),
    geminiOutputInrPerMillion: requireNumber(env.GEMINI_OUTPUT_INR_PER_MILLION_TOKENS),
  });
  const today = new Date().toISOString().slice(0, 10);
  const total = Object.values(cfg.weights).reduce((a, b) => a + b, 0);

  return (
    <>
      <PageHeader eyebrow="Configuration" title="Settings">
        Business rules, team routing and cost rates. Every change is recorded in the audit log.
      </PageHeader>

      {saved && (
        <p role="status" className="badge badge-ok !h-auto !py-2.5 !px-4 !whitespace-normal mb-6 !text-[14px]">
          Saved ({saved.replace(/-/g, " ")}). The change is in the audit log and applies to new calls immediately.
        </p>
      )}

      <div className="card p-5 md:p-6 mb-6" style={{ background: "var(--brass-soft)" }}>
        <h2 className="text-[17px] font-semibold tracking-tight mb-2">Decisions that need Nikhil&rsquo;s confirmation</h2>
        <ol className="list-decimal ml-5 text-[14px] flex flex-col gap-2">
          <li><strong className="font-medium">One failure or two?</strong> qualified.md says both &ldquo;close gracefully if it fails one&rdquo; and &ldquo;decline when two or more fail&rdquo;. The safe default below: a single <em>hard exclusion</em> (Nashik, advice-only, a three-week deadline, a clearly inadequate volunteered budget) is declined politely; a single softer failure goes to a human; two or more are declined. Switch off automatic rejection to route every would-be decline to a human during the pilot.</li>
          <li><strong className="font-medium">Score weights</strong> (30/25/20/15/10) are proposed, not supplied by Nikhil. The score never overrides a failed criterion.</li>
          <li><strong className="font-medium">Smallest commercial project</strong>: services.md gives only an upper limit (~3,000 sq ft). The {cfg.commercial.minSqft} sq ft floor comes from the T18 front-desk answer and rubric.txt; confirm it.</li>
          <li><strong className="font-medium">&ldquo;Realistic timeline&rdquo;</strong>: under {cfg.timeline.hardMinWeeksToCompletion} weeks to completion is declined (services.md). Between that and {cfg.timeline.tightWeeksToCompletion} weeks the designer is warned; qualified.md&rsquo;s &ldquo;8&ndash;10 weeks&rdquo; wording is ambiguous.</li>
          <li><strong className="font-medium">Service area</strong>: localities named in services.md pass cleanly; other Pune-city localities (e.g. Kharadi) pass with a note to confirm.</li>
        </ol>
      </div>

      <div className="flex flex-col gap-6">
        <Section title="Qualification policy" hint="Applied by the deterministic rules engine. Gemini and the voice agent can never change these.">
          <form action={savePolicyAction} className="grid gap-6">
            <fieldset className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <legend className="label mb-2">Importance weights (must total 100; currently {total})</legend>
              {CRITERION_KEYS.map((k) => (
                <div key={k}>
                  <label className="label !text-[12px]" htmlFor={`w_${k}`}>{CRITERION_LABELS[k]}</label>
                  <input id={`w_${k}`} name={`w_${k}`} type="number" min={0} max={100} step={1} defaultValue={cfg.weights[k]} className="field num" />
                </div>
              ))}
            </fieldset>
            <div className="grid md:grid-cols-3 gap-4">
              {([["singleHardExclusion", "One hard exclusion", cfg.rejectionPolicy.singleHardExclusion], ["singleSoftFailure", "One softer failure", cfg.rejectionPolicy.singleSoftFailure], ["twoOrMoreFailures", "Two or more failures", cfg.rejectionPolicy.twoOrMoreFailures]] as const).map(([name, label, value]) => (
                <div key={name}>
                  <label className="label" htmlFor={name}>{label}</label>
                  <select id={name} name={name} defaultValue={value} className="field">
                    <option value="reject">Decline politely</option>
                    <option value="human_review">Send to a human</option>
                  </select>
                </div>
              ))}
            </div>
            <div className="grid md:grid-cols-4 gap-4">
              <div><label className="label" htmlFor="tightAction">Tight (but possible) timeline</label>
                <select id="tightAction" name="tightAction" defaultValue={cfg.timeline.tightAction} className="field"><option value="note">Qualify, warn the designer</option><option value="human_review">Send to a human</option></select></div>
              <div><label className="label" htmlFor="minSqft">Commercial minimum (sq ft)</label><input id="minSqft" name="minSqft" type="number" min={0} defaultValue={cfg.commercial.minSqft} className="field num" /></div>
              <div><label className="label" htmlFor="maxSqft">Commercial typical maximum (sq ft)</label><input id="maxSqft" name="maxSqft" type="number" min={0} defaultValue={cfg.commercial.maxSqft} className="field num" /></div>
            </div>
            <div className="flex flex-col gap-2 text-[14px]">
              <label className="flex items-center gap-3"><input type="checkbox" name="autoRejectEnabled" defaultChecked={cfg.rejectionPolicy.autoRejectEnabled} className="h-4 w-4" /> Automatic polite declines enabled (switch off to send every would-be decline to a human)</label>
              <label className="flex items-center gap-3"><input type="checkbox" name="frustratedLeadAutoBook" defaultChecked={cfg.escalation.frustratedLeadAutoBook} className="h-4 w-4" /> Allow a frustrated returning lead to be booked by the agent (default off: a senior person calls back)</label>
            </div>
            <button type="submit" className="btn btn-primary self-start">Save policy</button>
          </form>
        </Section>

        <Section title="Team and routing" hint="Designers need a Calendly event type URI. Senior people receive complaints and exceptions; the front desk receives call-backs and booking failures.">
          <div className="table-wrap mb-6">
            <table className="data">
              <thead><tr><th>Name</th><th>Role</th><th>Email</th><th>Handles</th><th>Calendly event type</th><th></th></tr></thead>
              <tbody>
                {team.map((m) => (
                  <tr key={m.id}>
                    <td className="font-medium">{m.name}</td>
                    <td>{m.role.replace("_", " ")}</td>
                    <td className="break-all">{m.email}</td>
                    <td className="text-muted">{m.role === "designer" ? m.handles.join(", ") : "-"}</td>
                    <td className="text-muted break-all max-w-[240px]">{m.calendlyEventTypeUri ?? "-"}</td>
                    <td>
                      <form action={toggleTeamMemberAction}>
                        <input type="hidden" name="id" value={m.id} /><input type="hidden" name="active" value={String(!m.active)} />
                        <button className="btn btn-ghost btn-sm" type="submit">{m.active ? "Deactivate" : "Activate"}</button>
                      </form>
                    </td>
                  </tr>
                ))}
                {team.length === 0 && <tr><td colSpan={6} className="text-muted">No team members yet. Add at least one designer, a front-desk contact and a senior contact.</td></tr>}
              </tbody>
            </table>
          </div>
          <form action={addTeamMemberAction} className="grid md:grid-cols-6 gap-3 items-end">
            <div className="md:col-span-1"><label className="label" htmlFor="tm-name">Name</label><input id="tm-name" name="name" required className="field" /></div>
            <div className="md:col-span-2"><label className="label" htmlFor="tm-email">Email</label><input id="tm-email" name="email" type="email" required className="field" /></div>
            <div><label className="label" htmlFor="tm-role">Role</label><select id="tm-role" name="role" className="field"><option value="designer">Designer</option><option value="front_desk">Front desk</option><option value="senior">Senior</option></select></div>
            <div className="md:col-span-2"><label className="label" htmlFor="tm-cal">Calendly event type URI (designers)</label><input id="tm-cal" name="calendlyEventTypeUri" placeholder="https://api.calendly.com/event_types/..." className="field" /></div>
            <fieldset className="md:col-span-3 flex gap-5 text-[14px]"><legend className="label">Handles (designers)</legend><label className="flex gap-2 items-center"><input type="checkbox" name="handles" value="residential" defaultChecked /> Residential</label><label className="flex gap-2 items-center"><input type="checkbox" name="handles" value="commercial" defaultChecked /> Commercial</label></fieldset>
            <div className="md:col-span-3"><button className="btn btn-primary btn-sm" type="submit">Add team member</button></div>
          </form>
        </Section>

        <div id="costs" className="scroll-mt-6">
          <Section title="Cost rates" hint="Leave a field blank if the figure is unknown - the dashboard then shows the usage as unpriced instead of guessing. Environment values are used as a fallback.">
            <form action={saveCostSettingsAction} className="grid md:grid-cols-4 gap-4 items-end">
              <div><label className="label" htmlFor="vaaniCreditInr">INR per Vaani credit</label><input id="vaaniCreditInr" name="vaaniCreditInr" type="number" step="any" min="0" defaultValue={costs.vaaniCreditInr ?? ""} className="field num" /></div>
              <div><label className="label" htmlFor="geminiIn">Gemini INR per 1M input tokens</label><input id="geminiIn" name="geminiIn" type="number" step="any" min="0" defaultValue={costs.geminiInputInrPerMillion ?? ""} className="field num" /></div>
              <div><label className="label" htmlFor="geminiOut">Gemini INR per 1M output tokens</label><input id="geminiOut" name="geminiOut" type="number" step="any" min="0" defaultValue={costs.geminiOutputInrPerMillion ?? ""} className="field num" /></div>
              <button className="btn btn-primary btn-sm" type="submit">Save rates</button>
            </form>

            <h3 className="text-[14px] font-semibold mt-8 mb-3">Fixed monthly costs</h3>
            <p className="text-[13px] text-muted mb-3">Seats, number rental, hosting, CRM plan share... prorated across the dashboard period and labelled &ldquo;configured&rdquo;.</p>
            {fixed.length > 0 && (
              <div className="table-wrap mb-4">
                <table className="data">
                  <thead><tr><th>Provider</th><th>Item</th><th className="text-right">INR / month</th><th>From</th><th></th></tr></thead>
                  <tbody>
                    {fixed.map((f) => (
                      <tr key={f.id}><td className="capitalize">{f.provider}</td><td>{f.label}</td><td className="num text-right">{fmtInr(Number(f.monthlyInr))}</td><td className="num">{f.activeFrom}</td>
                        <td><form action={removeFixedCostAction}><input type="hidden" name="id" value={f.id} /><button className="btn btn-danger btn-sm" type="submit">Remove</button></form></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <form action={addFixedCostAction} className="grid md:grid-cols-5 gap-3 items-end">
              <div><label className="label" htmlFor="fc-provider">Provider</label><select id="fc-provider" name="provider" className="field"><option>vaani</option><option>calendly</option><option>hubspot</option><option>gemini</option><option>email</option><option>neon</option><option>hosting</option><option>other</option></select></div>
              <div className="md:col-span-2"><label className="label" htmlFor="fc-label">Item</label><input id="fc-label" name="label" required className="field" placeholder="e.g. Calendly Standard seats" /></div>
              <div><label className="label" htmlFor="fc-amt">INR per month</label><input id="fc-amt" name="monthlyInr" type="number" min="0" step="any" required className="field num" /></div>
              <div><label className="label" htmlFor="fc-from">Active from</label><input id="fc-from" name="activeFrom" type="date" defaultValue={today} required className="field" /></div>
              <button className="btn btn-primary btn-sm md:col-start-1" type="submit">Add fixed cost</button>
            </form>
          </Section>
        </div>

        <Section title="Ownership" hint="Nine Checks item 9: who owns what.">
          <ul className="text-[14px] grid md:grid-cols-2 gap-x-8 gap-y-2">
            <li><strong className="font-medium">Nikhil Deshpande</strong> &mdash; qualification rubric, service policies, business outcomes, final commercial judgement.</li>
            <li><StatusPill tone="warn">to be named</StatusPill> operational owner &mdash; HubSpot fields and stages, email routing, Calendly set-up, dashboard accuracy, exception monitoring.</li>
            <li><StatusPill tone="warn">to be named</StatusPill> content owner &mdash; keeps services.md / qualified.md / pricing.md and the voice prompt in step.</li>
          </ul>
        </Section>
      </div>
    </>
  );
}
