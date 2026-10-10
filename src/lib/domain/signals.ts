/**
 * Deterministic text signals. Used as a safety net on post-call transcripts and free-text notes, never as
 * the primary decision-maker: the voice agent reports structured flags, this catches what it missed.
 */

export interface TextSignals {
  complaint: boolean;
  wantsSenior: boolean;
  frustrated: boolean;
  missedFollowup: boolean;
  promptInjection: boolean;
}

const COMPLAINT = [
  /\bmy (project|designer|flat|site|work)\b.*\b(delay|delayed|not (replied|responded|reply)|no (reply|response)|hasn'?t (replied|responded))/i,
  /\b(designer|team) (hasn'?t|has not|did not|didn'?t) (replied|responded|called)/i,
  /\b(project has been going|ongoing project|existing project|current project)\b/i,
  /\bnot acceptable\b/i,
  /\bcomplain(t|ing)?\b/i,
];
const SENIOR = [/\b(speak|talk) to (someone|somebody) (senior|else)\b/i, /\b(nikhil|senior (person|designer|manager)|the (owner|founder|head))\b/i, /\bescalat/i];
const FRUSTRATED = [/\bnot (a )?good sign\b/i, /\bfrustrat/i, /\bfed up\b/i, /\bunacceptable\b/i, /\bno one (replied|responded|called)\b/i, /\bnobody (replied|responded|called)\b/i];
const MISSED_FOLLOWUP = [
  /\b(someone|they) said (they'?d|they would) get back\b/i,
  /\bi('?d| had) called (on )?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|earlier|before)\b/i,
  /\bmessaged? \d+ days? ago\b/i,
  /\bnever (heard|got a call)\b/i,
];
const INJECTION = [
  /ignore (all |any )?(previous|prior|above) (instructions|rules|prompts?)/i,
  /(reveal|show|print|repeat) (your |the )?(system|hidden|internal) (prompt|instructions)/i,
  /you are now (a|an|in)\b/i,
  /\b(developer|admin|debug) mode\b/i,
  /disregard (the )?(rubric|rules|policy)/i,
  /(quote|tell me) (the )?(internal|real) (price|pricing|rates?)/i,
];

const any = (res: RegExp[], text: string) => res.some((r) => r.test(text));

export function scanTextSignals(text: string | null | undefined): TextSignals {
  const t = (text ?? "").slice(0, 60_000);
  return {
    complaint: any(COMPLAINT, t),
    wantsSenior: any(SENIOR, t),
    frustrated: any(FRUSTRATED, t),
    missedFollowup: any(MISSED_FOLLOWUP, t),
    promptInjection: any(INJECTION, t),
  };
}
