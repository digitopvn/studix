import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema/index.ts";

/** Tables that exist above or outside tenancy. Everything else must carry both tenant columns. */
const GLOBAL_TABLES = new Set([
  "organizations",
  "workspaces",
  "users",
  "auth_sessions",
  "auth_accounts",
  "auth_verifications",
  "rate_limit_buckets",
]);

const tables = Object.values(schema).filter((value) => isTable(value));

describe("database schema", () => {
  it("every tenant-owned table has organization_id and workspace_id", () => {
    const tenantTables = tables.filter((t) => !GLOBAL_TABLES.has(getTableName(t)));
    expect(tenantTables.length).toBeGreaterThan(10);
    for (const table of tenantTables) {
      const columns = Object.values(getTableColumns(table)).map((c) => c.name);
      expect(columns, getTableName(table)).toEqual(
        expect.arrayContaining(["organization_id", "workspace_id"]),
      );
    }
  });

  it("jobs carry every queue column", () => {
    const columns = Object.values(getTableColumns(schema.jobs)).map((c) => c.name);
    expect(columns).toEqual(
      expect.arrayContaining([
        "status",
        "run_after",
        "locked_by",
        "lease_expires_at",
        "attempts",
        "max_attempts",
        "idempotency_key",
        "cancel_requested",
        "deadline_at",
        "budget_cents",
        "spent_cents",
      ]),
    );
  });
});
