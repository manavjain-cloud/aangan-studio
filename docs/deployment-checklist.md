# Deployment checklist

Nothing has been deployed. Work through this in order; each item is something only you (or the account owner) can do.

## A. Accounts and access
- [ ] **Neon**: create a project (region near India, e.g. Singapore/Mumbai-adjacent), copy the **pooled** connection string → `DATABASE_URL`. (A Neon *management API key* is not a connection string.)
- [ ] **Vaani**: workspace active; Indian inbound number provisioned or SIP trunk connected; API key + `agent_id`.
- [ ] **Scheduling**: either **Cal.com** (free API key; one shared host) or **Calendly** paid plan (Standard+). One event type per designer (or one round-robin type); set location, buffers and reminders; confirm *both* invitee and host notifications are on. Create a Personal Access Token as the org admin.
- [ ] **HubSpot**: Private App with the scopes in the README; decide whether deals are wanted (pipeline + stage IDs).
- [ ] **Resend**: verify the sending domain (SPF/DKIM); API key; decide `EMAIL_FROM`.
- [ ] **Google AI Studio**: paid-tier Gemini key.
- [ ] Name the **operational owner** and **content owner** (Settings → Ownership shows them as *to be named*).

## B. Business sign-off (Nikhil)
- [ ] Rejection policy: one failure vs two (Settings → Qualification policy). Keep *automatic declines* **off** for the first pilot days if you want a human to see every would-be decline.
- [ ] Approve or change the 30/25/20/15/10 weights, the 500 sq ft commercial floor, the 6-week minimum and the "tight timeline" action.
- [ ] Confirm the list of "adjoining" Pune-city localities that may pass.
- [ ] Read `docs/vaani-agent-prompt.md` once; it is what the caller hears.

## C. Configure
- [ ] Fill `API_KEYS.txt`, run `npm run keys:sync` (local) – or set the same variables in the hosting provider's *server-side* environment (mark sensitive; never `NEXT_PUBLIC_*`).
- [ ] `npm run db:migrate` against Neon. `npm run admin:create -- <real email>`; set `ADMIN_EMAILS`.
- [ ] Settings → Team: add designers (with Calendly event type URIs), front desk, senior person. Settings → Cost rates / fixed costs.
- [ ] `npm run hubspot:setup`; `npm run check:integrations` (every line should be `live` and `OK`).
- [ ] Pilot safety: set `EMAIL_TEST_RECIPIENT` so all email goes to one inbox until routing is proven.
- [ ] **Remove the development admin** (`admin@aangan.local`) and the development seed data (`mode='seed'`) from any production database. Never run `db:seed` against production.

## D. Deploy (e.g. Vercel + Neon)
- [ ] Import the repository (the project root is `aangan-studio/`). Node 22+. Set env vars. Deploy.
- [ ] `APP_URL` = the https URL. `vercel.json` cron (Pro plan for sub-daily): `{"crons":[{"path":"/api/jobs/run","schedule":"*/10 * * * *"}]}`; Vercel sends `Authorization: Bearer $CRON_SECRET`. (Jobs also drain after every webhook/tool request, so the cron only handles retries and retention.)
- [ ] In Vaani: register the webhook URL (`…/api/voice/webhooks/vaani?token=…`) and the six tools (`npm run vaani:tools`), assign the inbound number.
- [ ] Function duration: the tool route allows 30 s; Vaani expects answers in 2–3 s – confirm cold-start latency (keep the region close to Neon; consider a warm-up cron on `/api/health`).

## E. Go-live tests (in this order)
- [ ] WebRTC test session from the Vaani dashboard (no phone cost) through all five scenarios in `docs/vaani-integration.md` §5.
- [ ] Real call from your own phone, daytime and after hours.
- [ ] Check: HubSpot contact + note, Calendly event (invitee **and** designer receive it), the emails, the dashboard row (no *Simulated* badge), a cost line once rates are set.
- [ ] Call twice quickly, hang up mid-call, ask the price three times, say "Nashik", say "my designer isn't replying": confirm each behaves as specified.
- [ ] Load: 5–10 concurrent calls; confirm Vaani concurrency limits and what callers hear beyond them. Decide the **fallback if Vaani is down** (forward the studio line to the front desk).

## F. Operate
- [ ] Review *Exceptions* daily in the pilot. Reconcile any `unconfirmed` booking in Calendly before re-booking.
- [ ] Watch *Integrations → recent failures* and the ops email address.
- [ ] After 2–4 weeks: compare cost per qualified lead with bookings and staff time (Nine Check #8), decide on automatic declines, and consider WhatsApp / web form as a later phase.
