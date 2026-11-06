import { randomBytes } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { systemClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { runExternalSkillRepositoryContract } from "../../core/test/external-skill-repository-contract.ts";
import { createDb } from "../src/client.ts";
import { createExternalSkillRepository } from "../src/repositories/index.ts";
import { withTestDatabase } from "../src/testing/index.ts";

const db = withTestDatabase();

async function tenant(sameOrganizationAs?: TenantContext): Promise<TenantContext> {
  const slug = `xs-${randomBytes(4).toString("hex")}`;
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: sameOrganizationAs ? { id: sameOrganizationAs.organizationId } : { name: slug, slug },
    workspace: { name: slug, slug },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: "usr_owner", role: "owner" },
  };
}

runExternalSkillRepositoryContract("Postgres", { repo: () => db.current.repos.externalSkills, tenant });

describe("Postgres external skill repository persistence", () => {
  it("serves stored skills and versions to a fresh connection and repository", async () => {
    const ctx = await tenant();
    const repository = "acme/persisted";
    const first = await db.current.repos.externalSkills.importVersion(ctx, {
      repository,
      skillPath: ".",
      commitSha: "f".repeat(40),
      contentHash: "persist-1",
      name: "persisted",
      description: "Survives a restart",
      manifest: {
        frontmatter: { name: "persisted" },
        files: [],
        license: { source: "none", uncertain: true },
        notices: [],
        warnings: ["installs a package"],
        source: {
          repository,
          url: `https://github.com/${repository}`,
          ref: "main",
          commitSha: "f".repeat(40),
          treeSha: "0".repeat(40),
        },
        skillPath: ".",
      },
      skillStorageKey: "skills/persisted/SKILL.md",
      createdBy: { type: "apiKey", id: "key_1" },
    });

    const reopened = createDb(db.current.url, { max: 2, applicationName: "studix-test-restart" });
    try {
      const fresh = createExternalSkillRepository(reopened.db, systemClock);
      expect(await fresh.get(ctx, first.skill.id)).toEqual(first.skill);
      expect(await fresh.findBySource(ctx, repository, ".")).toEqual(first.skill);
      expect(await fresh.getVersion(ctx, first.skill.id, first.version.id)).toEqual(first.version);
      const again = await fresh.importVersion(ctx, {
        ...first.version,
        repository,
        skillPath: ".",
        createdBy: first.version.createdBy,
      });
      expect(again).toMatchObject({ outcome: "unchanged", skillCreated: false, activated: false });
      expect(again.version).toEqual(first.version);
    } finally {
      await reopened.close();
    }
  });
});
