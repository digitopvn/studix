import { StudixError } from "@studix/shared";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

export type StudixSchema = typeof schema;
export type StudixDb = PostgresJsDatabase<StudixSchema>;
/** A database handle or an open transaction on it. */
export type DbExecutor = StudixDb | Parameters<Parameters<StudixDb["transaction"]>[0]>[0];

export interface DatabaseHandle {
  db: StudixDb;
  /** Underlying postgres.js client (for advisory locks or raw SQL). */
  client: postgres.Sql;
  close(): Promise<void>;
}

export interface CreateDbOptions {
  /** Pool size (default 10). */
  max?: number;
  /** Application name reported to Postgres. */
  applicationName?: string;
}

/** Open a pooled connection. The URL comes from configuration (DATABASE_URL), never code. */
export function createDb(url: string, options: CreateDbOptions = {}): DatabaseHandle {
  if (!/^postgres(ql)?:\/\//.test(url)) {
    throw new StudixError("VALIDATION", "DATABASE_URL must be a postgres:// connection string");
  }
  const client = postgres(url, {
    max: options.max ?? 10,
    onnotice: () => {},
    connection: { application_name: options.applicationName ?? "studix" },
  });
  const db = drizzle(client, { schema });
  return { db, client, close: () => client.end({ timeout: 5 }) };
}
