import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrate } from "../src/index.ts";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
// One applied row per journal entry, however many migrations exist.
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};

/** A copy of the migrations folder whose journal stops just before the migration tagged `tag`. */
function migrationsBefore(tag: string): string {
  const at = journal.entries.findIndex((e) => e.tag === tag);
  if (at < 0) throw new Error(`migration ${tag} is not in the journal`);
  const folder = mkdtempSync(join(tmpdir(), "studix-migrations-"));
  cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
  writeFileSync(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }),
  );
  return folder;
}

describe("migrate", () => {
  it("is idempotent and safe to run concurrently", async () => {
    await Promise.all([migrate(db.current.url), migrate(db.current.url)]);
    const rows = await db.current.client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(rows[0]?.n).toBe(journal.entries.length);
  });

  it("restores the deadline window column on a database that skipped its out-of-order migration", async () => {
    // Built in its own database: later migrations cannot be undone on the shared, fully migrated one.
    const name = `studix_test_${randomBytes(6).toString("hex")}`;
    await db.current.client.unsafe(`create database "${name}"`);
    const url = new URL(db.current.url);
    url.pathname = `/${name}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const folder = migrationsBefore("0015_repair_job_deadline_window");
    try {
      // The state of a database that applied 0012 before 0013 was journaled: it has 0014 but not 0013's column.
      await drizzleMigrate(drizzle(sql), { migrationsFolder: folder });
      await sql`alter table jobs drop column deadline_window_ms`;
      await migrate(url.toString());
      const cols = await sql`
        select 1 from information_schema.columns where table_name = 'jobs' and column_name = 'deadline_window_ms'`;
      expect(cols).toHaveLength(1);
      const applied = await sql`select count(*)::int as n from drizzle.__drizzle_migrations`;
      expect(applied[0]?.n).toBe(journal.entries.length);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(folder, { recursive: true, force: true });
      await db.current.client.unsafe(`drop database if exists "${name}" with (force)`);
    }
  });
});
