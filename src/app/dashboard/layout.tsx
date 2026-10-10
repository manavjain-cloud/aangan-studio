import { sql } from "drizzle-orm";
import { FlaskConical } from "lucide-react";
import Link from "next/link";
import { signOut } from "@/app/actions/auth";
import { MobileNav, SidebarNav } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { requireViewer } from "@/lib/auth";
import { getDb } from "@/lib/db/client";
import { calls } from "@/lib/db/schema";

export const dynamic = "force-dynamic";

async function composition() {
  const db = await getDb();
  const rows = await db.select({ mode: calls.mode, n: sql<number>`count(*)::int` }).from(calls).groupBy(calls.mode);
  const get = (m: string) => rows.find((r) => r.mode === m)?.n ?? 0;
  return { live: get("live"), mock: get("mock"), seed: get("seed") };
}

function Account({ email, isAdmin }: { email: string; isAdmin: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <ThemeToggle className="self-start" />
      <Link href="/talk" className="text-[13px] underline underline-offset-4">Try the voice call</Link>
      <p className="text-[12px] text-subtle break-all">{email}</p>
      {isAdmin ? (
        <form action={signOut}>
          <button type="submit" className="btn btn-ghost btn-sm">Sign out</button>
        </form>
      ) : (
        <Link href="/?signin=1" className="btn btn-ghost btn-sm self-start">Admin sign in</Link>
      )}
    </div>
  );
}

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const admin = await requireViewer();
  const c = await composition();
  const simulated = c.mock + c.seed;

  return (
    <div className="min-h-screen md:grid md:grid-cols-[248px_1fr]">
      <MobileNav>
        <Account email={admin.email} isAdmin={admin.isAdmin} />
      </MobileNav>

      <aside className="hidden md:flex flex-col justify-between sticky top-0 h-screen px-5 py-7 border-r hairline" style={{ background: "var(--surface)" }}>
        <div className="flex flex-col gap-8">
          <div>
            <p className="font-display text-[26px] leading-none tracking-tight">Aangan Studio</p>
            <p className="eyebrow mt-2">Enquiry desk</p>
          </div>
          <SidebarNav />
        </div>
        <Account email={admin.email} isAdmin={admin.isAdmin} />
      </aside>

      <div className="min-w-0">
        {simulated > 0 && (
          <div className="flex items-start gap-3 px-4 md:px-10 py-2.5 text-[13px] border-b hairline" style={{ background: "var(--brass-soft)", color: "var(--text)" }} role="status">
            <FlaskConical size={16} className="mt-0.5 shrink-0" aria-hidden />
            <p>
              <strong className="font-medium">Development data present.</strong> {c.seed > 0 && `${c.seed} sample call${c.seed === 1 ? "" : "s"}`}
              {c.seed > 0 && c.mock > 0 && " and "}
              {c.mock > 0 && `${c.mock} simulated call${c.mock === 1 ? "" : "s"}`} come from seed scripts or mock adapters, not real callers.
              {c.live === 0 ? " There are no live calls yet." : ` ${c.live} live call${c.live === 1 ? "" : "s"} recorded.`} Use <em>Live only</em> to exclude them.
            </p>
          </div>
        )}
        <main className="px-4 md:px-10 py-8 md:py-10 max-w-[1240px]">{children}</main>
      </div>
    </div>
  );
}
