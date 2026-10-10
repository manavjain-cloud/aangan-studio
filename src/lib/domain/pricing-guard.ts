/**
 * Pricing guard. pricing.md is internal policy: the agent may NEVER quote a price, a per-sq-ft figure, a
 * range, a "starting at" figure or a "typical" cost. The only acceptable answer is the approved deflection
 * below, which is verbatim from pricing.md (a test asserts it matches the source file).
 */

export const APPROVED_PRICING_RESPONSE =
  "Pricing depends on the site, the materials you choose, and the scope — your designer will walk you through it in detail at the consultation. I can book that for you right now if you'd like.";

const PRICE_PATTERNS: RegExp[] = [
  /[₹$£€]\s*\d/, // currency symbol followed by a number
  /\b(rs\.?|inr|rupees?)\s*\d/i,
  /\b\d[\d,.]*\s*(lakhs?|lacs?|crores?|cr|k\b|thousand)\b/i,
  /\b(lakhs?|lacs?|crores?)\b/i,
  /\bper\s*(sq\.?\s*ft|square\s*f(ee|oo)t|sqft|sq\s*foot)\b/i,
  /\b\d[\d,.]*\s*\/\s*(sq\.?\s*ft|sqft)\b/i,
  /\b(starts?|starting)\s+(at|from)\b/i,
  /\b(it'?ll|it will|would|will)\s+(cost|be around|be roughly|come to)\b/i,
  /\b(our )?rates?\s+(start|are|is)\b/i,
  /\bfor a \d\s*bhk,? it'?s typically\b/i,
  /\bbudget (range|band) (of|is)\b/i,
];

/** True if the text appears to disclose or imply a price. Deliberately conservative (false positives are cheap). */
export function containsPriceDisclosure(text: string | null | undefined): boolean {
  if (!text) return false;
  return PRICE_PATTERNS.some((p) => p.test(text));
}

/**
 * Final gate for any text the server hands the voice agent to speak. If it looks like a price disclosure,
 * it is replaced by the approved deflection rather than passed through.
 */
export function sanitizeSpokenText(text: string): { text: string; replaced: boolean } {
  if (containsPriceDisclosure(text)) return { text: APPROVED_PRICING_RESPONSE, replaced: true };
  return { text, replaced: false };
}

export interface AgentTurn {
  speaker: "agent" | "user";
  text: string;
}

/** Parse Vaani's "[HH:MM:SS] AGENT: ..." / "AGENT: ..." transcript format into turns. */
export function parseTranscript(transcript: string | null | undefined): AgentTurn[] {
  if (!transcript) return [];
  const turns: AgentTurn[] = [];
  const re = /(?:\[[^\]]*\]\s*)?(AGENT|USER|CALLER|ASSISTANT|CUSTOMER)\s*:\s*([\s\S]*?)(?=(?:\n\s*)?(?:\[[^\]]*\]\s*)?(?:AGENT|USER|CALLER|ASSISTANT|CUSTOMER)\s*:|$)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(transcript)) !== null) {
    const who = (m[1] ?? "").toUpperCase();
    const text = (m[2] ?? "").trim();
    if (!text) continue;
    turns.push({ speaker: who === "AGENT" || who === "ASSISTANT" ? "agent" : "user", text });
  }
  return turns;
}

/** Audit a finished call: did the AGENT ever say something that discloses a price? */
export function auditAgentPriceDisclosure(transcript: string | null | undefined): { violated: boolean; excerpts: string[] } {
  const excerpts = parseTranscript(transcript)
    .filter((t) => t.speaker === "agent" && containsPriceDisclosure(t.text))
    .map((t) => t.text.slice(0, 200));
  return { violated: excerpts.length > 0, excerpts };
}
