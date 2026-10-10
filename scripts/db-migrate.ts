import { closeDb, migrateDb } from "@/lib/db/client";

const driver = await migrateDb();
console.log(`Migrations applied using driver: ${driver}`);
await closeDb();
