import { desc, eq } from "drizzle-orm";
import { HealthChecks } from "@/components/health-checks";
import { PageHeader, Section, StatusPill } from "@/components/ui";
import { requireAdmin } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { integrationEvents } from "@/lib/db/schema";
import { getEnv, allIntegrationStatuses, type IntegrationName } from "@/lib/env";
import { loadKnowledge } from "@/lib/knowledge";
import { integrationHealth } from "@/lib/services/analytics";
import { formatDateTimeInZone } from "@/lib/time";

export const metadata = { title: "Integrations" };
export const dynamic = "force-dynamic";

const GUIDE: Record<IntegrationName, { title: string; role: string; vars: string[]; steps: string[]; caveat?: string }> = {
  vaani: {
    title: "Vaani Voice",
    role: "Answers the call (Input layer), calls our tool endpoint mid-call, and posts call events.",
    vars: ["VAANI_API_KEY", "VAANI_AGENT_ID", "VOICE_TOOL_SECRET", "VAANI_WEBHOOK_TOKEN"],
    steps: [
      "Create the agent and paste the generated prompt (npm run vaani:tools prints the tool definitions).",
      "Add the six custom cURL tools pointing at /api/voice/tools/aangan-workflow-action with the X-Aangan-Tool-Key header.",
      "Settings -> Webhooks: add the webhook URL below (with ?token=).",
      "Settings -> Telephony: provision or connect a number and assign it to the agent for inbound calls.",
    ],
    caveat: "Vaani's public docs do not specify the custom-tool placeholder syntax or signing for call webhooks. Both must be confirmed in the dashboard (see docs/vaani-integration.md).",
  },
  gemini: { title: "Google Gemini", role: "Post-call extraction, summaries and the transcript compliance audit. Never decides qualification.", vars: ["GEMINI_API_KEY", "GEMINI_MODEL (optional)"], steps: ["Create a key in Google AI Studio and use a paid-tier key for production volumes."] },
  hubspot: { title: "HubSpot", role: "Contact + call note per enquiry, including declined calls.", vars: ["HUBSPOT_ACCESS_TOKEN"], steps: ["Create a Private App with scopes crm.objects.contacts.read/write and crm.schemas.contacts.read/write.", "Run npm run hubspot:setup once to create the aangan_* properties (existing ones are never duplicated)."], caveat: "Deal creation is optional and needs HUBSPOT_CREATE_DEALS plus the pipeline and stage IDs." },
  calendly: {
    title: "Calendar (Cal.com or Calendly)",
    role: "Real availability lookup and booking through the provider's API; the provider emails the confirmation.",
    vars: ["CALCOM_API_KEY (free) or CALENDLY_ACCESS_TOKEN (paid plan)", "CALENDAR_PROVIDER (optional)", "an event type per designer (Settings -> Team)"],
    steps: [
      "Cal.com (free): create an API key under Settings -> Security, create an event type (turn OFF 'requires confirmation') and put its id in Settings -> Team as calcom:<id>.",
      "Calendly: needs a paid plan (Standard+); the booking endpoint returns 403 on Free. Paste each event type URI in Settings -> Team.",
    ],
    caveat: "Cal.com's free plan has a single host, so every consultation lands on one shared calendar; the designer is named in our handoff email. Confirm that the provider's notification emails to the invitee (and host) are enabled.",
  },
  email: { title: "Email (Resend)", role: "Handoff and escalation emails to designers, front desk and senior people.", vars: ["RESEND_API_KEY", "EMAIL_FROM", "FRONT_DESK_EMAIL", "SENIOR_ESCALATION_EMAIL"], steps: ["Verify a sending domain in Resend; the test sender can only reach the account owner.", "Set EMAIL_TEST_RECIPIENT during the pilot to redirect every message to one inbox."] },
  neon: { title: "Neon PostgreSQL", role: "Persistent storage for calls, qualification evidence, bookings, jobs and costs.", vars: ["DATABASE_URL (pooled connection string)"], steps: ["Use the pooled connection string from the Neon console, not the management API key.", "Run npm run db:migrate before first start."] },
};

export default async function IntegrationsPage() {
  await requireAdmin();
  const db = await getDb();
  const env = getEnv();
  const statuses = allIntegrationStatuses();
  const health = await integrationHealth(db);
  const failures = await db.select().from(integrationEvents).where(eq(integrationEvents.status, "failed")).orderBy(desc(integrationEvents.createdAt)).limit(8);
  const knowledge = loadKnowledge();
  const base = env.APP_URL.replace(/\/$/, "");
  const secretsSet = {
    tool: !!env.VOICE_TOOL_SECRET,
    hook: !!(env.VAANI_WEBHOOK_TOKEN || env.VAANI_WEBHOOK_SECRET),
    session: !!env.SESSION_SECRET && env.SESSION_SECRET.length >= 32,
    cron: !!env.CRON_SECRET,
  };

  return (
    <>
      <PageHeader eyebrow="Configuration" title="Integrations">
        Live, simulated or not configured &mdash; shown honestly. Secrets are never displayed here; they live in server-side environment variables only.
      </PageHeader>

      <div className="grid md:grid-cols-2 gap-6 mb-6">
        {statuses.map((s) => {
          const g = GUIDE[s.name];
          const fails = health.integrations.find((i) => i.name === s.name)?.failures24h ?? 0;
          return (
            <Section key={s.name} title={g.title} right={<StatusPill tone={s.mode === "live" ? "ok" : s.mode === "mock" ? "warn" : "bad"}>{s.mode === "live" ? "live" : s.mode === "mock" ? "simulated" : "not configured"}</StatusPill>}>
              <p className="text-[14px] text-muted">{g.role}</p>
              {s.mode !== "live" && s.name !== "neon" && <p className="text-[13px] text-warn mt-2">{s.note}{s.missing.length ? ` Missing: ${s.missing.join(", ")}.` : ""}</p>}
              {s.name === "neon" && s.mode !== "live" && <p className="text-[13px] text-warn mt-2">{s.note}</p>}
              {fails > 0 && <p className="text-[13px] text-bad mt-2">{fails} failure{fails === 1 ? "" : "s"} in the last 24 hours.</p>}
              <p className="text-[12px] uppercase tracking-[0.1em] text-subtle mt-4 mb-1.5">Needs</p>
              <ul className="text-[13.5px] flex flex-wrap gap-2">{g.vars.map((v) => <li key={v}><code className="badge badge-neutral !h-auto !whitespace-normal !py-1 !leading-snug">{v}</code></li>)}</ul>
              <ol className="list-decimal ml-5 mt-4 text-[13.5px] text-muted flex flex-col gap-1.5">{g.steps.map((x) => <li key={x}>{x}</li>)}</ol>
              {g.caveat && <p className="text-[13px] mt-4 border-t hairline pt-3"><strong className="font-medium">Open point: </strong><span className="text-muted">{g.caveat}</span></p>}
            </Section>
          );
        })}
      </div>

      <div className="grid lg:grid-cols-2 gap-6 mb-6">
        <Section title="Endpoints to register" hint="Public URLs only. Append the secret values yourself; they are not shown.">
          <dl className="text-[13.5px] flex flex-col gap-3">
            <div><dt className="text-muted">Live tool endpoint (Vaani custom tools)</dt><dd><code className="break-all">{base}/api/voice/tools/aangan-workflow-action</code> <StatusPill tone={secretsSet.tool ? "ok" : "bad"}>{secretsSet.tool ? "VOICE_TOOL_SECRET set" : "VOICE_TOOL_SECRET missing"}</StatusPill></dd></div>
            <div><dt className="text-muted">Call-event webhook (Vaani Settings &rarr; Webhooks)</dt><dd><code className="break-all">{base}/api/voice/webhooks/vaani?token=&hellip;</code> <StatusPill tone={secretsSet.hook ? "ok" : "bad"}>{secretsSet.hook ? "secret set" : "no webhook secret"}</StatusPill></dd></div>
            <div><dt className="text-muted">Job runner (cron)</dt><dd><code className="break-all">{base}/api/jobs/run</code> <StatusPill tone={secretsSet.cron ? "ok" : "warn"}>{secretsSet.cron ? "CRON_SECRET set" : "CRON_SECRET missing"}</StatusPill></dd></div>
            <div><dt className="text-muted">Sessions</dt><dd><StatusPill tone={secretsSet.session ? "ok" : "bad"}>{secretsSet.session ? "SESSION_SECRET set" : "SESSION_SECRET missing or too short"}</StatusPill></dd></div>
          </dl>
          {!env.APP_URL.startsWith("https://") && <p className="text-[13px] text-warn mt-4">APP_URL is not an https address. Vaani must reach these endpoints over public HTTPS; use a tunnel (e.g. ngrok) or a deployed URL.</p>}
        </Section>

        <Section title="Connection checks" hint="Makes one harmless authenticated call per live integration. Simulated integrations are reported as not live - never as healthy.">
          <HealthChecks />
          <p className="text-[13px] text-muted mt-5 border-t hairline pt-3">
            Background jobs: {health.outbox.pending} pending, {health.outbox.failed} retrying, {health.outbox.dead} dead. Emails in the last 24 hours: {health.notifications.sent} sent, {health.notifications.failed} failed.
          </p>
        </Section>
      </div>

      <div className="grid lg:grid-cols-2 gap-6">
        <Section title="Business knowledge loaded" hint="Read from content/knowledge on the server. pricing.md is used only for the approved deflection sentence; its price tables are never loaded into prompts, APIs or this page.">
          <ul className="text-[14px] flex flex-col gap-2">
            {knowledge.sources.map((s) => <li key={s.file} className="flex items-center justify-between"><code>{s.file}</code><StatusPill tone={s.present ? "ok" : "bad"}>{s.present ? "loaded" : "missing"}</StatusPill></li>)}
            <li className="flex items-center justify-between"><span>Approved pricing response matches pricing.md</span><StatusPill tone={knowledge.pricingResponseMatchesSource ? "ok" : "bad"}>{knowledge.pricingResponseMatchesSource ? "verified" : "MISMATCH"}</StatusPill></li>
          </ul>
        </Section>
        <Section title="Recent integration failures">
          {failures.length === 0 ? <p className="text-sm text-muted">No failures recorded.</p> : (
            <ul className="flex flex-col gap-3 text-[13.5px]">
              {failures.map((f) => (
                <li key={f.id}>
                  <div className="flex items-center gap-2"><StatusPill tone="bad">{f.integration}</StatusPill><span className="font-medium">{f.eventType.replace(/_/g, " ")}</span><span className="text-subtle">{formatDateTimeInZone(f.createdAt).replace(/ \(.*\)$/, "")}</span></div>
                  {f.error && <p className="text-muted mt-1 break-words">{f.error}</p>}
                </li>
              ))}
            </ul>
          )}
        </Section>
      </div>
    </>
  );
}
