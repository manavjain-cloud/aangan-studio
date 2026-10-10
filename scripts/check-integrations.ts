import { allIntegrationStatuses } from "@/lib/env";
import { getCalendly, getEmail, getGemini, getHubspot, getVaani } from "@/lib/integrations";

/** Prints each integration's mode and runs its health check. Live checks make one harmless authenticated call each. */
const checks: Array<[string, () => Promise<{ ok: boolean; detail: string }>]> = [
  ["vaani", () => getVaani().health()],
  ["gemini", () => getGemini().health()],
  ["hubspot", () => getHubspot().health()],
  ["calendly", () => getCalendly().health()],
  ["email", () => getEmail().health()],
];

console.log("Integration status\n------------------");
for (const s of allIntegrationStatuses()) {
  console.log(`${s.name.padEnd(9)} mode=${s.mode.padEnd(12)} ${s.missing.length ? `missing: ${s.missing.join(", ")}` : ""}`);
}
console.log("\nHealth checks\n-------------");
for (const [name, fn] of checks) {
  try {
    const r = await fn();
    console.log(`${name.padEnd(9)} ${r.ok ? "OK  " : "FAIL"} ${r.detail}`);
  } catch (err) {
    console.log(`${name.padEnd(9)} FAIL ${(err as Error).message}`);
  }
}
