/**
 * Deterministic service-area matching. Source of truth: services.md "Service area".
 *
 *  - NAMED localities (services.md) -> in_area, high confidence.
 *  - Other Pune-city localities -> in_area with a caveat. services.md says "Pune city (including ... and
 *    adjoining areas)", and the transcripts (T08 Nanded City, T10 Kharadi) show such areas being treated as
 *    Pune. The list below is an ASSUMED extension that needs Nikhil's confirmation.
 *  - Explicitly excluded places (services.md + obvious other cities) -> out_of_area.
 *  - Anything else -> unknown (the agent asks "Which locality is the property in?"). Never a silent pass.
 */

export type AreaStatus = "in_area" | "out_of_area" | "unknown";

export interface AreaMatch {
  status: AreaStatus;
  matched: string | null;
  confidence: "named_in_services" | "assumed_pune_city" | "excluded" | "none";
  caveat: string | null;
}

const NAMED_PUNE = [
  "kothrud", "baner", "aundh", "wakad", "koregaon park", "kalyani nagar", "viman nagar", "hadapsar",
  "magarpatta", "nibm", "kondhwa", "undri", "shivane", "warje", "erandwane", "deccan",
];
const NAMED_PCMC = ["pimpri", "chinchwad", "pimple saudagar", "pimple nilakh", "ravet", "hinjewadi"];

const ALIASES: Record<string, string> = {
  "pimpri chinchwad": "pimpri",
  pcmc: "pimpri",
  cybercity: "magarpatta",
  "nibm road": "nibm",
  "koregaon park": "koregaon park",
  "kalyani nagar": "kalyani nagar",
  "viman nagar": "viman nagar",
  "deccan gymkhana": "deccan",
  "pimple saudagar": "pimple saudagar",
};

// Assumed "adjoining areas" within Pune city. Needs confirmation (README: open business decisions).
const ASSUMED_PUNE_CITY = [
  "kharadi", "nanded city", "nanded", "sinhagad road", "bavdhan", "balewadi", "pashan", "sus", "wanowrie",
  "camp", "shivajinagar", "karve nagar", "karvenagar", "bibwewadi", "katraj", "dhanori", "wagholi",
  "lohegaon", "mundhwa", "yerwada", "sadashiv peth", "kasba peth", "swargate", "dhayari", "ambegaon",
  "bhugaon", "mohammadwadi", "pune",
];

// services.md: "We do not currently serve Talegaon, Lonavala, Nashik, Mumbai, or other cities outside this area."
const EXCLUDED = [
  "talegaon", "lonavala", "lonavla", "nashik", "nasik", "mumbai", "navi mumbai", "thane", "nagpur", "solapur",
  "kolhapur", "satara", "sangli", "aurangabad", "sambhajinagar", "ahmednagar", "bangalore", "bengaluru",
  "hyderabad", "delhi", "gurgaon", "gurugram", "noida", "chennai", "kolkata", "ahmedabad", "goa", "indore",
  "surat", "jaipur", "kochi", "mysore", "mysuru", "vadodara", "bhopal", "lucknow", "chandigarh",
];

function normalise(text: string): string {
  return ` ${text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()} `;
}

function containsPhrase(haystack: string, phrase: string): boolean {
  return haystack.includes(` ${phrase} `);
}

export function matchServiceArea(locationText: string | null | undefined): AreaMatch {
  if (!locationText || !locationText.trim()) {
    return { status: "unknown", matched: null, confidence: "none", caveat: null };
  }
  const text = normalise(locationText);

  const excludedHit = EXCLUDED.find((p) => containsPhrase(text, p));
  const namedHit = [...NAMED_PUNE, ...NAMED_PCMC, ...Object.keys(ALIASES)].find((p) => containsPhrase(text, p));

  if (excludedHit && namedHit) {
    // e.g. "office in Hinjewadi but the home is in Mumbai" - cannot be decided from one string.
    return {
      status: "unknown",
      matched: null,
      confidence: "none",
      caveat: `Location mentions both an in-area place (${namedHit}) and an out-of-area place (${excludedHit}).`,
    };
  }
  if (excludedHit) {
    return { status: "out_of_area", matched: excludedHit, confidence: "excluded", caveat: null };
  }
  if (namedHit) {
    return { status: "in_area", matched: ALIASES[namedHit] ?? namedHit, confidence: "named_in_services", caveat: null };
  }
  const assumedHit = ASSUMED_PUNE_CITY.find((p) => containsPhrase(text, p));
  if (assumedHit) {
    if (assumedHit === "pune") {
      return {
        status: "in_area",
        matched: "pune",
        confidence: "assumed_pune_city",
        caveat: "Caller said Pune without a specific locality; designer to confirm the exact site location.",
      };
    }
    return {
      status: "in_area",
      matched: assumedHit,
      confidence: "assumed_pune_city",
      caveat: `Locality "${assumedHit}" is not on the named list in services.md but is inside Pune city; designer to confirm.`,
    };
  }
  return { status: "unknown", matched: null, confidence: "none", caveat: null };
}
