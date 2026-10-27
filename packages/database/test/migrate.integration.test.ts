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
});
