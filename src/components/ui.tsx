import type { ReactNode } from "react";

export function PageHeader({ eyebrow, title, children, actions }: { eyebrow?: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between mb-8 fade-rise">
      <div className="max-w-2xl">
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h1 className="display-page">{title}</h1>
        {children && <div className="mt-3 text-muted text-[15px]">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

const DISPOSITION: Record<string, { label: string; cls: string }> = {
  qualified: { label: "Qualified", cls: "badge-ok" },
  rejected: { label: "Declined", cls: "badge-bad" },
  human_escalation: { label: "Escalated", cls: "badge-warn" },
  clarification_required: { label: "Unclear", cls: "badge-info" },
};

export function DispositionBadge({ value }: { value: string }) {
  const d = DISPOSITION[value] ?? { label: value.replace(/_/g, " "), cls: "badge-neutral" };
  return <span className={`badge ${d.cls}`}>{d.label}</span>;
}

export function ModeBadge({ mode }: { mode: string }) {
  if (mode === "live") return null;
  return (
    <span className="badge badge-sim" title={mode === "seed" ? "Development sample data" : "Simulated by a mock adapter - not real activity"}>
      {mode === "seed" ? "Sample" : "Simulated"}
    </span>
  );
}

export function StatusPill({ tone, children }: { tone: "ok" | "warn" | "bad" | "info" | "neutral"; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function Stat({ label, value, sub, tone, hint }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "ok" | "warn" | "bad"; hint?: string }) {
  const color = tone === "bad" ? "text-bad" : tone === "warn" ? "text-warn" : tone === "ok" ? "text-ok" : "text-ink";
  return (
    <div className="card p-5 flex flex-col gap-1.5" title={hint}>
      <span className="text-[12px] font-medium uppercase tracking-[0.1em] text-subtle">{label}</span>
      <span className={`num text-[32px] leading-none font-semibold tracking-tight ${color}`}>{value}</span>
      {sub && <span className="text-[13px] text-muted">{sub}</span>}
    </div>
  );
}

export function Section({ title, hint, children, right }: { title: string; hint?: ReactNode; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="card p-5 md:p-6">
      <div className="flex items-start justify-between gap-4 mb-4">
        <div>
          <h2 className="text-[17px] font-semibold tracking-tight">{title}</h2>
          {hint && <p className="text-[13px] text-muted mt-1 max-w-xl">{hint}</p>}
        </div>
        {right}
      </div>
      {children}
    </section>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="py-10 text-center">
      <p className="font-display text-[26px] tracking-tight">{title}</p>
      {children && <p className="mt-2 text-muted text-sm max-w-md mx-auto">{children}</p>}
    </div>
  );
}

export function fmtPct(v: number | null, digits = 0): string {
  return v === null ? "n/a" : `${v.toFixed(digits)}%`;
}

export function fmtInr(v: number | null): string {
  if (v === null) return "n/a";
  return `₹${v.toLocaleString("en-IN", { maximumFractionDigits: v < 100 ? 2 : 0 })}`;
}

export function fmtDuration(sec: number | null): string {
  if (sec === null) return "n/a";
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)} s`;
  return `${(sec / 60).toFixed(1)} min`;
}

export function fmtMinutes(min: number | null): string {
  if (min === null) return "n/a";
  if (min < 90) return `${Math.round(min)} min`;
  if (min < 48 * 60) return `${(min / 60).toFixed(1)} h`;
  return `${(min / 1440).toFixed(1)} days`;
}

export const INTEGRATION_LABELS: Record<string, string> = {
  vaani: "Vaani",
  gemini: "Gemini",
  hubspot: "HubSpot",
  calendly: "Calendar (Calendly / Cal.com)",
  email: "Email",
  neon: "Neon",
};
