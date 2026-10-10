// Global test setup: force every integration into mock mode and silence logs.
process.env.FORCE_MOCK_INTEGRATIONS = "1";
process.env.LOG_LEVEL = "silent";
delete process.env.DATABASE_URL;

import { afterAll } from "vitest";
afterAll(async () => {
  if (typeof window !== "undefined") return; // jsdom UI tests never open the database
  const { closeSharedDb } = await import("./harness");
  await closeSharedDb();
});
