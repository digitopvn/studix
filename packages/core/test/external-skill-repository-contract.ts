import type {
  ActorRef,
  ExternalSkillManifest,
  ExternalSkillRepository,
  ImportVersionInput,
  TenantContext,
} from "@studix/core";
import { describe, expect, it } from "vitest";

/**
 * Behavior every `ExternalSkillRepository` must share. Run against the in-memory fake (unit) and Postgres
 * (integration) so the fake can stand in for the database in service tests.
 */
export interface ExternalSkillRepositoryHarness {
  repo(): ExternalSkillRepository;
  /** A fresh tenant; with `sameOrganizationAs`, a new workspace of that tenant's organization. */
  tenant(sameOrganizationAs?: TenantContext): Promise<TenantContext>;
}

const createdBy: ActorRef = { type: "user", id: "usr_owner" };

function manifest(repository: string, skillPath: string, commitSha: string): ExternalSkillManifest {
  return {
    frontmatter: { name: "skill" },
    files: [
      {
        path: "SKILL.md",
        kind: "skill",
        bytes: 12,
        sha256: "a".repeat(64),
        contentType: "text/markdown",
        storageKey: `skills/${commitSha}/SKILL.md`,
      },
    ],
    license: { spdxId: "MIT", name: "MIT License", source: "repository", uncertain: false },
    notices: [],
    warnings: [],
    source: {
      repository,
      url: `https://github.com/${repository}`,
      ref: "main",
      commitSha,
      treeSha: "t".repeat(40),
    },
    skillPath,
  };
}

function importInput(overrides: Partial<ImportVersionInput> = {}): ImportVersionInput {
  const repository = overrides.repository ?? "acme/skills";
  const skillPath = overrides.skillPath ?? "skills/pdf";
  const commitSha = overrides.commitSha ?? "c".repeat(40);
  return {
    repository,
    skillPath,
    commitSha,
    contentHash: "hash-1",
    name: "pdf",
    description: "Read PDF files",
    manifest: manifest(repository.toLowerCase(), skillPath, commitSha),
    skillStorageKey: `skills/${commitSha}/SKILL.md`,
    createdBy,
    ...overrides,
  };
}

export function runExternalSkillRepositoryContract(label: string, harness: ExternalSkillRepositoryHarness) {
  describe(`${label} external skill repository`, () => {
    it("creates the skill and activates its first version", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const result = await repo.importVersion(ctx, importInput({ repository: "Acme/Skills" }));

      expect(result).toMatchObject({ outcome: "created", skillCreated: true, activated: true });
      expect(result.skill).toMatchObject({
        repository: "acme/skills",
        skillPath: "skills/pdf",
        name: "pdf",
        description: "Read PDF files",
        enabled: true,
        activeVersionId: result.version.id,
        upstreamStatus: "unknown",
        createdBy,
        organizationId: ctx.organizationId,
        workspaceId: ctx.workspaceId,
      });
      expect(result.version).toMatchObject({
        skillId: result.skill.id,
        contentHash: "hash-1",
        commitSha: "c".repeat(40),
        createdBy,
      });
      expect(result.skill.id).toMatch(/^xsk_/);
      expect(result.version.id).toMatch(/^xsv_/);
      expect(result.version.manifest).toEqual(importInput().manifest);

      expect(await repo.get(ctx, result.skill.id)).toEqual(result.skill);
      expect(await repo.findBySource(ctx, "ACME/skills", "skills/pdf")).toEqual(result.skill);
      expect(await repo.findBySource(ctx, "acme/skills", "skills/other")).toBeUndefined();
      expect(await repo.getVersion(ctx, result.skill.id, result.version.id)).toEqual(result.version);
    });

    it("uses caller-supplied ids for a new skill and version", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const suffix = Math.random().toString(36).slice(2, 10);
      const result = await repo.importVersion(
        ctx,
        importInput({ skillId: `xsk_given${suffix}`, versionId: `xsv_given${suffix}` }),
      );
      expect(result.skill.id).toBe(`xsk_given${suffix}`);
      expect(result.version.id).toBe(`xsv_given${suffix}`);
    });

    it("re-importing the same content is unchanged", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const first = await repo.importVersion(ctx, importInput());
      const again = await repo.importVersion(ctx, importInput({ commitSha: "d".repeat(40) }));

      expect(again).toMatchObject({ outcome: "unchanged", skillCreated: false, activated: false });
      expect(again.version).toEqual(first.version);
      expect(again.skill).toEqual(first.skill);
      expect((await repo.listVersions(ctx, first.skill.id)).items).toHaveLength(1);
    });

    it("stores new content as an inactive version until it is activated", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const first = await repo.importVersion(ctx, importInput());
      const second = await repo.importVersion(
        ctx,
        importInput({ contentHash: "hash-2", name: "pdf-pro", description: "Read and fill PDF files" }),
      );

      expect(second).toMatchObject({ outcome: "created", skillCreated: false, activated: false });
      expect(second.version).toMatchObject({ skillId: first.skill.id, name: "pdf-pro" });
      expect(second.skill).toMatchObject({
        activeVersionId: first.version.id,
        name: "pdf",
        description: "Read PDF files",
      });
      const versions = await repo.listVersions(ctx, first.skill.id);
      expect(versions.items.map((v) => v.id)).toEqual([second.version.id, first.version.id]);

      const activated = await repo.activateVersion(ctx, first.skill.id, second.version.id);
      expect(activated).toMatchObject({
        id: first.skill.id,
        activeVersionId: second.version.id,
        name: "pdf-pro",
        description: "Read and fill PDF files",
      });
      expect(await repo.get(ctx, first.skill.id)).toEqual(activated);

      const back = await repo.activateVersion(ctx, first.skill.id, first.version.id);
      expect(back).toMatchObject({ activeVersionId: first.version.id, name: "pdf" });
    });

    it("refuses to activate a version of another skill or an unknown version", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const pdf = await repo.importVersion(ctx, importInput());
      const docx = await repo.importVersion(ctx, importInput({ skillPath: "skills/docx", name: "docx" }));

      expect(await repo.activateVersion(ctx, pdf.skill.id, docx.version.id)).toBeUndefined();
      expect(await repo.activateVersion(ctx, pdf.skill.id, "xsv_missing")).toBeUndefined();
      expect(await repo.activateVersion(ctx, "xsk_missing", pdf.version.id)).toBeUndefined();
      expect(await repo.getVersion(ctx, pdf.skill.id, docx.version.id)).toBeUndefined();
      expect((await repo.get(ctx, pdf.skill.id))?.activeVersionId).toBe(pdf.version.id);
    });

    it("concurrent identical imports converge on one skill and one version", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const results = await Promise.all(Array.from({ length: 8 }, () => repo.importVersion(ctx, importInput())));

      expect(new Set(results.map((r) => r.skill.id)).size).toBe(1);
      expect(new Set(results.map((r) => r.version.id)).size).toBe(1);
      expect(results.filter((r) => r.skillCreated)).toHaveLength(1);
      expect(results.filter((r) => r.outcome === "created")).toHaveLength(1);
      expect(results.filter((r) => r.activated)).toHaveLength(1);
      const skillId = results[0]!.skill.id;
      expect((await repo.list(ctx)).items).toHaveLength(1);
      expect((await repo.listVersions(ctx, skillId)).items).toHaveLength(1);
      expect((await repo.get(ctx, skillId))?.activeVersionId).toBe(results[0]!.version.id);
    });

    it("concurrent first imports of different content activate exactly one version", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          repo.importVersion(ctx, importInput({ contentHash: `hash-${i}`, name: `pdf-${i}` })),
        ),
      );

      expect(new Set(results.map((r) => r.skill.id)).size).toBe(1);
      expect(results.filter((r) => r.skillCreated)).toHaveLength(1);
      expect(results.every((r) => r.outcome === "created")).toBe(true);
      const winners = results.filter((r) => r.activated);
      expect(winners).toHaveLength(1);
      const skill = await repo.get(ctx, results[0]!.skill.id);
      expect(skill).toMatchObject({ activeVersionId: winners[0]!.version.id, name: winners[0]!.version.name });
      expect((await repo.listVersions(ctx, skill!.id)).items).toHaveLength(8);
    });

    it("hides every skill and version from other workspaces", async () => {
      const repo = harness.repo();
      const owner = await harness.tenant();
      const others = [await harness.tenant(), await harness.tenant(owner)];
      const { skill, version } = await repo.importVersion(owner, importInput());
      const checkedAt = new Date("2026-02-01T00:00:00Z");

      for (const other of others) {
        expect(await repo.get(other, skill.id)).toBeUndefined();
        expect(await repo.findBySource(other, skill.repository, skill.skillPath)).toBeUndefined();
        expect((await repo.list(other)).items).toEqual([]);
        expect(await repo.getVersion(other, skill.id, version.id)).toBeUndefined();
        expect((await repo.listVersions(other, skill.id)).items).toEqual([]);
        expect(await repo.activateVersion(other, skill.id, version.id)).toBeUndefined();
        expect(await repo.setEnabled(other, skill.id, false)).toBeUndefined();
        expect(
          await repo.recordUpstreamCheck(other, skill.id, { status: "missing", checkedAt }),
        ).toBeUndefined();

        // The same source imported elsewhere is an independent skill.
        const theirs = await repo.importVersion(other, importInput());
        expect(theirs).toMatchObject({ skillCreated: true, outcome: "created", activated: true });
        expect(theirs.skill.id).not.toBe(skill.id);
        expect(theirs.version.id).not.toBe(version.id);
        expect(await repo.getVersion(owner, skill.id, theirs.version.id)).toBeUndefined();
      }

      expect(await repo.get(owner, skill.id)).toEqual(skill);
      expect((await repo.list(owner)).items.map((s) => s.id)).toEqual([skill.id]);
    });

    it("lists newest first with filters and keyset pages", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const add = async (repository: string, skillPath: string, name: string, description: string) =>
        (await repo.importVersion(ctx, importInput({ repository, skillPath, name, description }))).skill;
      const pdf = await add("acme/skills", "pdf", "pdf", "Read PDF files");
      const percent = await add("acme/skills", "percent", "discount", "Apply 100% off");
      const underscore = await add("acme/skills", "snake", "snake_case", "Rename identifiers");
      const backslash = await add("other/tools", "paths", "paths", "Fix C:\\ paths");
      const plain = await add("other/tools", "plain", "plain", "Nothing special at 100 percent");
      await repo.setEnabled(ctx, pdf.id, false);

      const all = await repo.list(ctx);
      expect(all.items.map((s) => s.id)).toEqual([plain.id, backslash.id, underscore.id, percent.id, pdf.id]);
      expect(all.nextCursor).toBeUndefined();

      const ids = async (query: Parameters<ExternalSkillRepository["list"]>[1]) =>
        (await repo.list(ctx, query)).items.map((s) => s.id);
      expect(await ids({ enabled: false })).toEqual([pdf.id]);
      expect(await ids({ enabled: true })).toEqual([plain.id, backslash.id, underscore.id, percent.id]);
      expect(await ids({ repository: "Other/Tools" })).toEqual([plain.id, backslash.id]);
      expect(await ids({ query: "PDF" })).toEqual([pdf.id]);
      expect(await ids({ query: "OTHER/" })).toEqual([plain.id, backslash.id]);
      expect(await ids({ query: "identifiers" })).toEqual([underscore.id]);
      expect(await ids({ query: "%" })).toEqual([percent.id]);
      expect(await ids({ query: "100%" })).toEqual([percent.id]);
      expect(await ids({ query: "_" })).toEqual([underscore.id]);
      expect(await ids({ query: "\\" })).toEqual([backslash.id]);
      expect(await ids({ query: "   " })).toHaveLength(5);
      expect(await ids({ query: "pdf", enabled: true })).toEqual([]);
      expect(await ids({ query: "rename", repository: "other/tools" })).toEqual([]);

      const first = await repo.list(ctx, { limit: 2 });
      expect(first.items.map((s) => s.id)).toEqual([plain.id, backslash.id]);
      const second = await repo.list(ctx, { limit: 2, cursor: first.nextCursor });
      expect(second.items.map((s) => s.id)).toEqual([underscore.id, percent.id]);
      const third = await repo.list(ctx, { limit: 2, cursor: second.nextCursor });
      expect(third.items.map((s) => s.id)).toEqual([pdf.id]);
      expect(third.nextCursor).toBeUndefined();
      await expect(repo.list(ctx, { limit: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    });

    it("pages versions newest first", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const imported = [];
      for (let i = 0; i < 3; i++) imported.push(await repo.importVersion(ctx, importInput({ contentHash: `h${i}` })));
      const skillId = imported[0]!.skill.id;
      const first = await repo.listVersions(ctx, skillId, { limit: 2 });
      expect(first.items.map((v) => v.id)).toEqual([imported[2]!.version.id, imported[1]!.version.id]);
      const rest = await repo.listVersions(ctx, skillId, { limit: 2, cursor: first.nextCursor });
      expect(rest.items.map((v) => v.id)).toEqual([imported[0]!.version.id]);
      expect(rest.nextCursor).toBeUndefined();
    });

    it("disables and re-enables a skill", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const { skill } = await repo.importVersion(ctx, importInput());

      expect(await repo.setEnabled(ctx, skill.id, false)).toMatchObject({ id: skill.id, enabled: false });
      expect((await repo.get(ctx, skill.id))?.enabled).toBe(false);
      expect(await repo.setEnabled(ctx, skill.id, true)).toMatchObject({ enabled: true });
      expect(await repo.setEnabled(ctx, "xsk_missing", false)).toBeUndefined();

      // Re-importing keeps a disabled skill disabled.
      await repo.setEnabled(ctx, skill.id, false);
      const again = await repo.importVersion(ctx, importInput({ contentHash: "hash-2" }));
      expect(again.skill.enabled).toBe(false);
    });

    it("records upstream checks", async () => {
      const repo = harness.repo();
      const ctx = await harness.tenant();
      const { skill } = await repo.importVersion(ctx, importInput());
      const checkedAt = new Date("2026-03-01T12:00:00Z");

      const changed = await repo.recordUpstreamCheck(ctx, skill.id, {
        status: "changed",
        checkedAt,
        commitSha: "e".repeat(40),
      });
      expect(changed).toMatchObject({
        upstreamStatus: "changed",
        upstreamCheckedAt: checkedAt,
        upstreamCommitSha: "e".repeat(40),
      });
      expect(await repo.get(ctx, skill.id)).toEqual(changed);

      const missing = await repo.recordUpstreamCheck(ctx, skill.id, { status: "missing", checkedAt });
      expect(missing?.upstreamStatus).toBe("missing");
      expect(missing?.upstreamCommitSha).toBeUndefined();
      expect(
        await repo.recordUpstreamCheck(ctx, "xsk_missing", { status: "current", checkedAt }),
      ).toBeUndefined();
    });
  });
}
