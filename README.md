# Aangan Studio – AI phone enquiry qualification

An inbound-call system for Aangan Studio (interior design, Pune). A Vaani voice agent answers every call day and night, captures the facts, calls this application **live, mid-call** to apply Nikhil's qualification rubric and to book a real Calendly consultation, and the results flow to four outputs: **HubSpot**, **email notifications**, **Calendly bookings** and a **management-only dashboard** with running costs.

Phone channel only (WhatsApp and the web form are out of scope). **No prices are ever quoted** – the approved deflection from `pricing.md` is the only answer.

> **Honest status.** The application, rules engine, database, mock adapters, live-tool endpoint, webhooks, dashboard and tests are complete and passing. The **live integrations (Vaani, Calendly, HubSpot, Gemini, Resend, Neon) have not been exercised against real accounts yet** because no credentials have been supplied. They are written against the official documentation and tested with recorded-contract fakes, and the system runs in clearly labelled *simulated* mode until keys arrive. See [Known limitations](#known-limitations-and-what-is-not-verified-yet).

## Quick start (simulated mode, no credentials needed)

```bash
npm install
npm run keys:sync          # copies D:\Vaani Project\API_KEYS.txt -> .env.local (generated secrets are already filled in)
npm run admin:create -- you@example.com     # dashboard login (password prompt)
npm run db:seed            # optional: ~20 sample calls replayed through the real pipeline, labelled "sample"
npm run dev -- -p 3100     # http://localhost:3100
npm run simulate:call -- qualified          # in a second terminal: a full scripted call over real HTTP
```

Without `DATABASE_URL` the app uses an in-process PostgreSQL (PGlite, stored in `.data/`) for development only; **production refuses to start without Neon**. Without integration keys every adapter is simulated and every record it produces is labelled *Simulated* in the UI.

## Commands

| | |
|---|---|
| `npm run dev` / `build` / `start` | Next.js 16 (App Router, Turbopack) |
| `npm test` | 190 tests (Vitest; PGlite in memory; jsdom for UI) |
| `npm run typecheck` · `npm run lint` | strict TypeScript, ESLint |
| `npm run db:generate` · `db:migrate` | Drizzle migrations (`drizzle/`) · apply them (Neon or local) |
| `npm run db:seed` | development sample data (refuses production / external DB without `--force`) |
| `npm run admin:create -- <email>` | create or reset a management login |
| `npm run keys:sync` | `API_KEYS.txt` → `.env.local` |
| `npm run vaani:tools` | print the six Vaani custom-tool cURL definitions |
| `npm run simulate:call -- <scenario>` | `qualified · rejected · complaint · pricing · dropped` against a running server |
| `npm run check:integrations` | mode + health of each integration |
| `npm run hubspot:setup` | create the `aangan_*` HubSpot properties (idempotent) |

## How it works

See [docs/architecture.md](docs/architecture.md) for the diagram, sequence flow, state machine, data model, idempotency table and security model. In short:

1. **Trigger** – an incoming call; Vaani's webhooks create/advance the call record.
2. **Input** – the Vaani agent converses and calls the **live tool endpoint** `POST /api/voice/tools/aangan-workflow-action` (`get_call_context`, `save_enquiry_progress`, `evaluate_qualification`, `get_available_slots`, `book_consultation`, `escalate_to_human`).
3. **Context** – `content/knowledge/` (services, qualification rubric; pricing only as the approved sentence).
4. **Processing + AI** – deterministic rules engine and workflow state machine; Gemini extracts and summarises *after* the call and audits it for price disclosure, but can never decide.
5. **Output** – HubSpot contact + note (every call, including declines), email to the designer / front desk / senior person, a real Calendly booking, and the dashboard.

The model never overrides a rule, quotes a price, bypasses the booking confirmation, or claims success without a verified server result. Details: [docs/vaani-integration.md](docs/vaani-integration.md) and [docs/vaani-agent-prompt.md](docs/vaani-agent-prompt.md).

## Business rules implemented

From `services.md`, `qualified.md`, `rubric.txt` and `pricing.md` (copied unchanged to `content/knowledge/`):

* Five criteria with the proposed importance weights 30 / 25 / 20 / 15 / 10 (configurable, **need Nikhil's approval**); statuses `pass · fail · unknown · unknown_neutral · human_review` with the evidence stored per criterion.
* Unclear 1–3 → one direct question. Unclear 4–5 → qualified with a note. No budget mentioned or declined → no penalty; the agent never asks for a budget. Asking about price never disqualifies. Rented flats, single rooms and after-hours calls are fine.
* Out of area, advice-only, impossible timeline, clearly inadequate **volunteered** budget, excluded space types → never booked. Existing-customer complaints, frustrated returning leads and requests for a senior person → escalated, never entered in the sales flow.
* Human override of any decision, with a mandatory reason and an audit record.
* `pricing.md`: price tables are never loaded into a prompt or response; all spoken text passes a price-disclosure guard; after every call the transcript is audited and a violation raises a compliance escalation.

### Open business decisions (documented, not hidden – also shown in *Settings*)

1. **One failure or two?** `qualified.md` says both "if it fails one, close gracefully" and "decline when two or more fail". Default implemented: one *hard exclusion* → polite decline; one softer failure → human review; two or more → decline. All three and a master "automatic declines" switch are configurable. `rubric.txt` asks that automatic rejection not go live until Nikhil confirms.
2. **Score weights** are proposals, not Nikhil's numbers. The score never overrides a failed criterion.
3. **Smallest commercial project.** `services.md` only gives an upper limit (~3,000 sq ft); the 500 sq ft floor comes from the T18 front-desk answer and `rubric.txt`.
4. **Timeline.** Under 6 weeks to completion is declined (`services.md`); 6–10 weeks is accepted with a warning to the designer; the "8–10 weeks" sentence in `qualified.md` is ambiguous and is read as a minimum lead time, not a maximum horizon.
5. **"Adjoining areas".** Localities named in `services.md` pass cleanly; other Pune-city localities (Kharadi, Nanded City…) pass with a "designer to confirm" note.
6. **Operational owner** for HubSpot, email routing, Calendly set-up and exception monitoring is not named in the brief (*Nine Checks #9*).

### Why email (not Telegram) for handoffs

The brief leaves the channel to us. Email: works for all 14 designers and the two front-desk staff with no new app or bot onboarding; every message is a durable, searchable, forwardable record (useful for the "designers repeat the front desk's questions" problem); delivery is auditable (`notifications` table, provider message id, retries); it supports role routing (complaints → senior person) and a front-desk copy so a missed email cannot strand a lead. Telegram would add faster push but needs each person to start a bot chat and gives no durable audit trail.

## Credentials and permissions needed

Put values in `D:\Vaani Project\API_KEYS.txt`, then `npm run keys:sync`. **Never paste them into code or chat.**

| Variable | What / where | Needed for |
|---|---|---|
| `DATABASE_URL` | Neon **pooled connection string** (not the Neon management API key) | production persistence |
| `VAANI_API_KEY`, `VAANI_AGENT_ID` | Vaani *Settings → API Keys*; *Agent Config* | cost/transcript fetch, health check |
| `VOICE_TOOL_SECRET`, `VAANI_WEBHOOK_TOKEN` | generated for you in `API_KEYS.txt` | authenticates Vaani → our endpoints |
| `VAANI_WEBHOOK_SECRET` | only if Vaani gives an HMAC secret for call webhooks | optional |
| `GEMINI_API_KEY` | Google AI Studio (paid tier for production) | post-call extraction / audit |
| `HUBSPOT_ACCESS_TOKEN` | Private App; scopes `crm.objects.contacts.read/write`, `crm.schemas.contacts.read/write` (+ deals scopes if `HUBSPOT_CREATE_DEALS=1`) | CRM |
| `CALCOM_API_KEY` (free) **or** `CALENDLY_ACCESS_TOKEN` (**paid** plan, Standard+) | Cal.com: Settings → Security → API keys. Calendly: Personal Access Token. One **event type per designer** pasted in *Settings → Team* (`calcom:<id>` or the Calendly URI). Set `CALENDAR_PROVIDER=calcom` or `calendly` (auto-detected) | availability + booking |
| `RESEND_API_KEY`, `EMAIL_FROM` | Resend; **verified sending domain** | emails |
| `FRONT_DESK_EMAIL`, `SENIOR_ESCALATION_EMAIL`, `OPS_ALERT_EMAIL` | recipients (or configure in *Settings → Team*) | routing |
| `SESSION_SECRET`, `CRON_SECRET`, `APP_URL`, `ADMIN_EMAILS` | generated / your public URL / optional allow-list | dashboard + jobs |

Notes: a GitHub token is **not** needed to run the app. **Scheduling provider.** Calendly's booking API needs a paid plan (it returns 403 on Free), so a free **Cal.com** adapter (`src/lib/integrations/calcom/`) implements the same interface; the free Cal.com plan has a single host, so all consultations go to one shared calendar for the pilot (the designer is named in the handoff email; multi-designer routing needs a Cal.com Teams plan or Calendly). Calendly's API token alone does not guarantee booking: who receives the confirmation/invite is governed by each event type's notification settings – confirm that both the invitee and the host notifications are on. The HubSpot properties are created only if missing (`npm run hubspot:setup`).

## Dashboard (management only)

`/` entry (editorial hero with the specified video, reduced-motion and failure fallbacks) → sign in → **Overview** (calls, answered/missed, answer-time distribution vs the 5-minute target, after-hours share, qualified/declined/unclear/escalated, funnel, bookings & failures, decline reasons, daily trend, running cost, integration health), **Enquiries** (search/filter), **Enquiry detail** (criterion-level evidence, summary, activity, transcript, booking attempts, outputs, audited override), **Exceptions** (escalations with owner / acknowledge / resolve, booking failures, unclear enquiries), **Integrations** (live / simulated / not configured, endpoints, health checks), **Settings** (policy, team routing, cost rates, fixed costs). Designers and the front desk have no logins; they act on email.

Metrics are computed from persisted rows. Estimates and measured figures are labelled; where no source exists the dashboard says *n/a* (cost, conversion) rather than inventing a number. Response time is measured as ring → agent pick-up from webhook timestamps.

## Testing

`npm test` runs 190 tests. Mapping to the 24 required scenarios:

| # | Scenario | Where |
|---|---|---|
| 1–2 | suitable residential / office | `qualification.test.ts` |
| 3–4 | Nashik; styling advice | `qualification.test.ts`, `voice-tools.test.ts` |
| 5–6 | impossible timeline; inadequate volunteered budget | `qualification.test.ts` |
| 7–8 | pricing question; declined budget | `qualification.test.ts`, `voice-tools.test.ts` |
| 9–11 | rented flat; authorised representative; unclear scope | `qualification.test.ts` |
| 12 | existing-customer complaint | `qualification.test.ts`, `voice-tools.test.ts`, `postcall-fallback.test.ts` |
| 13–15 | after hours; dropped call + redial; duplicate webhook | `webhooks-and-jobs.test.ts` |
| 16–18 | booking success; slot taken; timeout / failure (3 variants) | `voice-tools.test.ts`, `adapters.test.ts` (Calendly and Cal.com) |
| 19–21 | HubSpot failure; email failure; Gemini invalid output | `webhooks-and-jobs.test.ts`, `adapters.test.ts` |
| 22 | missing / invalid credentials (fail-closed) | `security-and-config.test.ts` |
| 23 | retries create no duplicate bookings / CRM records / emails | `voice-tools.test.ts`, `webhooks-and-jobs.test.ts` |
| 24 | theme switch; responsive behaviour | `ui.test.tsx` (+ checked in a real browser at 1360 px and 375 px) |

Also covered: webhook HMAC/token auth, tool auth, scrypt/session, DB-backed rate limits, log redaction, transcript retention, analytics honesty (no invented costs), email HTML-escaping, the agent prompt (no prices, approved sentence verbatim), the post-call-only fallback, and the state machine (no route into booking except via customer confirmation).

## Deployment

See [docs/deployment-checklist.md](docs/deployment-checklist.md). Nothing has been deployed, pushed or published; no repository permissions were changed.

## Nine Checks (is the automation worth operating?) – status

| # | Check (weight) | Status in this build |
|---|---|---|
| 1 | Problem real? (15) | Evidenced in the brief (48 % unanswered, 33 % after hours, 4× conversion within an hour); the dashboard measures answer time and after-hours share to re-test it |
| 2 | Workflow repeated? (10) | Intake, qualification and handoff context are automated; designers receive complete context |
| 3 | Input available? (10) | Real call events, caller ID, live facts, transcript + `services/qualified/pricing` context |
| 4 | Output valuable? (15) | Four outputs implemented; each verified in simulated mode, live verification pending credentials |
| 5 | Impact measurable? (10) | Response time, outcomes, bookings, failures, cost per call / qualified lead; conversion needs HubSpot deal stages |
| 6 | Failure risk OK? (10) | Pricing guard + audit, no budget probing, no promised dates, escalation, safe retries, fail-closed security |
| 7 | Judgment protected? (10) | Rules explicit; humans decide exceptions; audited overrides; AI cannot change decisions |
| 8 | ROI worth it? (10) | Needs the controlled pilot: set cost rates, compare cost per qualified lead with bookings and staff time |
| 9 | Owner clear? (10) | Nikhil owns rules/outcomes; **an operational owner and a content owner still need to be named** |

(The evaluation weights are the proposed ones from `rubric.txt` and are separate from the customer-qualification weights.)

## Known limitations and what is not verified yet

* **No live integration has been run.** Vaani, Calendly, HubSpot, Gemini and Resend need real keys; the Neon database needs a connection string. Mock mode is labelled everywhere and is not evidence that a live system works.
* **Vaani specifics to confirm in the dashboard:** custom-tool variable syntax and call-id injection; that an Indian inbound number can be provisioned; the caller-number field on inbound `call_started`; whether call webhooks can be signed. See [docs/vaani-integration.md](docs/vaani-integration.md). Without custom tools the system runs post-call only and **cannot book during the call**.
* **Calendly:** requires a paid plan; invites/confirmations to the host depend on event-type notification settings; Calendly documents no idempotency key for bookings, so duplicate protection is our own (look-up before any re-send); availability queries are limited to 31 days.
* **Five-minute answer guarantee is not proven.** An AI agent answers immediately *if* the telephony route is up; after-hours reliability, missed-call handling during a Vaani outage and concurrent-call limits must be load-tested before claiming it (consider call forwarding from the studio line with a fallback to a voicemail/callback email).
* HubSpot: contacts + one note per call (+ optional deal). Pipeline/stage IDs must be supplied for deals. Property creation requires schema scopes. The adapter uses the semantic-version endpoints (`/crm/v3`, `/crm/v4`), which HubSpot says remain supported until **September 2027**; migrate to the date-based `/crm/2026-09/…` APIs before then (only `src/lib/integrations/hubspot/live.ts` changes).
* Records are labelled *live* only when `VAANI_API_KEY` and `VAANI_AGENT_ID` are both configured; before that, even real calls reaching the endpoints are stored as *simulated* so test traffic can never be mistaken for production.
* Gemini model names are read from configuration (`GEMINI_MODEL`, with fallbacks); confirm the account can use the chosen model with `npm run check:integrations`.
* The dashboard has a single admin role (all admins are "management"). No SSO.
* Transcripts are stored redacted and purged after `TRANSCRIPT_RETENTION_DAYS` (default 90) by the cron job; audio is never stored (Vaani keeps its own recordings – configure retention there).
* Content-Security-Policy is not set (Next.js inline scripts would need nonces); standard hardening headers are.
* Lead-to-project conversion is not tracked until HubSpot deal stages are maintained.

## Folder structure

```
src/app/                  Next.js routes: entry page, /dashboard/*, /api/voice/{tools,webhooks}, /api/jobs/run, /api/health
src/app/actions/          server actions (sign-in; management operations - each re-checks admin)
src/components/           UI primitives, charts (no chart dependency), theme toggle, hero video, nav
src/lib/domain/           pure rules: facts schema, qualification engine, service area, timeline, budget, signals, pricing guard, messages
src/lib/services/         workflow, ingest, qualify, booking, escalations, outbox/jobs, notifications, hubspot-sync, postcall, analytics, usage, voice-tools
src/lib/integrations/     vaani | gemini | hubspot | calendly | email : types + live + mock; factory with fail-closed mode resolution
src/lib/security/         HMAC, token auth, rate limiter, scrypt, sessions
src/lib/db/               Drizzle schema + client (Neon via pg, PGlite for dev/tests)
content/knowledge/        services.md, qualified.md, pricing.md, rubric.txt (source of truth)
drizzle/                  SQL migrations
docs/                     architecture, vaani-integration, vaani-agent-prompt, deployment-checklist
scripts/                  migrate, seed, admin, sync-keys, simulate-call, vaani tool printer, health check
tests/                    Vitest suites + transcript fixtures (T01–T20 as structured facts, no real customer data)
```
