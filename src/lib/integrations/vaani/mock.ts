import type { VaaniCallDetails, VaaniCallRecord, VaaniClient, VaaniWebSession } from "./types";

interface MockVaaniState {
  details: Map<string, VaaniCallDetails>;
  history: VaaniCallRecord[];
}
const g = globalThis as unknown as { __mockVaani?: MockVaaniState };
const state = (): MockVaaniState => (g.__mockVaani ??= { details: new Map(), history: [] });

/** Simulated Vaani REST API. Tests and the call simulator register details/history explicitly. */
export class MockVaaniClient implements VaaniClient {
  readonly mode = "mock" as const;

  static reset() {
    g.__mockVaani = { details: new Map(), history: [] };
  }
  static setDetails(callId: string, d: VaaniCallDetails) {
    state().details.set(callId, d);
  }
  static addHistory(r: VaaniCallRecord) {
    state().history.push(r);
  }

  async createWebSession(): Promise<VaaniWebSession> {
    return { token: "mock-token", url: "wss://mock.invalid", room: `webrtc-mock-${Date.now().toString(36)}` };
  }
  async getCallDetails(callId: string): Promise<VaaniCallDetails> {
    return state().details.get(callId) ?? { transcript: null, summary: null, entities: null, evalTag: null, ready: false };
  }
  async getCallHistory() {
    return { records: [...state().history], hasNext: false };
  }
  async health() {
    return { ok: true, detail: "mock client (simulated; no Vaani account is contacted)" };
  }
}
