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

  it("backfills asset roles from IR audio tracks, kinds and file names", async () => {
    const name = `studix_test_${randomBytes(6).toString("hex")}`;
    await db.current.client.unsafe(`create database "${name}"`);
    const url = new URL(db.current.url);
    url.pathname = `/${name}`;
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const folder = migrationsBefore("0034_asset_role_path");
    try {
      await drizzleMigrate(drizzle(sql), { migrationsFolder: folder });
      await sql`insert into organizations (id, name, slug) values ('org_1', 'o', 'o')`;
      await sql`insert into workspaces (id, organization_id, name, slug) values ('ws_1', 'org_1', 'w', 'w')`;
      const asset = (id: string, kind: string, assetName: string) =>
        sql`insert into assets (id, organization_id, workspace_id, kind, name, created_by_type, created_by_id)
            values (${id}, 'org_1', 'ws_1', ${kind}, ${assetName}, 'system', 't')`;
      await asset("ast_track", "audio", "take-01.mp3");
      await asset("ast_render", "render", "final.mp4");
      await asset("ast_named", "audio", "boom_sfx.wav");
      await asset("ast_plain", "image", "photo.png");
      await sql`insert into asset_versions (id, organization_id, workspace_id, asset_id, version, storage_key, sha256, mime, bytes, provenance, created_by_type, created_by_id)
        values ('astv_track', 'org_1', 'ws_1', 'ast_track', 1, 'k', 'x', 'audio/mpeg', 1, '{"source":"generated"}', 'system', 't')`;
      await sql`insert into video_projects (id, organization_id, workspace_id, title, status, brief, created_by_type, created_by_id)
        values ('prj_1', 'org_1', 'ws_1', 'p', 'draft', '{}', 'system', 't')`;
      const ir = {
        assets: [{ id: "music1", assetVersionId: "astv_track" }],
        audio: [{ id: "t1", kind: "music", assetId: "music1" }],
      };
      await sql`insert into project_versions (id, organization_id, workspace_id, project_id, version, schema_version, ir, source, created_by_type, created_by_id)
        values ('pver_1', 'org_1', 'ws_1', 'prj_1', 1, 1, ${JSON.stringify(ir)}::jsonb, 'client', 'system', 't')`;
      await migrate(url.toString());
      const rows = await sql`select id, role, path, tags from assets order by id`;
      expect(Object.fromEntries(rows.map((r) => [r.id, r.role]))).toEqual({
        ast_named: "sfx",
        ast_plain: "other",
        ast_render: "render",
        ast_track: "bgm",
      });
      expect(rows.every((r) => r.path === "" && Array.isArray(r.tags) && r.tags.length === 0)).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
      rmSync(folder, { recursive: true, force: true });
      await db.current.client.unsafe(`drop database if exists "${name}" with (force)`);
    }
  });
});
