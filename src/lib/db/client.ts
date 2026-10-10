import path from "node:path";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

export type DbDriver = "neon-postgres" | "pglite-file" | "pglite-memory";

interface DbHandle {
  db: Db;
  driver: DbDriver;
  close: () => Promise<void>;
}

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

const globalForDb = globalThis as unknown as { __aanganDb?: Promise<DbHandle> };

async function openPg(url: string): Promise<DbHandle> {
  const { Pool } = await import("pg");
  const { drizzle } = await import("drizzle-orm/node-postgres");
  const pool = new Pool({
    connectionString: url,
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    connectionTimeoutMillis: 8_000,
    idleTimeoutMillis: 20_000,
    ssl: /localhost|127\.0\.0\.1/.test(url) ? undefined : { rejectUnauthorized: true },
  });
  const db = drizzle(pool, { schema }) as unknown as Db;
  return { db, driver: "neon-postgres", close: () => pool.end() };
}

async function openPglite(dataDir: string | undefined): Promise<DbHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const client = dataDir ? new PGlite(dataDir) : new PGlite();
  await client.waitReady;
  const db = drizzle(client, { schema }) as unknown as Db;
  return { db, driver: dataDir ? "pglite-file" : "pglite-memory", close: () => client.close() };
}

async function runMigrations(handle: DbHandle): Promise<void> {
  if (handle.driver === "neon-postgres") {
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  } else {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder: MIGRATIONS_FOLDER });
  }
}

/**
 * Which database is in use:
 *  - DATABASE_URL set            -> Neon / any PostgreSQL (production and staging).
 *  - unset + NODE_ENV=production -> hard error. A production deployment must never fall back to a local file.
 *  - unset + test                -> private in-memory PGlite.
 *  - unset + development         -> PGlite persisted in .data/pglite so mock-mode data survives restarts.
 */
async function openDb(): Promise<DbHandle> {
  const url = process.env.DATABASE_URL?.trim();
  if (url) return openPg(url);
  if (process.env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is not set. Production requires a Neon PostgreSQL connection string.");
  }
  if (process.env.NODE_ENV === "test" || process.env.PGLITE_MEMORY === "1") return openPglite(undefined);
  return openPglite(path.join(process.cwd(), ".data", "pglite"));
}

export function getDbHandle(): Promise<DbHandle> {
  if (!globalForDb.__aanganDb) {
    globalForDb.__aanganDb = openDb()
      .then(async (h) => {
        if (process.env.AUTO_MIGRATE !== "0" && h.driver !== "neon-postgres") await runMigrations(h);
        return h;
      })
      .catch((err) => {
        globalForDb.__aanganDb = undefined;
        throw err;
      });
  }
  return globalForDb.__aanganDb;
}

export async function getDb(): Promise<Db> {
  return (await getDbHandle()).db;
}

export async function getDbDriver(): Promise<DbDriver> {
  return (await getDbHandle()).driver;
}

export async function migrateDb(): Promise<DbDriver> {
  const h = await getDbHandle();
  await runMigrations(h);
  return h.driver;
}

/** A fresh, isolated, migrated in-memory database. Used by tests and the seed script. */
export async function createMemoryDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const h = await openPglite(undefined);
  await runMigrations(h);
  return { db: h.db, close: h.close };
}

export async function closeDb(): Promise<void> {
  const p = globalForDb.__aanganDb;
  globalForDb.__aanganDb = undefined;
  if (p) await (await p).close();
}

export { schema };
