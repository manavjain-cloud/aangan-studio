# Vaani integration: what is verified, what is not, and how to set it up

Source for everything marked **verified**: the public Vaani Backend API documentation at <https://docs.vaanivoice.ai> (index: `/llms.txt`), read on 2026-10-10.
`app.vaanivoice.ai` itself is a login-gated dashboard; it was **not** opened with your account, so nothing below has been confirmed against your actual workspace yet.

## 1. Capability check

| Capability required | Status | Evidence / note |
|---|---|---|
| Authenticate API calls | **Verified** | `X-API-Key: vaani_…` header on `https://api.vaanivoice.ai` |
| Inbound calls answered by an agent on a phone number | **Verified in docs, unverified for your account/India** | *Settings → Telephony* (provision a number or bring a SIP trunk), then assign the number as the agent's `Inbound` route (`PATCH /api/agent/{id}/deployment`, field `Inbound`, E.164). The supported-countries list is "in the dashboard" – **confirm that an Indian number can be provisioned**, or use a Twilio/Telnyx SIP trunk |
| Real-time custom tools during a live call | **Verified in docs** | *Customize Persona → Add Custom Tools via cURL*: paste a cURL request plus a natural-language description of when to trigger it; "tools … mid-call". Docs advise the endpoint answer within **2–3 seconds** |
| How a custom tool is defined | **Verified in your workspace (2026-10-10)** | *Design → Tools & Actions → New Action → Create Custom Tool* is a structured form: **Name, Description, API Endpoint + method, Timeout (ms), Headers (key/value), Query Parameters, Parameters** (typed, "Required" flag, extracted by the agent from the conversation) and **Store Fields as Variables** (map response fields to dynamic variables). A "Paste cURL" shortcut also exists. `npm run vaani:tools` prints values for each field; the action is a static query parameter (`?action=…`) and the secret a static header |
| Whether the call id / caller number can be passed to a tool | **Verified: NOT passed** (2026-10-10) | The custom-tool form offers no call id or phone variable; only `{{current_date}}`, `{{current_day}}`, `{{current_time}}`, `{{call_mode}}` (always `inbound`, also in chat tests). The server therefore resolves the call itself: explicit `call_id` -> `call_ref` -> caller number -> the ONE call in progress (from the `call_started` webhook) -> the open ad-hoc session of the last 30 min (chat tests / late webhook). Two or more simultaneous real calls with no identity are refused, not guessed |
| Tool request signing | **Not available** (static cURL) | We authenticate with a secret header instead (§3) |
| Call lifecycle webhooks | **Verified** | `call_started`, `user_picked_up_at`, `call_ended` (duration in **seconds**), `call_postprocessing` (duration in **ms**; transcript, summary, entities), `human_transfer_*`; configured under *Settings → Webhooks*; retried 5× with back-off on non-2xx |
| Signature on those webhooks | **Not documented** | HMAC-SHA256 (`X-Vaani-Signature`, `X-Vaani-Timestamp`) is documented **only for campaign webhooks**. We accept it if present and otherwise require a secret `?token=` in the URL you register |
| Caller's number on inbound `call_started` | **Unverified** | The doc example shows `phone_number`; we read `phone_number`, `from_number` or `data.*`. Confirm with a real inbound call; `call-history` returns `from_number` and is used to reconcile |
| Transcript, summary, cost | **Verified** | `GET /api/call_details/{id}`, `/api/transcript/{id}`, `/api/call-history` (`call_cost` in *credits*) |
| Warm transfer to a human | **Verified, not used** | `transfer_call` tool exists; this build escalates by email instead, per the brief |
| Test the agent without a phone number | **Verified** | `POST /api/trigger-call/` can start an in-browser WebRTC session |

If your workspace turns out **not** to support custom tools, see §6.

## 2. Setup steps (in the Vaani dashboard)

1. **Create the agent** (*Agent Config*): paste the prompt and greeting from `docs/vaani-agent-prompt.md`. Copy the `agent_id` → `VAANI_AGENT_ID`.
2. **Generate an API key** (*Settings → API Keys*) → `VAANI_API_KEY`.
3. **Telephony**: provision/connect an Indian number and assign it to the agent for **inbound**.
4. **Webhook**: *Settings → Webhooks* → `https://<your-app>/api/voice/webhooks/vaani?token=<VAANI_WEBHOOK_TOKEN>`.
5. **Tools**: run `npm run vaani:tools`, then create the six tools in *Design → Tools & Actions* and attach them to the agent. Keep the `X-Aangan-Tool-Key` header (value = `VOICE_TOOL_SECRET`). Paste each *Description* verbatim – it carries the guardrails ("only after the caller said yes…").
6. **Public HTTPS**: Vaani must be able to reach `APP_URL`. For local testing use a tunnel (e.g. `ngrok http 3100`).
7. **Test** (in this order): `npm run simulate:call -- qualified` (our side) → WebRTC test session in the dashboard (agent + tools, no phone cost) → one real inbound call from your own phone → the five scenarios in §5.

## 3. Endpoint contract

`POST /api/voice/tools/aangan-workflow-action`
Headers: `X-Aangan-Tool-Key: <VOICE_TOOL_SECRET>` (or `Authorization: Bearer …`), `Content-Type: application/json`.
Body (flat or nested under `args`):

```json
{ "action": "book_consultation", "call_id": "room_123", "caller_phone": "+919822000111", "request_id": "optional-idempotency-id",
  "args": { "slot_option": 2, "customer_confirmed": true, "customer_confirmation_quote": "Yes, the Tuesday one",
            "invitee_email": "priya@example.com", "invitee_name": "Priya" } }
```

| Action | Purpose | Notes |
|---|---|---|
| `get_call_context` | today's date (IST), after-hours flag, facts already known from a dropped call | call once at the start |
| `save_enquiry_progress` | merge validated facts | numbers/booleans tolerate LLM strings (`"1,400"`, `"yes"`); null never erases |
| `evaluate_qualification` | run the server-side rubric; persists criterion-level evidence | returns the exact wording to say |
| `get_available_slots` | real Calendly availability for the assigned designer | requires `qualified`; ≤ 3 spread options, 20-minute hold |
| `book_consultation` | create the Calendly booking | requires an offered slot, `customer_confirmed=true`, the caller's own quote, name and email; success reported **only** after Calendly's 201 |
| `escalate_to_human` | complaint / senior requested / frustrated / other | emails the senior person; no booking possible afterwards |

The call is resolved by `call_id`; if that is missing or an unresolved template (`{{call_id}}`), by `caller_phone` for a call in progress; otherwise `422 missing_call_context`. If the webhook has not arrived yet, the first tool call **creates** the call record, so a late webhook never loses a lead.

Statuses the agent may receive: `saved`, `qualified`, `clarification_required`, `rejected`, `human_escalation`, `slots_available`, `no_slots`, `booked`, `needs_info`, `slot_expired`, `slot_taken_alternatives`, `not_bookable`, `calendar_unavailable`, `booking_failed`, `booking_unconfirmed`, `escalated`, `timeout`, `rate_limited`, `missing_call_context`. Every `say` is fixed server wording passed through the pricing guard.

## 4. Failure behaviour the agent will see

* Calendly down / unconfigured → `calendar_unavailable` + a human escalation (email) + wording to take preferred times.
* Slot taken between offer and booking → `slot_taken_alternatives` with fresh real options.
* Booking error → `booking_failed`; timeout with the event not found → `booking_unconfirmed` (**never** "booked"); both alert the front desk and senior team and a reconcile job re-checks Calendly.
* A tool exceeding its deadline (9 s, 13 s for booking) returns `timeout`; an in-flight booking is marked unconfirmed and reconciled.

## 5. Acceptance calls (do these with real credentials)

1. Qualified residential Kothrud lead → real slot offered → booked → confirmation email from Calendly, handoff email, HubSpot contact + note, dashboard row.
2. Ask the price three times → only the approved sentence, lead still booked.
3. "Project in Nashik" → polite decline, no slot offered, HubSpot logs the decline.
4. "My designer hasn't replied in five days" → escalation email to the senior person, nothing booked.
5. Hang up mid-call, call back → agent does not re-ask known facts; the front desk gets a call-back email only if you do **not** redial.

## 6. If custom tools are not available on your plan

The system degrades safely to **post-call only** (this path is covered by `tests/postcall-fallback.test.ts`):
the signed/tokenised `call_postprocessing` webhook (and a 15-minute fallback poll of `GET /api/call_details/{id}`) feeds the transcript to Gemini, which extracts facts; the same deterministic engine qualifies the lead; HubSpot is updated; the designer/front desk receive a *"qualified – arrange consultation (no slot booked)"* email; complaints are escalated.
**What cannot run live in that mode:** real-time availability lookup, booking and escalation *during* the call. The agent can only collect the caller's preferred times and email, and a human books. This must not be described as real-time functionality.

## 7. Cost data

`call-history` returns `call_cost` in **credits**; we record it and convert to rupees only if you set the credit price (*Settings → Cost rates* or `VAANI_CREDIT_INR`). Until then the dashboard shows the minutes and credits as *unpriced*.

## 8. Findings from live chat tests (2026-10-10)

* **Max two tool calls per agent turn.** A turn that chained three tools (context, save/evaluate, slots) ended with Vaani's canned "I've made that change for you." instead of the tool's `say` text; turns with one or two tools spoke the server wording correctly. The prompt now forbids more than two calls per reply, `aangan_evaluate_lead` carries and saves all facts (so `save_progress` is optional), and the `get_call_context`/`call_ref` step was removed from the agent (the server action still exists).
* **LLM**: primary OpenAI `gpt-4.1-mini`, fallback Google `gemini-2.5-flash` (Vaani requires different providers for primary/fallback). The earlier Gemini 3.5 primary showed the same canned reply on 3-tool turns, so that was not model-specific.
* Verified end to end in a Vaani chat test: qualified Kothrud caller -> evaluate -> real Cal.com slots read out -> caller confirms -> booking created in Cal.com (cancelled afterwards) -> handoff email job + HubSpot sync job queued. Nashik caller -> exact server rejection wording, no booking.
* Chat sessions cost credits (about Rs 0.5-1 each); the history page lists them as `chat_user -> chat_session`.
* `GET /api/call-history` returns HTTP 500 on this workspace ("Invalid client_id format") and transcripts of chat rooms are not stored; webhooks are the reliable source.

## 9. Channel: in-browser web call only (decision 2026-10-10)

No telephone number is used. Callers start a voice call from the "Talk to the studio" button on the public entry page (`src/components/web-call.tsx`):
the browser POSTs `/api/voice/web-session` (same-origin only, 4 per visitor per 10 min, `WEB_CALL_DAILY_CAP` per day), the server calls Vaani `POST /api/trigger-call/` with `medium: "webrtc"` (the API key never leaves the server) and returns a short-lived LiveKit token which the browser uses with `livekit-client` and the microphone.
Vaani then fires the normal webhooks (the room name is the call id) and the agent uses the same tools, so qualification, booking, HubSpot, email and the dashboard behave exactly as for a phone call. Step 3 of the set-up list (telephony) is therefore not needed. The microphone/audio path itself can only be exercised by a person in a real browser; the session creation and everything after it are covered by tests and live checks.

