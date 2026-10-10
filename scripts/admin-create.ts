import readline from "node:readline";
import { eq } from "drizzle-orm";
import { closeDb, getDb, migrateDb } from "@/lib/db/client";
import { adminUsers } from "@/lib/db/schema";
import { hashPassword, validatePasswordStrength } from "@/lib/security/password";

/**
 * Creates (or resets the password of) a management admin.
 *   npm run admin:create -- nikhil@example.com
 * The password is read from ADMIN_PASSWORD (non-interactive) or typed at a hidden prompt. It is never printed or stored in plain text.
 */
const email = process.argv[2]?.trim().toLowerCase();
if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
  console.error("Usage: npm run admin:create -- <email>");
  process.exit(1);
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    (rl as any)._writeToOutput = (s: string) => {
      if (s.includes(question)) process.stdout.write(s);
    };
    rl.question(question, (a) => {
      rl.close();
      process.stdout.write("\n");
      resolve(a);
    });
  });
}

const password = process.env.ADMIN_PASSWORD ?? (await promptHidden("New password (12+ chars, upper+lower+digit): "));
const problem = validatePasswordStrength(password);
if (problem) {
  console.error(problem);
  process.exit(1);
}

await migrateDb();
const db = await getDb();
const hash = hashPassword(password);
const [existing] = await db.select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, email)).limit(1);
if (existing) {
  await db.update(adminUsers).set({ passwordHash: hash, failedAttempts: 0, lockedUntil: null }).where(eq(adminUsers.id, existing.id));
  console.log(`Password reset for ${email}`);
} else {
  await db.insert(adminUsers).values({ email, passwordHash: hash });
  console.log(`Admin created: ${email}`);
}
if (process.env.ADMIN_EMAILS && !process.env.ADMIN_EMAILS.toLowerCase().split(",").map((s) => s.trim()).includes(email)) {
  console.warn(`Note: ADMIN_EMAILS is set and does not include ${email}; this admin cannot sign in until it is added.`);
}
await closeDb();
