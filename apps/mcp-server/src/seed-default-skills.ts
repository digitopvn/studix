import type { TenantContext, TenantDirectory } from "@studix/core";
import type { Logger } from "@studix/shared";
import { type ExternalSkillService, loadDefaultSkills } from "@studix/skills";

/**
 * Store the skills bundled with Studix (packages/skills/defaults) as platform skills in the operator's
 * platform workspace, so every workspace has them on by default. Runs at startup and is idempotent:
 * unchanged skills write nothing. Without STUDIX_PLATFORM_WORKSPACE_ID or skill storage it only logs.
 */
export async function seedDefaultSkills(deps: {
  platformWorkspaceId: string | undefined;
  directory: Pick<TenantDirectory, "findWorkspace">;
  skills: ExternalSkillService | undefined;
  logger: Logger;
  root?: string;
}): Promise<void> {
  const { logger } = deps;
  if (!deps.skills) return;
  if (!deps.platformWorkspaceId) {
    logger.info("default skills not seeded: set STUDIX_PLATFORM_WORKSPACE_ID to install them");
    return;
  }
  const found = await deps.directory.findWorkspace(deps.platformWorkspaceId);
  if (!found) {
    logger.warn("default skills not seeded: the platform workspace does not exist", {
      workspaceId: deps.platformWorkspaceId,
    });
    return;
  }
  const ctx: TenantContext = {
    organizationId: found.organization.id,
    workspaceId: found.workspace.id,
    actor: { type: "system", id: "default-skills" },
  };
  const items = await deps.skills.seedDefaults(ctx, await loadDefaultSkills(deps.root));
  const count = (outcome: string) => items.filter((i) => i.outcome === outcome).length;
  logger.info("default skills seeded", {
    imported: count("imported"),
    updated: count("new_version"),
    unchanged: count("unchanged"),
    rejected: count("rejected"),
  });
  for (const item of items.filter((i) => i.outcome === "rejected")) {
    logger.warn("default skill rejected", { path: item.path, error: item.error?.message });
  }
}
