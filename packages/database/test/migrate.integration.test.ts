import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrate } from "../src/index.ts";
import { insertTestUser, withTestDatabase } from "../src/testing/index.ts";

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

  it("grants job:retry only to keys holding exactly the old editor or old admin scope set", async () => {
    const { client, repos } = db.current;
    await insertTestUser(db.current, { id: "usr_scope", email: "scope@example.test" });
    const { organization, workspace } = await repos.directory.provisionWorkspace({
      organization: { name: "Scopes", slug: "scopes-org" },
      workspace: { name: "Main", slug: "main" },
      ownerUserId: "usr_scope",
    });
    const editor = [
      "workspace:read",
      "project:read",
      "asset:read",
      "project:write",
      "job:cancel",
      "asset:write",
      "approval:request",
    ];
    const admin = [...editor, "approval:decide", "publish", "audit:read", "apikey:manage", "member:manage"];
    const custom = ["workspace:read", "job:cancel"];
    const keys = { editor, admin, custom, current: [...editor, "job:retry"] };
    for (const [name, scopes] of Object.entries(keys)) {
      await client`insert into api_keys (id, organization_id, workspace_id, name, hash, prefix, scopes, created_by_type, created_by_id)
        values (${`key_${name}`}, ${organization.id}, ${workspace.id}, ${name}, ${`hash_${name}`}, 'stx_test_', ${JSON.stringify(scopes)}::jsonb, 'user', 'usr_scope')`;
    }
    const file = readFileSync(join(MIGRATIONS_FOLDER, "0011_api_key_job_retry_scope.sql"), "utf8");
    for (const statement of file.split("--> statement-breakpoint")) await client.unsafe(statement);
    const rows = await client`select name, scopes from api_keys where organization_id = ${organization.id}`;
    const scopesOf = (name: string) =>
      [...((rows.find((r) => r.name === name)?.scopes ?? []) as string[])].sort();
    expect(scopesOf("editor")).toEqual([...editor, "job:retry"].sort());
    expect(scopesOf("admin")).toEqual([...admin, "job:retry"].sort());
    expect(scopesOf("custom")).toEqual([...custom].sort());
    expect(scopesOf("current")).toEqual([...editor, "job:retry"].sort());
  });
});
