"use client";

import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { THEME_STORAGE_KEY } from "@/lib/theme-script";

type Theme = "light" | "dark";

function effectiveTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  if (attr === "light" || attr === "dark") return attr;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(effectiveTheme());
  }, []);

  function toggle() {
    const next: Theme = (theme ?? effectiveTheme()) === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* storage blocked: the choice still applies for this visit */
    }
    setTheme(next);
  }

  const isDark = theme === "dark";
  return (
    <button
      type="button"
      onClick={toggle}
      className={`btn btn-ghost btn-sm ${className}`}
      aria-pressed={isDark}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      data-testid="theme-toggle"
    >
      {isDark ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
      <span>{theme === null ? "Theme" : isDark ? "Light" : "Dark"}</span>
    </button>
  );
}
