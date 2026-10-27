import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

export const MIGRATIONS_FOLDER = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

/** Arbitrary constant key so concurrently starting app and worker pods migrate one at a time. */
const MIGRATION_LOCK_KEY = 7_160_525_001;

/**
 * Apply pending SQL migrations from packages/database/migrations. Safe to call on every boot: it uses
 * a dedicated single-connection pool so the session advisory lock and the migration share one session,
 * and it is a no-op when the schema is up to date.
 */
export async function migrate(databaseUrl: string): Promise<void> {
  const client = postgres(databaseUrl, {
    max: 1,
    onnotice: () => {},
    connection: { application_name: "studix-migrate" },
  });
  try {
    await client`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    try {
      await drizzleMigrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
    } finally {
      await client`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`;
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
