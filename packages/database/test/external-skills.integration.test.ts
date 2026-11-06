import { randomBytes } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExternalSkillManifest, TenantContext } from "@studix/core";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate as drizzleMigrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_FOLDER, migrate } from "../src/index.ts";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const actor = { type: "user" as const, id: "usr_1" };

const manifest = (hash: string): ExternalSkillManifest =>
  ({
    name: "launch",
    description: "Plans launches",
    licenseStatus: "unknown",
    frontmatter: {},
    skillMd: { path: "SKILL.md", bytes: 10, sha256: hash, storageKey: `external-skills/blobs/${hash}` },
    files: [],
    skipped: [],
    riskFlags: [],
    warnings: [],
  }) as unknown as ExternalSkillManifest;

const record = (contentHash: string, extra: { activate?: boolean; sourceKey?: string } = {}) => ({
  source: { host: "github.com" as const, owner: "acme", repo: "skills", path: "launch" },
  sourceKey: extra.sourceKey ?? "github.com/acme/skills:launch",
  commitSha: "a".repeat(40),
  contentHash,
  name: "launch",
  description: "Plans launches",
  manifest: manifest(contentHash),
  importedBy: actor,
  activate: extra.activate ?? false,
});

async function tenant(slug: string): Promise<TenantContext> {
  const { workspace, organization } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_1", role: "owner" },
  };
}

describe("Postgres external skill repository", () => {
  it("records a skill once, versions changed content and ignores identical content", async () => {
    const ctx = await tenant("xs-versions");
    const repo = db.current.repos.externalSkills;
    const first = await repo.recordVersion(ctx, record("1".repeat(64)));
    expect(first.outcome).toBe("created");
    expect(first.skill.activeVersionId).toBe(first.version.id);

    const same = await repo.recordVersion(ctx, record("1".repeat(64)));
    expect(same.outcome).toBe("unchanged");
    expect(same.version.id).toBe(first.version.id);

    const next = await repo.recordVersion(ctx, record("2".repeat(64)));
    expect(next.outcome).toBe("new_version");
    expect(next.version.version).toBe(2);
    // A new version of an active skill is stored but not served until it is activated.
    expect(next.skill.activeVersionId).toBe(first.version.id);
    expect(next.skill.latestVersionId).toBe(next.version.id);

    const activated = await repo.activateVersion(ctx, first.skill.id, next.version.id);
    expect(activated?.activeVersionId).toBe(next.version.id);
    expect((await repo.listVersions(ctx, first.skill.id)).items).toHaveLength(2);
  });

  it("serializes concurrent imports of the same source into one skill and unique versions", async () => {
    const ctx = await tenant("xs-concurrent");
    const repo = db.current.repos.externalSkills;
    const results = await Promise.all(
      ["3", "4", "5", "6", "3", "4"].map((c) => repo.recordVersion(ctx, record(c.repeat(64)))),
    );
    expect(new Set(results.map((r) => r.skill.id)).size).toBe(1);
    const versions = (await repo.listVersions(ctx, results[0]?.skill.id as string, { limit: 50 })).items;
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2, 3, 4]);
    expect((await repo.list(ctx)).items).toHaveLength(1);
  });

  it("isolates tenants and escapes search wildcards", async () => {
    const a = await tenant("xs-iso-a");
    const b = await tenant("xs-iso-b");
    const repo = db.current.repos.externalSkills;
    const created = await repo.recordVersion(a, record("7".repeat(64)));
    expect((await repo.list(b)).items).toHaveLength(0);
    expect(await repo.get(b, created.skill.id)).toBeUndefined();
    expect(await repo.getVersion(b, created.skill.id, created.version.id)).toBeUndefined();
    expect(await repo.setEnabled(b, created.skill.id, false, actor)).toBeUndefined();
    expect((await repo.list(a, { query: "%" })).items).toHaveLength(0);
    expect((await repo.list(a, { query: "launch" })).items).toHaveLength(1);
    expect((await repo.list(a, { repository: "ACME/skills" })).items).toHaveLength(1);
  });

  it("persists the enabled flag and who disabled the skill", async () => {
    const ctx = await tenant("xs-disable");
    const repo = db.current.repos.externalSkills;
    const { skill } = await repo.recordVersion(ctx, record("8".repeat(64)));
    const off = await repo.setEnabled(ctx, skill.id, false, actor);
    expect(off).toMatchObject({ enabled: false, disabledBy: actor });
    expect((await repo.list(ctx, { enabled: true })).items).toHaveLength(0);
    expect((await repo.setEnabled(ctx, skill.id, true, actor))?.enabled).toBe(true);
  });
});

describe("api key skill scope migration", () => {
  it("upgrades keys that exactly match a role's earlier scopes and leaves custom keys alone", async () => {
    const journal = JSON.parse(readFileSync(join(MIGRATIONS_FOLDER, "meta/_journal.json"), "utf8")) as {
      entries: { tag: string }[];
    };
    const at = journal.entries.findIndex((e) => e.tag.endsWith("api_key_skill_scopes"));
    expect(at).toBeGreaterThan(0);
    const folder = mkdtempSync(join(tmpdir(), "studix-migrations-"));
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    writeFileSync(
      join(folder, "meta/_journal.json"),
      JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }),
    );
    const name = `studix_test_${randomBytes(6).toString("hex")}`;
    await db.current.client.unsafe(`create database "${name}"`);
    const url = new URL(db.current.url);
    url.pathname = `/${name}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    try {
      await drizzleMigrate(drizzle(sql), { migrationsFolder: folder });
      await sql`insert into organizations (id, name, slug) values ('org_m', 'm', 'm')`;
      await sql`insert into workspaces (id, organization_id, name, slug) values ('ws_m', 'org_m', 'm', 'm')`;
      const insert = (id: string, scopes: string[]) =>
        sql`insert into api_keys (id, organization_id, workspace_id, name, hash, prefix, scopes, created_by_type, created_by_id)
            values (${id}, 'org_m', 'ws_m', ${id}, ${id}, ${id}, ${JSON.stringify(scopes)}::jsonb, 'user', 'usr_1')`;
      await insert("k_viewer", ["asset:read", "workspace:read", "project:read"]);
      await insert("k_custom", ["workspace:read"]);
      await insert("k_done", ["workspace:read", "project:read", "asset:read", "skill:read"]);
      await migrate(url.toString());
      const rows = await sql`select id, scopes from api_keys order by id`;
      const byId = Object.fromEntries(rows.map((r) => [r.id as string, r.scopes as string[]]));
      expect(byId.k_viewer).toContain("skill:read");
      expect(byId.k_viewer).not.toContain("skill:write");
      expect(byId.k_custom).toEqual(["workspace:read"]);
      expect(byId.k_done?.filter((s) => s === "skill:read")).toHaveLength(1);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(folder, { recursive: true, force: true });
      await db.current.client.unsafe(`drop database if exists "${name}" with (force)`);
    }
  });
});
