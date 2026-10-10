/**
 * Server-composed wording handed to the voice agent. Fixed templates only - no LLM, no numbers, no prices.
 * Tone follows the front-desk examples in the September transcripts (honest, polite, specific).
 */

export const QUESTIONS = {
  intent: "Are you looking for full design and execution, or design advice only?",
  projectKind: "What kind of space is it, and what would you like us to design?",
  locality: "Which locality is the property in?",
  timeline: "When would you need the project completed, and when will the site be available?",
} as const;

export const CLOSING: Record<string, string> = {
  out_of_area:
    "We currently take on projects only in Pune and PCMC, because our execution depends on our own contractors and vendors being on site. I'm sorry we can't help with this one.",
  advice_only:
    "We're a full-service studio, so our projects include design and execution together. We don't do advisory-only or styling-only visits. If you're planning a full redesign with execution, we'd be a great fit — please call back whenever you're ready.",
  excluded_category:
    "That type of space is outside what we currently take on. We focus on homes and smaller offices, clinics and studios, so a specialist in that area would serve you better. Thank you for thinking of us.",
  below_minimum_commercial_scope:
    "That space is smaller than what our design and execution team is set up for, and we wouldn't want to promise a quality we can't deliver. A local designer who specialises in smaller spaces would suit you better.",
  timeline_impossible:
    "Our design phase alone takes a few weeks and execution follows, so we couldn't do justice to a project on that timeline and we wouldn't want to rush it. If your timing becomes more flexible, please do get in touch.",
  budget_clearly_inadequate:
    "From what you've shared, the budget would be significantly below what a project of that scope with full execution would involve with us, and I wouldn't want to bring you to a consultation where the numbers don't align. Thank you for being upfront.",
  multiple:
    "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.",
  generic:
    "This sounds like it may not be the right fit for us right now — but feel free to reach out if your timeline or scope changes.",
};

export function escalationAgentLine(callbackMinutes: number | null): string {
  const when = callbackMinutes ? ` within about ${callbackMinutes} minutes` : " as soon as possible";
  return `I'm sorry about that. I'm passing this to a senior colleague right now, and they will call you back${when}. I can't resolve it on this call myself.`;
}

export const BORDERLINE_AGENT_LINE =
  "Thank you — I've noted everything you've shared. One of our senior team members will review it and get back to you. I'm not able to confirm a consultation on this call.";

export const BOOKING_FAILURE_AGENT_LINE =
  "I wasn't able to confirm that booking just now. I've noted your preferred time and a colleague will call you back to confirm it. I'm sorry for the inconvenience.";
