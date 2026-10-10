// @vitest-environment jsdom
import fs from "node:fs";
import path from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/dashboard/enquiries" }));

import { HeroVideo } from "@/components/hero-video";
import { MobileNav, SidebarNav } from "@/components/nav";
import { ThemeToggle } from "@/components/theme-toggle";
import { THEME_SCRIPT, THEME_STORAGE_KEY } from "@/lib/theme-script";

function mockMatchMedia(matches: Record<string, boolean>) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (q: string) => ({ matches: !!matches[q], media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false }),
  });
}

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
  mockMatchMedia({});
});
afterEach(() => cleanup());

describe("24. light / dark theme switch", () => {
  it("starts from the operating-system preference and toggles with an accurate accessible name", async () => {
    mockMatchMedia({ "(prefers-color-scheme: dark)": true });
    render(<ThemeToggle />);
    const btn = await screen.findByRole("button", { name: /switch to light theme/i });
    expect(btn.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(btn);
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(screen.getByRole("button", { name: /switch to dark theme/i }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button"));
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("an explicit saved choice beats the OS preference", async () => {
    mockMatchMedia({ "(prefers-color-scheme: dark)": true });
    document.documentElement.setAttribute("data-theme", "light");
    render(<ThemeToggle />);
    expect(await screen.findByRole("button", { name: /switch to dark theme/i })).toBeTruthy();
  });

  it("still switches when browser storage is blocked (private window / cleared site data)", async () => {
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<ThemeToggle />);
    const btn = await screen.findByRole("button");
    expect(() => fireEvent.click(btn)).not.toThrow();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    spy.mockRestore();
  });

  it("the pre-paint script applies a saved theme, ignores junk, and never throws without storage", () => {
    localStorage.setItem(THEME_STORAGE_KEY, "dark");
    new Function(THEME_SCRIPT)();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
    localStorage.setItem(THEME_STORAGE_KEY, "<script>");
    new Function(THEME_SCRIPT)();
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => new Function(THEME_SCRIPT)()).not.toThrow();
    spy.mockRestore();
  });
});

describe("design tokens (static checks on globals.css)", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
  const block = (start: RegExp) => {
    const m = start.exec(css)!;
    let i = css.indexOf("{", m.index) + 1;
    let depth = 1;
    const from = i;
    while (depth > 0 && i < css.length) {
      if (css[i] === "{") depth++;
      if (css[i] === "}") depth--;
      i++;
    }
    return css.slice(from, i - 1);
  };
  const vars = (b: string) => new Set([...b.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));

  it("light, dark and OS-dark themes define the same semantic tokens", () => {
    const light = vars(block(/^:root\s*\{/m));
    const dark = vars(block(/^:root\[data-theme="dark"\]\s*\{/m));
    const os = vars(block(/@media \(prefers-color-scheme: dark\)\s*\{/));
    for (const t of ["--bg", "--surface", "--surface-2", "--border", "--text", "--muted", "--primary", "--primary-fg", "--primary-hover", "--input", "--ring", "--ok", "--warn", "--bad", "--chart-1", "--chart-5", "--chart-grid", "--elevated"]) {
      expect(light.has(t), `light ${t}`).toBe(true);
      expect(dark.has(t), `dark ${t}`).toBe(true);
      expect(os.has(t), `os-dark ${t}`).toBe(true);
    }
  });

  it("uses the required brand values", () => {
    expect(css).toMatch(/--text:\s*#0f172a/i);
    expect(css).toMatch(/--muted:\s*hsl\(215,\s*25%,\s*32%\)/i);
    expect(css).toMatch(/--fallback-video:\s*hsl\(201,\s*100%,\s*13%\)/i);
    expect(css).toMatch(/\.btn-primary\s*\{[^}]*background:\s*var\(--primary\)/);
  });

  it("hero display style: Instrument Serif 400, 80px desktop / 48px mobile, line-height .95, tracking -2.46px", () => {
    const hero = block(/^\.display-hero\s*\{/m);
    expect(hero).toMatch(/font-weight:\s*400/);
    expect(hero).toMatch(/font-size:\s*48px/);
    expect(hero).toMatch(/line-height:\s*0\.95/);
    expect(hero).toMatch(/letter-spacing:\s*-2\.46px/);
    expect(css).toMatch(/@media \(min-width: 768px\)\s*\{\s*\.display-hero\s*\{\s*font-size:\s*80px/);
  });

  it("fade-rise animation: 24px rise, 0.8s ease-out, delays 0 / 0.2 / 0.4s; buttons scale 1.03 in 0.3s", () => {
    expect(css).toMatch(/@keyframes fade-rise\s*\{\s*from\s*\{\s*opacity:\s*0;\s*transform:\s*translateY\(24px\)/);
    expect(css).toMatch(/\.fade-rise\s*\{\s*animation:\s*fade-rise 0\.8s ease-out both/);
    expect(css).toMatch(/\.fade-rise-d2\s*\{\s*animation:\s*fade-rise 0\.8s ease-out 0\.2s both/);
    expect(css).toMatch(/\.fade-rise-d4\s*\{\s*animation:\s*fade-rise 0\.8s ease-out 0\.4s both/);
    expect(css).toMatch(/\.btn:hover\s*\{\s*transform:\s*scale\(1\.03\)/);
    expect(css).toMatch(/transition:\s*transform 0\.3s/);
  });

  it("respects prefers-reduced-motion", () => {
    const rm = block(/@media \(prefers-reduced-motion: reduce\)\s*\{/);
    expect(rm).toMatch(/\.fade-rise/);
    expect(rm).toMatch(/animation:\s*none/);
    expect(rm).toMatch(/transform:\s*none/);
  });
});

describe("24. responsive behaviour", () => {
  it("mobile navigation is collapsed by default, opens and closes, and marks the current page", () => {
    render(
      <MobileNav>
        <span>account</span>
      </MobileNav>,
    );
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
    const menu = screen.getByRole("button", { name: /menu/i });
    expect(menu.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(menu);
    expect(menu.getAttribute("aria-expanded")).toBe("true");
    const nav = screen.getByRole("navigation", { name: "Primary" });
    expect(nav).toBeTruthy();
    expect(screen.getByText("account")).toBeTruthy();
    expect(screen.getByRole("link", { name: /enquiries/i }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("link", { name: /overview/i }).getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: /exceptions/i }));
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("the sidebar exposes all five management sections and nothing for designers or front desk", () => {
    render(<SidebarNav />);
    const labels = screen.getAllByRole("link").map((a) => a.textContent?.trim());
    expect(labels).toEqual(["Overview", "Enquiries", "Exceptions", "Integrations", "Settings"]);
  });

  it("wide tables scroll inside their own container instead of stretching the page", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "src", "app", "globals.css"), "utf8");
    expect(css).toMatch(/\.table-wrap\s*\{[^}]*overflow-x:\s*auto/);
    expect(css).toMatch(/main \.grid > \*,\s*\.card\s*\{\s*min-width:\s*0/);
  });
});

describe("hero video", () => {
  it("does not autoplay for visitors who prefer reduced motion, and offers a play control", () => {
    mockMatchMedia({ "(prefers-reduced-motion: reduce)": true });
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    render(<HeroVideo />);
    expect(play).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /play background video/i })).toBeTruthy();
    play.mockRestore();
  });

  it("is muted, looping and silent, and falls back to the solid colour with no control when the file fails", () => {
    mockMatchMedia({});
    vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
    const { container } = render(<HeroVideo />);
    const video = container.querySelector("video")!;
    expect(video.muted).toBe(true);
    expect(video.loop).toBe(true);
    fireEvent.error(video);
    expect(container.querySelector("video")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });
});
