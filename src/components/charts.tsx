import type { ReactNode } from "react";

/* Hand-built, dependency-free charts. Colours come from semantic chart tokens so both themes stay legible.
   Every chart has a text alternative (aria-label + a visually hidden table). */

export function BarList({
  items,
  tone = "var(--chart-1)",
  empty = "No data in this period.",
  unit = "",
}: {
  items: Array<{ label: string; value: number; note?: ReactNode; tone?: string }>;
  tone?: string;
  empty?: string;
  unit?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  if (!items.length || items.every((i) => i.value === 0)) return <p className="text-sm text-muted py-4">{empty}</p>;
  return (
    <ul className="flex flex-col gap-3" aria-label="Bar chart">
      {items.map((i) => (
        <li key={i.label}>
          <div className="flex items-baseline justify-between gap-3 text-[13px]">
            <span className="text-ink">{i.label}</span>
            <span className="num text-muted">
              {i.value}
              {unit}
              {i.note ? <span className="ml-2">{i.note}</span> : null}
            </span>
          </div>
          <div className="mt-1.5 h-2 rounded-full" style={{ background: "var(--surface-2)" }}>
            <div className="h-2 rounded-full" style={{ width: `${(i.value / max) * 100}%`, background: i.tone ?? tone, minWidth: i.value > 0 ? 4 : 0 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function FunnelChart({ steps }: { steps: Array<{ key: string; label: string; count: number }> }) {
  const top = Math.max(1, steps[0]?.count ?? 0);
  return (
    <ol className="flex flex-col gap-3" aria-label="Qualification funnel">
      {steps.map((s, i) => {
        const prev = i === 0 ? null : steps[i - 1]!.count;
        const conv = prev && prev > 0 ? Math.round((s.count / prev) * 100) : null;
        return (
          <li key={s.key} className="grid grid-cols-[1fr_auto] gap-x-4 items-center">
            <div>
              <div className="flex items-baseline justify-between text-[13px] mb-1.5">
                <span className="text-ink">{s.label}</span>
                {conv !== null && <span className="text-subtle num">{conv}% of previous</span>}
              </div>
              <div className="h-7 rounded-md" style={{ background: "var(--surface-2)" }}>
                <div
                  className="h-7 rounded-md"
                  style={{ width: `${(s.count / top) * 100}%`, background: i === steps.length - 1 ? "var(--chart-2)" : i === steps.length - 2 ? "var(--chart-3)" : "var(--chart-1)", minWidth: s.count > 0 ? 6 : 0, opacity: 0.92 }}
                />
              </div>
            </div>
            <span className="num text-[22px] font-semibold w-12 text-right">{s.count}</span>
          </li>
        );
      })}
    </ol>
  );
}

interface TrendPoint {
  date: string;
  calls: number;
  qualified: number;
  booked: number;
}

export function TrendChart({ data }: { data: TrendPoint[] }) {
  const W = 760;
  const H = 230;
  const pad = { l: 34, r: 12, t: 12, b: 28 };
  const max = Math.max(4, ...data.map((d) => d.calls));
  const niceMax = Math.ceil(max / 4) * 4;
  const x = (i: number) => pad.l + (data.length <= 1 ? 0 : (i / (data.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + (1 - v / niceMax) * (H - pad.t - pad.b);
  const path = (key: keyof Pick<TrendPoint, "calls" | "qualified" | "booked">) => data.map((d, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(d[key]).toFixed(1)}`).join(" ");
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(niceMax * f));
  const labelEvery = Math.max(1, Math.ceil(data.length / 7));
  const total = data.reduce((s, d) => s + d.calls, 0);

  if (!data.length || total === 0) return <p className="text-sm text-muted py-6">No calls in this period.</p>;
  return (
    <figure>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`Daily calls, qualified leads and bookings. ${total} calls in total.`}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--chart-grid)" strokeWidth="1" />
            <text x={pad.l - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="var(--subtle)" className="num">
              {t}
            </text>
          </g>
        ))}
        {data.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d.date} x={x(i)} y={H - 8} textAnchor="middle" fontSize="11" fill="var(--subtle)">
              {d.date.slice(5)}
            </text>
          ) : null,
        )}
        <path d={path("calls")} fill="none" stroke="var(--chart-1)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={path("qualified")} fill="none" stroke="var(--chart-3)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        <path d={path("booked")} fill="none" stroke="var(--chart-2)" strokeWidth="2" strokeDasharray="5 4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
      <figcaption className="flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted mt-2">
        <Legend color="var(--chart-1)" label="Calls" />
        <Legend color="var(--chart-3)" label="Qualified" />
        <Legend color="var(--chart-2)" label="Booked" dashed />
      </figcaption>
      <table className="sr-only">
        <caption>Daily calls, qualified leads and bookings</caption>
        <thead>
          <tr><th>Date</th><th>Calls</th><th>Qualified</th><th>Booked</th></tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.date}><td>{d.date}</td><td>{d.calls}</td><td>{d.qualified}</td><td>{d.booked}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function Legend({ color, label, dashed }: { color: string; label: string; dashed?: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg width="22" height="8" aria-hidden>
        <line x1="0" x2="22" y1="4" y2="4" stroke={color} strokeWidth="2" strokeDasharray={dashed ? "5 4" : undefined} />
      </svg>
      {label}
    </span>
  );
}
