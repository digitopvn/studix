import type { ExternalSkillManifest, RecordExternalSkillVersionInput, TenantContext } from "@studix/core";
import { systemClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createDb } from "../src/client.ts";
import { createExternalSkillRepository } from "../src/repositories/external-skill-repository.ts";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();
const importer = { type: "user" as const, id: "usr_owner" };

async function provision(slug: string, orgId?: string): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: orgId ? { id: orgId } : { name: slug, slug },
    workspace: { name: slug, slug },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: importer.id, role: "owner" },
  };
}

function capture(
  source: { repository: string; path: string },
  commitSha: string,
  overrides: Partial<
    Pick<RecordExternalSkillVersionInput, "name" | "description" | "contentHash" | "importKey">
  > = {},
): RecordExternalSkillVersionInput {
  const name = overrides.name ?? "brand-voice";
  const description = overrides.description ?? "Writes in the house style";
  const manifest: ExternalSkillManifest = {
    schema: 1,
    repository: source.repository,
    path: source.path,
    commitSha,
    name,
    description,
    metadata: { author: "acme" },
    license: { status: "declared", declared: "MIT", file: "LICENSE" },
    files: [
      {
        path: "SKILL.md",
        kind: "skill",
        bytes: 120,
        sha256: `sha-${commitSha}`,
        contentType: "text/markdown",
        storageKey: `skills/${commitSha}/SKILL.md`,
        text: true,
      },
    ],
    skipped: [],
    notices: ["Data only; scripts are never run."],
    importedAt: new Date().toISOString(),
  };
  return {
    repository: source.repository,
    path: source.path,
    commitSha,
    contentHash: overrides.contentHash ?? `hash-${commitSha}`,
    name,
    description,
    manifest,
    importKey: overrides.importKey,
    importedBy: importer,
  };
}

async function auditActions(ctx: TenantContext, skillId: string): Promise<string[]> {
  const page = await db.current.repos.audit.list(ctx, { subjectType: "external_skill", subjectId: skillId });
  return page.items.map((e) => e.action).reverse();
}

describe("external skill repository (Postgres)", () => {
  it("first import creates an enabled skill whose only version is active and audits it", async () => {
    const ctx = await provision("esk-first");
    const skills = db.current.repos.externalSkills;
    const source = { repository: "acme/skills", path: "skills/brand-voice" };

    const result = await skills.recordVersion(ctx, capture(source, "c1", { importKey: "imp-1" }));

    expect(result.outcome).toBe("created");
    expect(result.skill).toMatchObject({
      ...source,
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      name: "brand-voice",
      status: "enabled",
      upstream: "present",
      activeVersionId: result.version.id,
      latestVersionId: result.version.id,
      createdBy: importer,
    });
    expect(result.skill.id).toMatch(/^esk/);
    expect(result.version).toMatchObject({ skillId: result.skill.id, commitSha: "c1", importKey: "imp-1" });
    expect(result.version.id).toMatch(/^esv/);
    expect(await skills.get(ctx, result.skill.id)).toEqual(result.skill);
    expect(await skills.findBySource(ctx, source.repository, source.path)).toEqual(result.skill);
    expect(await skills.getVersion(ctx, result.skill.id, result.version.id)).toEqual(result.version);

    const events = await db.current.repos.audit.list(ctx, { subjectId: result.skill.id });
    expect(events.items).toHaveLength(1);
    expect(events.items[0]).toMatchObject({
      action: "external_skill.imported",
      subjectType: "external_skill",
      actor: importer,
      data: { ...source, commitSha: "c1", versionId: result.version.id, importKey: "imp-1" },
    });
  });

  it("re-importing the same commit and content writes nothing", async () => {
    const ctx = await provision("esk-same");
    const skills = db.current.repos.externalSkills;
    const source = { repository: "acme/skills", path: "same" };
    const first = await skills.recordVersion(ctx, capture(source, "c1"));

    const again = await skills.recordVersion(ctx, capture(source, "c1", { importKey: "imp-2" }));

    expect(again.outcome).toBe("unchanged");
    expect(again.version).toEqual(first.version);
    expect(again.skill).toEqual(first.skill);
    expect((await skills.listVersions(ctx, first.skill.id)).items).toHaveLength(1);
    expect(await auditActions(ctx, first.skill.id)).toEqual(["external_skill.imported"]);
  });

  it("a new commit adds a version, moves latest and keeps the active version and its metadata", async () => {
    const ctx = await provision("esk-new");
    const skills = db.current.repos.externalSkills;
    const source = { repository: "acme/skills", path: "evolving" };
    const first = await skills.recordVersion(ctx, capture(source, "c1"));

    const second = await skills.recordVersion(
      ctx,
      capture(source, "c2", { name: "brand-voice-v2", description: "Rewritten" }),
    );

    expect(second.outcome).toBe("new_version");
    expect(second.skill).toMatchObject({
      activeVersionId: first.version.id,
      latestVersionId: second.version.id,
      name: "brand-voice",
      description: "Writes in the house style",
    });
    expect(second.version).toMatchObject({ commitSha: "c2", name: "brand-voice-v2" });
    const versions = await skills.listVersions(ctx, first.skill.id);
    expect(versions.items.map((v) => v.id)).toEqual([second.version.id, first.version.id]);
    expect(await auditActions(ctx, first.skill.id)).toEqual([
      "external_skill.imported",
      "external_skill.version_added",
    ]);

    // Same commit with different content is a distinct capture too.
    const third = await skills.recordVersion(ctx, capture(source, "c2", { contentHash: "other" }));
    expect(third.outcome).toBe("new_version");
  });

  it("activating a version switches the active id and the skill name and description", async () => {
    const ctx = await provision("esk-activate");
    const skills = db.current.repos.externalSkills;
    const source = { repository: "acme/skills", path: "activate" };
    const first = await skills.recordVersion(ctx, capture(source, "c1"));
    const second = await skills.recordVersion(
      ctx,
      capture(source, "c2", { name: "Brand Voice 2", description: "Second" }),
    );

    const activated = await skills.activateVersion(ctx, first.skill.id, second.version.id, importer);

    expect(activated).toMatchObject({
      activeVersionId: second.version.id,
      latestVersionId: second.version.id,
      name: "Brand Voice 2",
      description: "Second",
    });
    expect(await skills.get(ctx, first.skill.id)).toEqual(activated);
    expect(await skills.activateVersion(ctx, first.skill.id, "esv_unknown", importer)).toBeUndefined();
    expect(await skills.activateVersion(ctx, "esk_unknown", second.version.id, importer)).toBeUndefined();

    // A version of another skill in the same workspace cannot be activated on this one.
    const other = await skills.recordVersion(ctx, capture({ ...source, path: "activate-other" }, "c1"));
    expect(await skills.activateVersion(ctx, first.skill.id, other.version.id, importer)).toBeUndefined();

    const events = await db.current.repos.audit.list(ctx, { subjectId: first.skill.id });
    expect(events.items[0]).toMatchObject({
      action: "external_skill.version_activated",
      data: { versionId: second.version.id, previousVersionId: first.version.id },
    });
  });

  it("disables and re-enables a skill without deleting anything", async () => {
    const ctx = await provision("esk-status");
    const skills = db.current.repos.externalSkills;
    const { skill, version } = await skills.recordVersion(
      ctx,
      capture({ repository: "acme/x", path: "" }, "c1"),
    );

    const disabled = await skills.setStatus(ctx, skill.id, "disabled", importer);
    expect(disabled).toMatchObject({ status: "disabled", activeVersionId: version.id });
    expect(disabled?.disabledAt).toBeInstanceOf(Date);

    const enabled = await skills.setStatus(ctx, skill.id, "enabled", importer);
    expect(enabled?.status).toBe("enabled");
    expect(enabled?.disabledAt).toBeUndefined();
    expect(await skills.getVersion(ctx, skill.id, version.id)).toEqual(version);
    expect(await skills.setStatus(ctx, "esk_unknown", "disabled", importer)).toBeUndefined();
    expect(await auditActions(ctx, skill.id)).toEqual([
      "external_skill.imported",
      "external_skill.disabled",
      "external_skill.enabled",
    ]);
  });

  it("records upstream checks, audits only changes and a re-import marks the source present", async () => {
    const ctx = await provision("esk-upstream");
    const skills = db.current.repos.externalSkills;
    const source = { repository: "acme/skills", path: "upstream" };
    const { skill } = await skills.recordVersion(ctx, capture(source, "c1"));

    const missing = await skills.markUpstream(ctx, skill.id, "missing", importer);
    expect(missing?.upstream).toBe("missing");
    const checkedAt = missing?.upstreamCheckedAt;
    expect(checkedAt).toBeInstanceOf(Date);
    const stillMissing = await skills.markUpstream(ctx, skill.id, "missing", importer);
    expect(stillMissing?.upstreamCheckedAt?.getTime()).toBeGreaterThanOrEqual(checkedAt!.getTime());

    const reimported = await skills.recordVersion(ctx, capture(source, "c2"));
    expect(reimported.skill.upstream).toBe("present");

    await skills.markUpstream(ctx, skill.id, "missing", importer);
    const present = await skills.markUpstream(ctx, skill.id, "present", importer);
    expect(present?.upstream).toBe("present");
    expect(await skills.markUpstream(ctx, "esk_unknown", "missing", importer)).toBeUndefined();
    expect(await auditActions(ctx, skill.id)).toEqual([
      "external_skill.imported",
      "external_skill.upstream_missing",
      "external_skill.version_added",
      "external_skill.upstream_missing",
      "external_skill.upstream_present",
    ]);
  });

  it("concurrent first imports of one source create exactly one skill and one version", async () => {
    const ctx = await provision("esk-race");
    const skills = db.current.repos.externalSkills;
    const source = { repository: "acme/skills", path: "race" };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => skills.recordVersion(ctx, capture(source, "c1"))),
    );

    expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "unchanged")).toHaveLength(7);
    expect(new Set(results.map((r) => r.skill.id)).size).toBe(1);
    expect(new Set(results.map((r) => r.version.id)).size).toBe(1);
    const page = await skills.list(ctx, { repository: source.repository });
    expect(page.items).toHaveLength(1);
    expect((await skills.listVersions(ctx, page.items[0]!.id)).items).toHaveLength(1);
    expect(await auditActions(ctx, page.items[0]!.id)).toEqual(["external_skill.imported"]);
  });

  it("another workspace or organization cannot see or change a skill", async () => {
    const a = await provision("esk-iso-a");
    const sameOrg = await provision("esk-iso-a2", a.organizationId);
    const otherOrg = await provision("esk-iso-b");
    const forged: TenantContext = { ...otherOrg, workspaceId: a.workspaceId };
    const skills = db.current.repos.externalSkills;
    const source = { repository: "acme/shared", path: "skills/one" };
    const { skill, version } = await skills.recordVersion(a, capture(source, "c1"));

    for (const b of [sameOrg, otherOrg, forged]) {
      expect(await skills.get(b, skill.id)).toBeUndefined();
      expect(await skills.findBySource(b, source.repository, source.path)).toBeUndefined();
      expect(await skills.findByName(b, "brand-voice", 10)).toEqual([]);
      expect((await skills.list(b)).items).toEqual([]);
      expect(await skills.getVersion(b, skill.id, version.id)).toBeUndefined();
      expect((await skills.listVersions(b, skill.id)).items).toEqual([]);
      expect(await skills.activateVersion(b, skill.id, version.id, importer)).toBeUndefined();
      expect(await skills.setStatus(b, skill.id, "disabled", importer)).toBeUndefined();
      expect(await skills.markUpstream(b, skill.id, "missing", importer)).toBeUndefined();
    }
    await expect(skills.recordVersion(forged, capture(source, "c9"))).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await skills.get(a, skill.id)).toMatchObject({ status: "enabled", upstream: "present" });
    expect((await skills.listVersions(a, skill.id)).items).toHaveLength(1);

    // The same source imported into another workspace is an independent skill.
    const copy = await skills.recordVersion(sameOrg, capture(source, "c1"));
    expect(copy.outcome).toBe("created");
    expect(copy.skill.id).not.toBe(skill.id);
    expect(copy.version.id).not.toBe(version.id);
    await skills.setStatus(sameOrg, copy.skill.id, "disabled", importer);
    expect((await skills.get(a, skill.id))?.status).toBe("enabled");
  });

  it("lists with search, status and repository filters and keyset pagination; finds by name", async () => {
    const ctx = await provision("esk-list");
    const skills = db.current.repos.externalSkills;
    const alpha = await skills.recordVersion(
      ctx,
      capture({ repository: "acme/skills", path: "alpha" }, "c1", {
        name: "Alpha",
        description: "100% sure",
      }),
    );
    const beta = await skills.recordVersion(
      ctx,
      capture({ repository: "acme/skills", path: "beta" }, "c1", { name: "beta_tool", description: "Beta" }),
    );
    const gamma = await skills.recordVersion(
      ctx,
      capture({ repository: "other/repo", path: "gamma" }, "c1", { name: "ALPHA", description: "Gamma" }),
    );
    await skills.setStatus(ctx, beta.skill.id, "disabled", importer);

    const ids = async (query: Parameters<typeof skills.list>[1]) =>
      (await skills.list(ctx, query)).items.map((s) => s.id);
    expect(await ids({})).toEqual([gamma.skill.id, beta.skill.id, alpha.skill.id]);
    expect(await ids({ q: "alpha" })).toEqual([gamma.skill.id, alpha.skill.id]);
    expect(await ids({ q: "OTHER/" })).toEqual([gamma.skill.id]);
    expect(await ids({ q: "%" })).toEqual([alpha.skill.id]);
    expect(await ids({ q: "a_t" })).toEqual([beta.skill.id]);
    expect(await ids({ q: "_" })).toEqual([beta.skill.id]);
    expect(await ids({ q: "\\" })).toEqual([]);
    expect(await ids({ status: "disabled" })).toEqual([beta.skill.id]);
    expect(await ids({ status: "enabled", repository: "acme/skills" })).toEqual([alpha.skill.id]);

    const first = await skills.list(ctx, { limit: 2 });
    expect(first.items.map((s) => s.id)).toEqual([gamma.skill.id, beta.skill.id]);
    expect(first.nextCursor).toBeDefined();
    const second = await skills.list(ctx, { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((s) => s.id)).toEqual([alpha.skill.id]);
    expect(second.nextCursor).toBeUndefined();

    expect((await skills.findByName(ctx, "alpha", 10)).map((s) => s.id)).toEqual([
      gamma.skill.id,
      alpha.skill.id,
    ]);
    expect((await skills.findByName(ctx, "alpha", 1)).map((s) => s.id)).toEqual([gamma.skill.id]);
    expect(await skills.findByName(ctx, "alp", 10)).toEqual([]);
  });

  it("keeps versions immutable and readable from a fresh connection", async () => {
    const ctx = await provision("esk-durable");
    const skills = db.current.repos.externalSkills;
    const source = { repository: "acme/skills", path: "durable" };
    const first = await skills.recordVersion(ctx, capture(source, "c1"));
    await skills.recordVersion(ctx, capture(source, "c2", { name: "renamed", description: "changed" }));
    await skills.recordVersion(ctx, capture(source, "c1"));

    const fresh = createDb(db.current.url, { max: 1, applicationName: "studix-test-fresh" });
    try {
      const reader = createExternalSkillRepository(fresh.db, systemClock);
      const stored = await reader.getVersion(ctx, first.skill.id, first.version.id);
      expect(stored).toEqual(first.version);
      expect(stored?.manifest).toEqual(first.version.manifest);
      const skill = await reader.get(ctx, first.skill.id);
      expect(skill).toMatchObject({ activeVersionId: first.version.id, name: "brand-voice" });
      expect((await reader.listVersions(ctx, first.skill.id)).items).toHaveLength(2);
    } finally {
      await fresh.close();
    }
  });

  it("rejects a manifest that describes a different source or commit", async () => {
    const ctx = await provision("esk-invalid");
    const input = capture({ repository: "acme/skills", path: "x" }, "c1");
    await expect(
      db.current.repos.externalSkills.recordVersion(ctx, { ...input, commitSha: "c2" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await db.current.repos.externalSkills.findBySource(ctx, "acme/skills", "x")).toBeUndefined();
  });
});
