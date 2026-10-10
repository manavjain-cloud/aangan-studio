import { redirect } from "next/navigation";
import { signIn } from "@/app/actions/auth";
import { HeroVideo } from "@/components/hero-video";
import { ThemeToggle } from "@/components/theme-toggle";
import { getSession } from "@/lib/auth";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

const ERRORS: Record<string, string> = {
  credentials: "That email and password do not match a management account.",
  invalid: "Please enter your email and password.",
  rate: "Too many attempts. Please wait a few minutes and try again.",
  locked: "This account is temporarily locked after repeated failed attempts. Try again in 15 minutes.",
  config: "Sign-in is not configured on this server yet (SESSION_SECRET).",
};

export default async function EntryPage({ searchParams }: { searchParams: Promise<{ error?: string; next?: string }> }) {
  const { error, next } = await searchParams;
  if (await getSession()) redirect("/dashboard");
  const configured = !!getEnv().SESSION_SECRET && getEnv().SESSION_SECRET!.length >= 32;

  return (
    <main className="relative min-h-screen flex flex-col text-white">
      <HeroVideo />

      <div className="relative z-10 flex items-center justify-between px-6 md:px-12 pt-6">
        <span className="text-[14px] font-medium tracking-[0.18em] uppercase">Aangan Studio</span>
        <ThemeToggle className="!text-white !border-white/50 !bg-black/20" />
      </div>

      <div className="relative z-10 flex-1 grid gap-10 md:gap-16 px-6 md:px-12 pb-10 pt-10 md:pt-6 md:grid-cols-[1.25fr_0.75fr] items-center max-w-[1280px] w-full mx-auto">
        <div>
          <p className="eyebrow fade-rise" style={{ color: "#e9dcc0" }}>Enquiry desk &middot; Pune</p>
          <h1 className="display-hero mt-4 fade-rise">Every enquiry, answered with care.</h1>
          <p className="lede mt-6 max-w-xl fade-rise-d2" style={{ color: "rgba(255,255,255,0.86)" }}>
            See how many calls were answered, which leads were worth a designer&rsquo;s time, which consultations were booked &mdash; and what it all
            costs to run.
          </p>
        </div>

        <form action={signIn} className="card p-6 md:p-7 fade-rise-d4 text-ink" style={{ background: "color-mix(in srgb, var(--surface) 94%, transparent)" }}>
          <h2 className="font-display text-[28px] tracking-tight">Management sign in</h2>
          <p className="text-[13px] text-muted mt-1 mb-5">Designers and the front desk receive everything they need by email &mdash; no login required.</p>
          {next && <input type="hidden" name="next" value={next} />}

          {!configured && (
            <p role="alert" className="badge badge-warn !h-auto !py-2 !whitespace-normal mb-4">
              Sign-in is not configured yet. Set SESSION_SECRET (32+ characters) and run <code className="mx-1">npm run admin:create</code>.
            </p>
          )}
          {error && ERRORS[error] && (
            <p role="alert" className="badge badge-bad !h-auto !py-2 !whitespace-normal mb-4">{ERRORS[error]}</p>
          )}

          <label className="label" htmlFor="email">Email</label>
          <input id="email" name="email" type="email" autoComplete="username" required className="field" />
          <label className="label mt-4" htmlFor="password">Password</label>
          <input id="password" name="password" type="password" autoComplete="current-password" required className="field" />
          <button type="submit" className="btn btn-primary w-full mt-6" disabled={!configured}>Sign in</button>
        </form>
      </div>
    </main>
  );
}
