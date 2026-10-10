import Link from "next/link";
import { HeroVideo } from "@/components/hero-video";
import { ThemeToggle } from "@/components/theme-toggle";
import { WebCall } from "@/components/web-call";
import { integrationStatus } from "@/lib/env";

export const dynamic = "force-dynamic";
export const metadata = { title: "Talk to the studio" };

/** Public page for the in-browser voice call (the only way into the phone workflow; no telephone number is involved). */
export default function TalkPage() {
  return (
    <main className="relative min-h-screen flex flex-col text-white">
      <HeroVideo />
      <div className="relative z-10 flex items-center justify-between px-6 md:px-12 pt-6">
        <span className="text-[14px] font-medium tracking-[0.18em] uppercase">Aangan Studio</span>
        <ThemeToggle className="!text-white !border-white/50 !bg-black/20" />
      </div>
      <div className="relative z-10 flex-1 px-6 md:px-12 pb-10 pt-10 md:pt-6 max-w-[1280px] w-full mx-auto flex flex-col justify-center">
        <p className="eyebrow fade-rise" style={{ color: "#e9dcc0" }}>Enquiry desk &middot; Pune</p>
        <h1 className="display-hero mt-4 fade-rise">Tell us about your space.</h1>
        <p className="lede mt-6 max-w-xl fade-rise-d2" style={{ color: "rgba(255,255,255,0.86)" }}>
          Speak with the studio&rsquo;s assistant about your project, and if it is a good fit, book a consultation with one of our designers.
        </p>
        <WebCall available={integrationStatus("vaani").mode === "live"} />
        <Link href="/dashboard" className="mt-10 text-[13px] underline underline-offset-4 self-start" style={{ color: "rgba(255,255,255,0.8)" }}>
          Open the enquiry dashboard
        </Link>
      </div>
    </main>
  );
}
