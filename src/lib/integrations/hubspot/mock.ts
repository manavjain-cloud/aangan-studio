import {
  HubspotError,
  type HubspotClient,
  type HubspotContactInput,
  type HubspotDealInput,
  type PropertyDef,
} from "./types";

interface MockContact {
  id: string;
  email: string | null;
  phone: string | null;
  name: string | null;
  properties: Record<string, string | number>;
}

interface MockHubspotState {
  contacts: MockContact[];
  notes: Map<string, { contactId: string; body: string }>;
  deals: Map<string, { contactId: string; name: string; stage: string }>;
  properties: Set<string>;
  failNext: HubspotError | null;
  failAlways: HubspotError | null;
  seq: number;
  upsertCalls: number;
}

const g = globalThis as unknown as { __mockHubspot?: MockHubspotState };
const fresh = (): MockHubspotState => ({ contacts: [], notes: new Map(), deals: new Map(), properties: new Set(), failNext: null, failAlways: null, seq: 0, upsertCalls: 0 });
const state = () => (g.__mockHubspot ??= fresh());

/** Simulated HubSpot. Same matching/no-overwrite semantics as the live client, but nothing leaves the process. */
export class MockHubspotClient implements HubspotClient {
  readonly mode = "mock" as const;

  static reset() {
    g.__mockHubspot = fresh();
  }
  static failNext(err: HubspotError | null) {
    state().failNext = err;
  }
  static failAlways(err: HubspotError | null) {
    state().failAlways = err;
  }
  static get snapshot() {
    const s = state();
    return { contacts: s.contacts.map((c) => ({ ...c })), notes: [...s.notes.entries()], deals: [...s.deals.entries()], upsertCalls: s.upsertCalls };
  }

  private maybeFail() {
    const s = state();
    if (s.failAlways) throw s.failAlways;
    if (s.failNext) {
      const e = s.failNext;
      s.failNext = null;
      throw e;
    }
  }

  async ensureProperties(defs: PropertyDef[]) {
    this.maybeFail();
    const s = state();
    const created: string[] = [];
    const existing: string[] = [];
    for (const d of defs) {
      if (s.properties.has(d.name)) existing.push(d.name);
      else {
        s.properties.add(d.name);
        created.push(d.name);
      }
    }
    return { created, existing };
  }

  async upsertContact(input: HubspotContactInput) {
    this.maybeFail();
    const s = state();
    s.upsertCalls++;
    let matchedBy: "email" | "phone" | null = null;
    let c = input.email ? s.contacts.find((x) => x.email === input.email) : undefined;
    if (c) matchedBy = "email";
    if (!c && input.phone) {
      c = s.contacts.find((x) => x.phone === input.phone);
      if (c) matchedBy = "phone";
    }
    if (c) {
      if (!c.name && input.name) c.name = input.name;
      if (!c.email && input.email) c.email = input.email;
      if (!c.phone && input.phone) c.phone = input.phone;
      Object.assign(c.properties, input.properties);
      return { id: c.id, created: false, matchedBy };
    }
    c = { id: `mock-contact-${++s.seq}`, email: input.email, phone: input.phone, name: input.name, properties: { ...input.properties } };
    s.contacts.push(c);
    return { id: c.id, created: true, matchedBy: null };
  }

  async upsertNote(input: { contactId: string; existingNoteId?: string | null; body: string }) {
    this.maybeFail();
    const s = state();
    if (input.existingNoteId && s.notes.has(input.existingNoteId)) {
      s.notes.set(input.existingNoteId, { contactId: input.contactId, body: input.body });
      return { id: input.existingNoteId };
    }
    const id = `mock-note-${++s.seq}`;
    s.notes.set(id, { contactId: input.contactId, body: input.body });
    return { id };
  }

  async upsertDeal(input: HubspotDealInput) {
    this.maybeFail();
    const s = state();
    if (input.existingDealId && s.deals.has(input.existingDealId)) {
      s.deals.set(input.existingDealId, { contactId: input.contactId, name: input.name, stage: input.stage });
      return { id: input.existingDealId };
    }
    const id = `mock-deal-${++s.seq}`;
    s.deals.set(id, { contactId: input.contactId, name: input.name, stage: input.stage });
    return { id };
  }

  async health() {
    return { ok: true, detail: "mock client (simulated CRM; nothing is written to HubSpot)" };
  }
}
