# Aangan Studio – working notes for Claude Code

Read `README.md` first, then `docs/architecture.md`. Source business rules live in `content/knowledge/` (services.md, qualified.md, pricing.md, rubric.txt) – they are the source of truth; do not invent policy.

## Non-negotiables
- **Never quote or hint at a price.** `pricing.md` is internal. Spoken text goes through `sanitizeSpokenText` (`src/lib/domain/pricing-guard.ts`). Internal budget floors live only in `src/lib/domain/budget.ts` and must never reach an API response, prompt, log, email or dashboard string.
- **Never ask a caller for a budget.** Only volunteered amounts are used.
- **Decisions are deterministic code** (`src/lib/domain/qualification.ts`). Gemini/Vaani LLMs may only supply validated *facts*.
- **Never claim a booking** without Calendly's confirmation; never blind-retry a booking (look it up first). See `src/lib/services/booking.ts`.
- Mock adapters must stay **labelled** (`mode: 'mock' | 'seed'`) and must never be reported as real activity. Production without credentials fails closed.
- Secrets are server-side only; never add `NEXT_PUBLIC_*`; never log secrets or raw personal data (`src/lib/logging/redact.ts`).
- `API_KEYS.txt` (in the parent folder, outside git) holds the user's keys; `npm run keys:sync` copies them to `.env.local`. Never print values.

## Commands
`npm test` · `npm run typecheck` · `npm run lint` · `npm run build` · `npm run dev -- -p 3100` · `npm run simulate:call -- qualified` · `npm run db:seed`
Scripts import server-only modules, so they run with `tsx --conditions=react-server` (already in package.json).
Do **not** open the dev PGlite directory from a second process while `next dev` is running.

## Conventions
- Next.js 16: `proxy.ts` (not middleware), async `params`/`searchParams`, `after()` for post-response work.
- Services take a `db` argument; routes call `getDb()`. Tests use `tests/helpers/harness.ts` (shared in-memory DB, truncated per test).
- Every external side effect goes through the outbox (`src/lib/services/outbox.ts`) with a unique idempotency key.
- Add a migration (`npm run db:generate`) for any schema change; commit `drizzle/`.
