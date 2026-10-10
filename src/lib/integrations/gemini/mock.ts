import { auditAgentPriceDisclosure } from "../../domain/pricing-guard";
import { geminiAnalysisSchema, type AnalyzeTranscriptInput, type AnalyzeTranscriptResult, type GeminiClient } from "./types";

/**
 * Simulated Gemini. Performs NO language understanding: it never invents facts, it keeps the facts already
 * captured live during the call and produces a plainly-labelled placeholder summary. The deterministic
 * price-disclosure audit is real because it is regex-based and needs no model.
 */
export class MockGeminiClient implements GeminiClient {
  readonly mode = "mock" as const;
  /** Tests can force the next response to be invalid, or the service to be down. */
  static behaviour: "ok" | "invalid_output" | "unavailable" = "ok";

  async analyzeTranscript(input: AnalyzeTranscriptInput): Promise<AnalyzeTranscriptResult> {
    const { GeminiInvalidOutputError, GeminiUnavailableError } = await import("./types");
    if (MockGeminiClient.behaviour === "unavailable") throw new GeminiUnavailableError("mock: Gemini unavailable");
    if (MockGeminiClient.behaviour === "invalid_output") {
      throw new GeminiInvalidOutputError("mock: structured output failed schema validation");
    }
    const audit = auditAgentPriceDisclosure(input.transcript);
    const f = input.currentFacts;
    const analysis = geminiAnalysisSchema.parse({
      facts: { ...f },
      summary: `[SIMULATED SUMMARY - Gemini not configured] Call transcript of ${input.transcript.length} characters. ${
        f.location_text ? `Location: ${f.location_text}. ` : ""
      }${f.scope ? `Scope: ${f.scope.replace(/_/g, " ")}. ` : ""}`.trim(),
      handoff_note: "[SIMULATED] Live Gemini summarisation is not configured. Facts shown were captured by the voice agent during the call.",
      customer_confirmed_slot: null,
      agent_stated_price: audit.violated,
    });
    return { analysis, usage: { inputTokens: 0, outputTokens: 0, model: "mock" } };
  }

  async health() {
    return { ok: true, detail: "mock client (simulated)" };
  }
}
