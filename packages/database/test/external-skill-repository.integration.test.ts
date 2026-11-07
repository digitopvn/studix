import type { ExternalSkillManifest, RecordExternalSkillImport, TenantContext } from "@studix/core";
import { newId } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const actor = { type: "user" as const, id: "usr_1", role: "owner" as const };
const createdBy = { type: "user" as const, id: "usr_1" };

async function tenant(slug: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
  });
  return { organizationId: organization.id, workspaceId: workspace.id, actor };
}

const manifest: ExternalSkillManifest = {
  schemaVersion: 1,
  files: [{ path: "SKILL.md", kind: "skill", bytes: 10, sha256: "a".repeat(64), stored: true }],
  frontmatter: { name: "demo" },
  license: { files: [], status: "unknown", notice: "No license found." },
  securityNotes: [],
  notices: [],
};

function importOf(contentHash: string, overrides: Partial<RecordExternalSkillImport> = {}) {
  const versionId = newId("eskv");
  return {
    sourceKey: "github.com/acme/skills/demo",
    source: { owner: "acme", repo: "skills", path: "demo", ref: "main" },
    skillId: newId("esk"),
    versionId,
    name: "demo",
    description: "Demo skill",
    commitSha: "c".repeat(40),
    contentHash,
    manifest,
    storagePrefix: `external-skills/${versionId}`,
    scope: "workspace" as const,
    risk: { level: "low" as const, findings: [], scannerVersion: 1, scannedAt: new Date() },
    actor: createdBy,
    ...overrides,
  } satisfies RecordExternalSkillImport;
}

describe("Postgres external skill repository", () => {
  it("creates a skill with an active first version and audits it", async () => {
    const { externalSkills, audit } = db.current.repos;
    const ctx = await tenant("esk-create");
    const res = await externalSkills.recordImport(ctx, importOf("h1"));
    expect(res.outcome).toBe("created");
    expect(res.skill.activeVersionId).toBe(res.version.id);
    expect((await externalSkills.get(ctx, res.skill.id))?.name).toBe("demo");
    const events = await audit.list(ctx, { subjectType: "external_skill", subjectId: res.skill.id });
    expect(events.items.map((e) => e.action)).toContain("external_skill.imported");
  });

  it("is idempotent for identical content and adds immutable versions for changed content", async () => {
    const { externalSkills } = db.current.repos;
    const ctx = await tenant("esk-versions");
    const first = await externalSkills.recordImport(ctx, importOf("h1"));
    const same = await externalSkills.recordImport(ctx, importOf("h1"));
    expect(same.outcome).toBe("unchanged");
    expect(same.version.id).toBe(first.version.id);
    expect(same.skill.id).toBe(first.skill.id);

    const next = await externalSkills.recordImport(ctx, importOf("h2"));
    expect(next.outcome).toBe("new_version");
    expect(next.skill.activeVersionId).toBe(first.version.id);
    const versions = await externalSkills.listVersions(ctx, first.skill.id);
    expect(versions.items).toHaveLength(2);
    expect((await externalSkills.getVersion(ctx, first.skill.id, first.version.id))?.contentHash).toBe("h1");

    const activated = await externalSkills.activateVersion(ctx, first.skill.id, next.version.id, createdBy);
    expect(activated.activeVersionId).toBe(next.version.id);
    await expect(
      externalSkills.activateVersion(ctx, first.skill.id, "eskv_missing", createdBy),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("serializes concurrent imports of one source into a single skill and version", async () => {
    const { externalSkills } = db.current.repos;
    const ctx = await tenant("esk-concurrent");
    const results = await Promise.all(
      Array.from({ length: 8 }, () => externalSkills.recordImport(ctx, importOf("same"))),
    );
    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(new Set(results.map((r) => r.skill.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.version.id)).size).toBe(1);
    expect((await externalSkills.list(ctx, {})).items).toHaveLength(1);
  });

  it("replays an idempotency key to the version it created", async () => {
    const { externalSkills } = db.current.repos;
    const ctx = await tenant("esk-key");
    const first = await externalSkills.recordImport(ctx, importOf("h1", { importKey: "k#demo" }));
    expect((await externalSkills.findVersionByImportKey(ctx, "k#demo"))?.id).toBe(first.version.id);
    const replay = await externalSkills.recordImport(ctx, importOf("h1", { importKey: "k#demo" }));
    expect(replay.outcome).toBe("unchanged");
    expect(replay.version.id).toBe(first.version.id);
  });

  it("isolates workspaces, including the same source key", async () => {
    const { externalSkills } = db.current.repos;
    const a = await tenant("esk-iso-a");
    const b = await tenant("esk-iso-b");
    const inA = await externalSkills.recordImport(a, importOf("h1"));
    expect(await externalSkills.get(b, inA.skill.id)).toBeUndefined();
    expect(await externalSkills.getVersion(b, inA.skill.id, inA.version.id)).toBeUndefined();
    expect(await externalSkills.findBySourceKey(b, inA.skill.sourceKey)).toBeUndefined();
    expect((await externalSkills.list(b, {})).items).toHaveLength(0);
    await expect(externalSkills.setStatus(b, inA.skill.id, "disabled", createdBy)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const inB = await externalSkills.recordImport(b, importOf("h1"));
    expect(inB.outcome).toBe("created");
    expect(inB.skill.id).not.toBe(inA.skill.id);
  });

  it("disables and re-enables, filtering the default list and auditing both", async () => {
    const { externalSkills, audit } = db.current.repos;
    const ctx = await tenant("esk-status");
    const { skill } = await externalSkills.recordImport(ctx, importOf("h1"));
    const off = await externalSkills.setStatus(ctx, skill.id, "disabled", createdBy);
    expect(off.status).toBe("disabled");
    expect((await externalSkills.list(ctx, {})).items).toHaveLength(0);
    expect((await externalSkills.list(ctx, { status: "all" })).items).toHaveLength(1);
    await externalSkills.setStatus(ctx, skill.id, "enabled", createdBy);
    const actions = (await audit.list(ctx, { subjectType: "external_skill", subjectId: skill.id })).items.map(
      (e) => e.action,
    );
    expect(actions).toEqual(expect.arrayContaining(["external_skill.disabled", "external_skill.enabled"]));
  });

  it("shows platform skills to every workspace and stores risk and initial status", async () => {
    const { externalSkills } = db.current.repos;
    const platform = await tenant("esk-platform");
    const other = await tenant("esk-platform-other");
    const risk = {
      level: "high" as const,
      findings: [
        { rule: "remote-exec" as const, severity: "high" as const, path: "SKILL.md", excerpt: "curl | sh" },
      ],
      scannerVersion: 1,
      scannedAt: new Date(),
    };
    const res = await externalSkills.recordImport(
      platform,
      importOf("h1", { scope: "platform", sourceKey: "upload/demo", risk, initialStatus: "disabled" }),
    );
    expect(res.skill).toMatchObject({ scope: "platform", status: "disabled" });
    expect((await externalSkills.getVersion(platform, res.skill.id, res.version.id))?.risk).toMatchObject({
      level: "high",
      findings: [expect.objectContaining({ rule: "remote-exec" })],
    });
    expect(await externalSkills.get(other, res.skill.id)).toBeUndefined();
    expect((await externalSkills.getPlatform(res.skill.id))?.id).toBe(res.skill.id);
    expect(
      (await externalSkills.list(other, { scope: "visible", status: "all" })).items.map((s) => s.id),
    ).toEqual([res.skill.id]);
    expect((await externalSkills.list(other, { status: "all" })).items).toHaveLength(0);
    // A workspace skill is never returned by getPlatform.
    const own = await externalSkills.recordImport(other, importOf("h2"));
    expect(await externalSkills.getPlatform(own.skill.id)).toBeUndefined();
  });

  it("deletes a skill with its versions and audits it", async () => {
    const { externalSkills, audit } = db.current.repos;
    const ctx = await tenant("esk-delete");
    const first = await externalSkills.recordImport(ctx, importOf("h1"));
    await externalSkills.recordImport(ctx, importOf("h2"));
    const { storagePrefixes } = await externalSkills.delete(ctx, first.skill.id, createdBy);
    expect(storagePrefixes).toHaveLength(2);
    expect(await externalSkills.get(ctx, first.skill.id)).toBeUndefined();
    const rows = await db.current
      .client`select id from external_skill_versions where skill_id = ${first.skill.id}`;
    expect(rows).toHaveLength(0);
    const events = await audit.list(ctx, { subjectType: "external_skill", subjectId: first.skill.id });
    expect(events.items.map((e) => e.action)).toContain("external_skill.deleted");
    await expect(externalSkills.delete(ctx, first.skill.id, createdBy)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("keeps data across a fresh connection (durable, not process-local)", async () => {
    const ctx = await tenant("esk-durable");
    const { skill, version } = await db.current.repos.externalSkills.recordImport(ctx, importOf("h1"));
    const rows = await db.current.client`select id from external_skill_versions where id = ${version.id}`;
    expect(rows).toHaveLength(1);
    const again = await db.current.repos.externalSkills.get(ctx, skill.id);
    expect(again?.activeVersionId).toBe(version.id);
  });
});
