import { describe, expect, it } from "vitest";
import { migrate } from "../src/index.ts";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();

describe("migrate", () => {
  it("is idempotent and safe to run concurrently", async () => {
    await Promise.all([migrate(db.current.url), migrate(db.current.url)]);
    const rows = await db.current.client`select count(*)::int as n from drizzle.__drizzle_migrations`;
    expect(rows[0]?.n).toBe(1);
  });
});
