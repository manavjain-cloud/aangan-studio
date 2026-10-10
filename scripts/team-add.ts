import { closeDb, getDb, migrateDb } from "@/lib/db/client";
import { teamMembers } from "@/lib/db/schema";

/**
 * Adds or updates a team member (the same table the Settings -> Team page edits).
 *   npm run team:add -- --name "Design consultations" --email a@b.com --role designer --event calcom:7425136
 * Roles: designer | front_desk | senior. A designer needs --event (calcom:<id> or a Calendly event type URI).
 */
const arg = (k: string) => {
  const i = process.argv.indexOf(`--${k}`);
  return i > -1 ? process.argv[i + 1] : undefined;
};
const name = arg("name"), email = arg("email")?.toLowerCase(), role = arg("role"), event = arg("event");
if (!name || !email || !["designer", "front_desk", "senior"].includes(role ?? "")) {
  console.error('Usage: npm run team:add -- --name "..." --email a@b.com --role designer|front_desk|senior [--event calcom:123]');
  process.exit(1);
}
if (role === "designer" && !event) {
  console.error("A designer needs --event (calcom:<id> or a Calendly event type URI).");
  process.exit(1);
}
await migrateDb();
const db = await getDb();
await db
  .insert(teamMembers)
  .values({ name, email, role: role as "designer", calendlyEventTypeUri: event ?? null })
  .onConflictDoUpdate({ target: teamMembers.email, set: { name, role: role as "designer", calendlyEventTypeUri: event ?? null, active: true, updatedAt: new Date() } });
console.log(`Saved ${role}: ${name} <${email}>${event ? ` -> ${event}` : ""}`);
await closeDb();
