import "server-only";
import { HttpError, NetworkError, httpJson } from "../http";
import {
  HUBSPOT_PROPERTY_GROUP,
  HubspotError,
  type HubspotClient,
  type HubspotContactInput,
  type HubspotDealInput,
  type PropertyDef,
} from "./types";

/**
 * Real HubSpot CRM v3/v4 client using a Private App access token (Bearer). Required scopes:
 * crm.objects.contacts.read/write, crm.schemas.contacts.read/write (custom properties),
 * crm.objects.deals.read/write (only if deals are enabled). Notes use the contacts scopes + engagements.
 */

const BASE = "https://api.hubapi.com";
const STANDARD_READ = ["firstname", "lastname", "email", "phone", "mobilephone"];

function mapError(err: unknown, what: string): HubspotError {
  if (err instanceof HubspotError) return err;
  if (err instanceof NetworkError) return new HubspotError(err.timedOut ? "timeout" : "server_error", `${what}: ${err.message}`);
  if (err instanceof HttpError) {
    const code =
      err.status === 401 ? "unauthorized" : err.status === 403 ? "forbidden" : err.status === 429 ? "rate_limited"
      : err.status >= 500 ? "server_error" : err.status >= 400 ? "invalid_request" : "unknown";
    return new HubspotError(code, `${what}: HTTP ${err.status} ${err.body.slice(0, 160)}`, err.status);
  }
  return new HubspotError("unknown", `${what}: ${String((err as Error)?.message ?? err)}`);
}

function splitName(name: string | null): { firstname?: string; lastname?: string } {
  if (!name) return {};
  const parts = name.trim().split(/\s+/);
  return parts.length === 1 ? { firstname: parts[0] } : { firstname: parts[0], lastname: parts.slice(1).join(" ") };
}

interface ContactRecord {
  id: string;
  properties: Record<string, string | null>;
}

export class LiveHubspotClient implements HubspotClient {
  readonly mode = "live" as const;
  constructor(private readonly token: string, private readonly fetchImpl: typeof fetch = fetch) {}

  private call<T>(opts: Omit<Parameters<typeof httpJson>[0], "integration" | "headers" | "fetchImpl">) {
    return httpJson<T>({ integration: "hubspot", headers: { Authorization: `Bearer ${this.token}` }, fetchImpl: this.fetchImpl, ...opts });
  }

  async ensureProperties(defs: PropertyDef[]) {
    try {
      const existingRes = await this.call<{ results: Array<{ name: string }> }>({ url: `${BASE}/crm/v3/properties/contacts`, retries: 2 });
      const have = new Set(existingRes.data.results.map((p) => p.name));
      const missing = defs.filter((d) => !have.has(d.name));
      if (missing.length) {
        // Create the property group first (409 = already exists, which is fine).
        await this.call({
          url: `${BASE}/crm/v3/properties/contacts/groups`, method: "POST",
          body: { name: HUBSPOT_PROPERTY_GROUP.name, label: HUBSPOT_PROPERTY_GROUP.label, displayOrder: -1 },
        }).catch((e) => {
          if (!(e instanceof HttpError && e.status === 409)) throw e;
        });
      }
      const created: string[] = [];
      for (const d of missing) {
        try {
          await this.call({
            url: `${BASE}/crm/v3/properties/contacts`, method: "POST",
            body: { name: d.name, label: d.label, type: d.type, fieldType: d.fieldType, groupName: HUBSPOT_PROPERTY_GROUP.name, description: d.description ?? "Written by the Aangan Studio phone qualification system." },
          });
          created.push(d.name);
        } catch (e) {
          if (!(e instanceof HttpError && e.status === 409)) throw e; // created concurrently
        }
      }
      return { created, existing: defs.filter((d) => have.has(d.name)).map((d) => d.name) };
    } catch (err) {
      throw mapError(err, "ensure properties");
    }
  }

  private async search(propertyName: string, value: string): Promise<ContactRecord | null> {
    const groups =
      propertyName === "phone"
        ? [
            { filters: [{ propertyName: "phone", operator: "EQ", value }] },
            { filters: [{ propertyName: "mobilephone", operator: "EQ", value }] },
          ]
        : [{ filters: [{ propertyName, operator: "EQ", value }] }];
    const { data } = await this.call<{ results: ContactRecord[] }>({
      url: `${BASE}/crm/v3/objects/contacts/search`, method: "POST",
      body: { filterGroups: groups, properties: STANDARD_READ, limit: 2 }, retries: 2,
    });
    return data.results[0] ?? null;
  }

  async upsertContact(input: HubspotContactInput) {
    try {
      let found: ContactRecord | null = null;
      let matchedBy: "email" | "phone" | null = null;
      if (input.email) {
        found = await this.search("email", input.email);
        if (found) matchedBy = "email";
      }
      if (!found && input.phone) {
        found = await this.search("phone", input.phone);
        if (found) matchedBy = "phone";
      }

      if (found) {
        const cur = found.properties;
        const fill: Record<string, string> = {};
        const nm = splitName(input.name);
        // Never overwrite existing customer data: only fill blanks.
        if (!cur.firstname && nm.firstname) fill.firstname = nm.firstname;
        if (!cur.lastname && nm.lastname) fill.lastname = nm.lastname;
        if (!cur.email && input.email) fill.email = input.email;
        if (!cur.phone && !cur.mobilephone && input.phone) fill.phone = input.phone;
        await this.call({
          url: `${BASE}/crm/v3/objects/contacts/${found.id}`, method: "PATCH",
          body: { properties: { ...fill, ...input.properties } }, retries: 2,
        });
        return { id: found.id, created: false, matchedBy };
      }

      const body = { properties: { ...splitName(input.name), ...(input.email ? { email: input.email } : {}), ...(input.phone ? { phone: input.phone } : {}), ...input.properties } };
      try {
        const { data } = await this.call<{ id: string }>({ url: `${BASE}/crm/v3/objects/contacts`, method: "POST", body, timeoutMs: 10_000 });
        return { id: data.id, created: true, matchedBy: null };
      } catch (e) {
        // 409 = the contact appeared between our search and create (race or a retry). Resolve by re-searching.
        if (e instanceof HttpError && e.status === 409 && input.email) {
          const again = await this.search("email", input.email);
          if (again) {
            await this.call({ url: `${BASE}/crm/v3/objects/contacts/${again.id}`, method: "PATCH", body: { properties: input.properties }, retries: 2 });
            return { id: again.id, created: false, matchedBy: "email" as const };
          }
        }
        throw e;
      }
    } catch (err) {
      throw mapError(err, "upsert contact");
    }
  }

  async upsertNote(input: { contactId: string; dealId?: string | null; existingNoteId?: string | null; body: string; timestamp: Date }) {
    try {
      const props = { hs_timestamp: input.timestamp.toISOString(), hs_note_body: input.body };
      if (input.existingNoteId) {
        await this.call({ url: `${BASE}/crm/v3/objects/notes/${input.existingNoteId}`, method: "PATCH", body: { properties: props }, retries: 2 });
        return { id: input.existingNoteId };
      }
      const { data } = await this.call<{ id: string }>({ url: `${BASE}/crm/v3/objects/notes`, method: "POST", body: { properties: props } });
      await this.call({ url: `${BASE}/crm/v4/objects/notes/${data.id}/associations/default/contacts/${input.contactId}`, method: "PUT", retries: 2 });
      if (input.dealId) {
        await this.call({ url: `${BASE}/crm/v4/objects/notes/${data.id}/associations/default/deals/${input.dealId}`, method: "PUT", retries: 2 });
      }
      return { id: data.id };
    } catch (err) {
      throw mapError(err, "upsert note");
    }
  }

  async upsertDeal(input: HubspotDealInput) {
    try {
      const properties = { dealname: input.name, pipeline: input.pipeline, dealstage: input.stage, ...(input.properties ?? {}) };
      if (input.existingDealId) {
        await this.call({ url: `${BASE}/crm/v3/objects/deals/${input.existingDealId}`, method: "PATCH", body: { properties }, retries: 2 });
        return { id: input.existingDealId };
      }
      const { data } = await this.call<{ id: string }>({ url: `${BASE}/crm/v3/objects/deals`, method: "POST", body: { properties } });
      await this.call({ url: `${BASE}/crm/v4/objects/deals/${data.id}/associations/default/contacts/${input.contactId}`, method: "PUT", retries: 2 });
      return { id: data.id };
    } catch (err) {
      throw mapError(err, "upsert deal");
    }
  }

  async health() {
    try {
      await this.call({ url: `${BASE}/crm/v3/objects/contacts`, query: { limit: 1 }, timeoutMs: 6_000 });
      return { ok: true, detail: "authenticated; contacts readable" };
    } catch (err) {
      return { ok: false, detail: mapError(err, "health check").message };
    }
  }
}
