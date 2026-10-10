import { getHubspot } from "@/lib/integrations";
import { CUSTOM_PROPERTY_DEFS } from "@/lib/integrations/hubspot/types";

/** One-off: creates the aangan_* custom contact properties in HubSpot (only those that do not already exist). */
const client = getHubspot();
console.log(`HubSpot client mode: ${client.mode}`);
const r = await client.ensureProperties(CUSTOM_PROPERTY_DEFS);
console.log(`Created ${r.created.length}: ${r.created.join(", ") || "-"}\nAlready present ${r.existing.length}.`);
