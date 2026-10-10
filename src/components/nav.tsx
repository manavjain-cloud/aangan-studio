"use client";

import { AlertTriangle, BarChart3, Inbox, Plug, Settings, X, Menu } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

const ITEMS = [
  { href: "/dashboard", label: "Overview", icon: BarChart3, exact: true },
  { href: "/dashboard/enquiries", label: "Enquiries", icon: Inbox },
  { href: "/dashboard/exceptions", label: "Exceptions", icon: AlertTriangle },
  { href: "/dashboard/integrations", label: "Integrations", icon: Plug },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
] as const;

function Links({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Primary" className="flex flex-col gap-1">
      {ITEMS.map((it) => {
        const active = "exact" in it && it.exact ? pathname === it.href : pathname === it.href || pathname.startsWith(`${it.href}/`);
        const Icon = it.icon;
        return (
          <Link
            key={it.href}
            href={it.href}
            onClick={onNavigate}
            aria-current={active ? "page" : undefined}
            className="flex items-center gap-3 rounded-lg px-3 h-10 text-[14px] font-medium transition-colors"
            style={{ background: active ? "var(--surface-2)" : "transparent", color: active ? "var(--text)" : "var(--muted)" }}
          >
            <Icon size={17} aria-hidden />
            {it.label}
          </Link>
        );
      })}
    </nav>
  );
}

export function SidebarNav() {
  return <Links />;
}

/** Mobile: a compact top bar with a toggled panel (no JS-less fallback needed: the dashboard requires JS for forms anyway). */
export function MobileNav({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="md:hidden">
      <div className="flex items-center justify-between h-14 px-4 border-b hairline" style={{ background: "var(--surface)" }}>
        <span className="font-display text-[22px] tracking-tight">Aangan Studio</span>
        <button type="button" className="btn btn-ghost btn-sm" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen((o) => !o)}>
          {open ? <X size={16} aria-hidden /> : <Menu size={16} aria-hidden />}
          <span>{open ? "Close" : "Menu"}</span>
        </button>
      </div>
      {open && (
        <div id="mobile-nav" className="px-4 py-4 border-b hairline flex flex-col gap-4" style={{ background: "var(--surface)" }}>
          <Links onNavigate={() => setOpen(false)} />
          {children}
        </div>
      )}
    </div>
  );
}
