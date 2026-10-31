import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrate } from "../src/index.ts";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
// One applied row per journal entry, however many migrations exist.
const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
  entries: unknown[];
};

describe("migrate", () => {
  it("is idempotent and safe to run concurrently", async () => {
    await Promise.all([migrate(db.current.url), migrate(db.current.url)]);
    const rows = await db.current.client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(rows[0]?.n).toBe(journal.entries.length);
  });

  it("restores the deadline window column on a database that skipped its out-of-order migration", async () => {
    await migrate(db.current.url);
    const sql = db.current.client;
    // The state of a database that applied 0012 before 0013 was journaled: it has 0014 but not 0013's column.
    await sql`alter table jobs drop column deadline_window_ms`;
    await sql`delete from drizzle.__drizzle_migrations where id = (select max(id) from drizzle.__drizzle_migrations)`;
    await migrate(db.current.url);
    const cols = await sql`
      select 1 from information_schema.columns where table_name = 'jobs' and column_name = 'deadline_window_ms'`;
    expect(cols).toHaveLength(1);
  });
});
