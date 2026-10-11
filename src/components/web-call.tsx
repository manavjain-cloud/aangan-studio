"use client";

import { Mic, MicOff, PhoneOff, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Room } from "livekit-client";

type Phase = "idle" | "connecting" | "live" | "ended" | "error";
type Line = { id: string; who: "you" | "assistant"; text: string };

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

/**
 * In-browser voice call with the studio's AI assistant (Vaani over WebRTC). No telephone number is involved: the server
 * creates the session, this component only joins it with the visitor's microphone and plays the assistant's voice.
 */
export function WebCall({ available }: { available: boolean }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [lines, setLines] = useState<Line[]>([]);
  const [speaking, setSpeaking] = useState<"you" | "assistant" | null>(null);
  const [audioBlocked, setAudioBlocked] = useState(false);
  const roomRef = useRef<Room | null>(null);
  const diag = useRef<{ room: string; t0: number; buf: Array<{ t: number; e: string; d?: string }> }>({ room: "", t0: 0, buf: [] });

  /** Records what this browser sees (never audio or speech content) so a failed call can be diagnosed. */
  function note(e: string, d?: string) {
    diag.current.buf.push({ t: Math.round(performance.now() - diag.current.t0), e, ...(d ? { d: d.slice(0, 180) } : {}) });
    if (diag.current.buf.length >= 40) flush();
  }
  function flush() {
    const { room, buf } = diag.current;
    if (!room || buf.length === 0) return;
    diag.current.buf = [];
    try {
      fetch("/api/voice/web-diag", { method: "POST", keepalive: true, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ room, events: buf }) }).catch(() => undefined);
    } catch {
      /* diagnostics are best-effort */
    }
  }

  useEffect(() => {
    const onVis = () => note(`visibility:${document.visibilityState}`);
    const onHide = () => { note("pagehide"); flush(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", onHide);
    const t = setInterval(flush, 4000);
    return () => { document.removeEventListener("visibilitychange", onVis); window.removeEventListener("pagehide", onHide); clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const audioHost = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (phase !== "live") return;
    const t = setInterval(() => setSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  useEffect(() => () => {
    if (roomRef.current) { note("unmount_while_connected"); flush(); }
    void roomRef.current?.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setPhase("connecting");
    setMessage(null);
    setMuted(false);
    setSeconds(0);
    setLines([]);
    setSpeaking(null);
    setAudioBlocked(false);
    try {
      const res = await fetch("/api/voice/web-session", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; token?: string; url?: string; room?: string; message?: string };
      if (!res.ok || !body.ok || !body.token || !body.url) {
        setPhase("error");
        setMessage(body.message ?? "The assistant could not be reached right now. Please try again in a moment.");
        return;
      }
      diag.current = { room: String((body as { room?: string }).room ?? ""), t0: performance.now(), buf: [] };
      note("session_created");
      const { Room, RoomEvent, Track, DisconnectReason } = await import("livekit-client");
      const room = new Room({ adaptiveStream: true, dynacast: true });
      roomRef.current = room;
      room.on(RoomEvent.TrackSubscribed, (track) => {
        if (track.kind === Track.Kind.Audio) { audioHost.current?.appendChild(track.attach()); note("assistant_audio_subscribed"); }
      });
      room.on(RoomEvent.ConnectionStateChanged, (st) => note(`connection:${st}`));
      room.on(RoomEvent.ParticipantDisconnected, (p) => note("participant_left", p.identity));
      room.on(RoomEvent.TrackMuted, (pub, p) => note("track_muted", `${p.isLocal ? "local" : "remote"}:${pub.kind}`));
      room.on(RoomEvent.TrackUnsubscribed, () => note("assistant_track_unsubscribed"));
      room.on(RoomEvent.TrackUnsubscribed, (track) => track.detach().forEach((el) => el.remove()));
      room.on(RoomEvent.AudioPlaybackStatusChanged, () => setAudioBlocked(!room.canPlaybackAudio));
      room.on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        const local = speakers.some((p) => p.isLocal);
        const remote = speakers.some((p) => !p.isLocal);
        setSpeaking(remote ? "assistant" : local ? "you" : null);
        note(`speakers:${remote ? "assistant" : ""}${local ? "+you" : ""}` || "speakers:none");
      });
      // Live captions: the assistant's runtime streams what it heard and what it says on this topic.
      room.registerTextStreamHandler("lk.transcription", async (reader, info) => {
        try {
          const text = (await reader.readAll()).trim();
          if (!text) return;
          const segment = reader.info.attributes?.["lk.segment_id"] ?? reader.info.id;
          const mine = info.identity === room.localParticipant.identity;
          setLines((prev) => {
            const next = prev.filter((l) => l.id !== segment);
            next.push({ id: segment, who: mine ? "you" : "assistant", text });
            return next.slice(-6);
          });
        } catch {
          /* captions are best-effort */
        }
      });
      room.on(RoomEvent.Disconnected, (reason) => {
        note("disconnected", reason === undefined ? "unknown" : (DisconnectReason[reason] ?? String(reason)));
        flush();
        roomRef.current = null;
        setPhase((p) => (p === "error" ? p : "ended"));
      });
      await room.connect(body.url, body.token);
      await room.startAudio().catch(() => undefined);
      setAudioBlocked(!room.canPlaybackAudio);
      try {
        await room.localParticipant.setMicrophoneEnabled(true);
      } catch {
        await room.disconnect();
        setPhase("error");
        setMessage("The microphone is blocked. Allow microphone access in your browser, then try again.");
        return;
      }
      note("mic_on");
      setPhase("live");
    } catch (err) {
      note("error", String((err as Error)?.message ?? err));
      roomRef.current?.disconnect();
      setPhase("error");
      setMessage("The call could not be connected. Please check your connection and try again.");
    }
  }

  async function toggleMute() {
    const room = roomRef.current;
    if (!room) return;
    const next = !muted;
    await room.localParticipant.setMicrophoneEnabled(!next);
    setMuted(next);
  }

  if (!available) {
    return (
      <p className="text-[13px] mt-8 max-w-md" style={{ color: "rgba(255,255,255,0.7)" }}>
        Voice enquiries open here once the assistant is connected.
      </p>
    );
  }

  return (
    <section aria-labelledby="web-call-title" className="mt-8 max-w-md fade-rise-d4">
      <h2 id="web-call-title" className="font-display text-[26px] tracking-tight">Talk to the studio</h2>
      <p className="text-[13px] mt-1" style={{ color: "rgba(255,255,255,0.8)" }}>
        Start a voice call from your browser &mdash; no phone number needed. You will speak with Aangan&rsquo;s AI assistant, and the call may be recorded
        to follow up on your enquiry.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        {(phase === "idle" || phase === "ended" || phase === "error") && (
          <button type="button" className="btn btn-primary" onClick={start}>
            <Mic size={16} aria-hidden /> {phase === "idle" ? "Start voice call" : "Start another call"}
          </button>
        )}
        {phase === "connecting" && <span className="badge" role="status">Connecting&hellip;</span>}
        {phase === "live" && (
          <>
            <span className="badge badge-good" role="status">Live &middot; {clock(seconds)}</span>
            <button type="button" className="btn btn-ghost !text-white !border-white/50" onClick={toggleMute} aria-pressed={muted}>
              {muted ? <MicOff size={16} aria-hidden /> : <Mic size={16} aria-hidden />} {muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className="btn btn-danger" onClick={() => { note("user_clicked_end"); roomRef.current?.disconnect(); }}>
              <PhoneOff size={16} aria-hidden /> End call
            </button>
          </>
        )}
      </div>

      {phase === "live" && audioBlocked && (
        <button type="button" className="btn btn-ghost btn-sm mt-3 !text-white !border-white/50" onClick={() => roomRef.current?.startAudio().then(() => setAudioBlocked(false))}>
          <Volume2 size={14} aria-hidden /> Tap to hear the assistant
        </button>
      )}
      {phase === "live" && (
        <p className="text-[12px] mt-3" style={{ color: "rgba(255,255,255,0.75)" }} role="status">
          {speaking === "assistant" ? "The assistant is speaking…" : speaking === "you" ? "Listening to you…" : muted ? "Your microphone is muted." : "Speak whenever you are ready."}
        </p>
      )}
      {lines.length > 0 && (
        <ul className="mt-3 space-y-1.5 text-[13px]" aria-label="Live captions" aria-live="polite">
          {lines.map((l) => (
            <li key={l.id} style={{ color: l.who === "you" ? "#e9dcc0" : "rgba(255,255,255,0.92)" }}>
              <span className="uppercase tracking-wider text-[10px] opacity-70 mr-2">{l.who === "you" ? "You" : "Assistant"}</span>
              {l.text}
            </li>
          ))}
        </ul>
      )}
      {phase === "ended" && <p className="text-[13px] mt-3" role="status">Call ended. Thank you &mdash; the studio will follow up by email if a consultation was arranged.</p>}
      {message && <p role="alert" className="badge badge-bad !h-auto !py-2 !whitespace-normal mt-3">{message}</p>}
      <div ref={audioHost} aria-hidden style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", opacity: 0, pointerEvents: "none" }} />
    </section>
  );
}
