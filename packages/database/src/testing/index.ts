import { randomBytes } from "node:crypto";
import { type Clock, StudixError, systemClock } from "@studix/shared";
import postgres from "postgres";
import { afterAll, beforeAll } from "vitest";
import { createDb, type DatabaseHandle } from "../client.ts";
import { migrate } from "../migrate.ts";
import { createRepositories, type StudixRepositories } from "../repositories/index.ts";
import { users } from "../schema/tenancy.ts";

export interface TestDatabase extends DatabaseHandle {
  /** Connection URL of the isolated database. */
  url: string;
  databaseName: string;
  repos: StudixRepositories;
  /** Close connections and drop the database. */
  destroy(): Promise<void>;
}

function adminUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) {
    throw new StudixError("UNAVAILABLE", "DATABASE_URL is not set for integration tests", {
      suggestedAction:
        "Run `docker compose up -d postgres` and export DATABASE_URL=postgres://studix:studix@127.0.0.1:55432/studix",
    });
  }
  return url;
}

/**
 * Create a fresh, fully migrated database (`studix_test_<random>`) on the server from
 * TEST_DATABASE_URL/DATABASE_URL. Each test file gets its own database, so files can run in parallel.
 */
export async function createTestDatabase(options: { clock?: Clock } = {}): Promise<TestDatabase> {
  const base = adminUrl();
  const databaseName = `studix_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(base, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`create database "${databaseName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  await migrate(url.toString());
  const handle = createDb(url.toString(), { max: 5, applicationName: "studix-test" });
  const repos = createRepositories(handle.db, { clock: options.clock ?? systemClock });
  return {
    ...handle,
    url: url.toString(),
    databaseName,
    repos,
    async destroy() {
      await handle.close();
      const dropper = postgres(base, { max: 1, onnotice: () => {} });
      try {
        await dropper.unsafe(`drop database if exists "${databaseName}" with (force)`);
      } finally {
        await dropper.end({ timeout: 5 });
      }
    },
  };
}

/**
 * Vitest helper: provisions an isolated database in beforeAll and drops it in afterAll.
 * Access `handle.current` inside tests.
 */
export function withTestDatabase(options: { clock?: Clock } = {}): { readonly current: TestDatabase } {
  let database: TestDatabase | undefined;
  beforeAll(async () => {
    database = await createTestDatabase(options);
  });
  afterAll(async () => {
    await database?.destroy();
  });
  return {
    get current(): TestDatabase {
      if (!database) throw new Error("test database is not ready (use inside tests, after beforeAll)");
      return database;
    },
  };
}

/** Insert a dashboard user row (members reference users). */
export async function insertTestUser(db: TestDatabase, input: { id: string; email: string; name?: string }) {
  const now = new Date();
  await db.db.insert(users).values({
    id: input.id,
    email: input.email,
    name: input.name ?? input.email,
    createdAt: now,
    updatedAt: now,
  });
}
