"use client";

import { Pause, Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const SRC = "https://designerstephen.github.io/public-assets/videos/serene-art-hero.mp4";

/**
 * Cinematic backdrop for the entry page only (never the dashboard). Muted, looping, no audio. Falls back to the
 * solid deep-teal colour while loading, if the file fails, or when the visitor prefers reduced motion (in which
 * case it does not autoplay). A real play/pause button is provided.
 */
export function HeroVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    // The media events may already have fired before hydration, so read the element's current state.
    if (v.readyState >= 2) setReady(true);
    if (v.error) setFailed(true);
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduce) v.play().catch(() => undefined);
  }, []);

  function toggle() {
    const v = ref.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => undefined);
    else v.pause();
  }

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background: "var(--fallback-video)" }}>
      {!failed && (
        <video
          ref={ref}
          className="hero-video"
          style={{ opacity: ready ? 1 : 0, transition: "opacity 1.2s ease" }}
          src={SRC}
          muted
          loop
          playsInline
          preload="metadata"
          onLoadedData={() => setReady(true)}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onError={() => setFailed(true)}
          tabIndex={-1}
          aria-hidden
        />
      )}
      <div className="absolute inset-0" style={{ background: "linear-gradient(180deg, var(--scrim) 0%, rgba(7,18,28,0.25) 45%, var(--scrim) 100%)" }} />
      {!failed && (
        <button
          type="button"
          onClick={toggle}
          className="btn btn-ghost btn-sm absolute bottom-5 right-5"
          style={{ color: "#fff", borderColor: "rgba(255,255,255,0.5)", background: "rgba(0,0,0,0.25)" }}
          aria-label={playing ? "Pause background video" : "Play background video"}
        >
          {playing ? <Pause size={14} aria-hidden /> : <Play size={14} aria-hidden />}
          <span>{playing ? "Pause" : "Play"}</span>
        </button>
      )}
    </div>
  );
}
