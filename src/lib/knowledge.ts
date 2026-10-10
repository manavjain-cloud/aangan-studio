import fs from "node:fs";
import path from "node:path";
import { APPROVED_PRICING_RESPONSE } from "./domain/pricing-guard";

/**
 * Trusted server-side knowledge layer. Loads the business source documents from content/knowledge/ and exposes
 * ONLY what each consumer is allowed to see:
 *
 *  - services.md  -> full text (service scope, areas, exclusions, timelines). Safe to place in prompts.
 *  - qualified.md -> full text (Nikhil's rubric). Authoritative; the executable rules live in domain/qualification.ts.
 *  - pricing.md   -> NEVER exposed. Only the approved deflection sentence and the "must never say" list are read
 *                    out of it. The indicative price tables are not loaded into any variable that leaves this file.
 */

export interface Knowledge {
  servicesDigest: string;
  qualifiedRubric: string;
  approvedPricingResponse: string;
  mustNeverSay: string[];
  /** True if pricing.md still contains exactly the approved sentence hard-coded in pricing-guard.ts. */
  pricingResponseMatchesSource: boolean;
  sources: Array<{ file: string; present: boolean }>;
}

let cache: Knowledge | null = null;

function read(file: string): string | null {
  try {
    return fs.readFileSync(path.join(process.cwd(), "content", "knowledge", file), "utf8");
  } catch {
    return null;
  }
}

const normalise = (s: string) => s.replace(/[—–]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();

export function loadKnowledge(): Knowledge {
  if (cache) return cache;
  const services = read("services.md");
  const qualified = read("qualified.md");
  const pricing = read("pricing.md");

  let matches = false;
  let never: string[] = [];
  if (pricing) {
    // Only the quoted approved sentence and the "never say" bullets are extracted; the tables are discarded.
    const m = /acceptable response to a pricing question\*\*:\s*"([^"]+)"/i.exec(pricing);
    matches = !!m && normalise(m[1]!) === normalise(APPROVED_PRICING_RESPONSE);
    const section = /What the agent must never say\s*\n+([\s\S]*?)(?:\n\*\*|$)/i.exec(pricing);
    never = (section?.[1] ?? "")
      .split("\n")
      .map((l) => l.replace(/^[-*]\s*/, "").trim())
      .filter(Boolean);
  }

  cache = {
    servicesDigest: services ?? "(services.md not found - service scope unavailable)",
    qualifiedRubric: qualified ?? "(qualified.md not found)",
    approvedPricingResponse: APPROVED_PRICING_RESPONSE,
    mustNeverSay: never,
    pricingResponseMatchesSource: matches,
    sources: [
      { file: "services.md", present: services !== null },
      { file: "qualified.md", present: qualified !== null },
      { file: "pricing.md", present: pricing !== null },
    ],
  };
  return cache;
}

export function resetKnowledgeCache(): void {
  cache = null;
}
