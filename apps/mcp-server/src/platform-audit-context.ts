import type { TenantContext, TenantDirectory } from "@studix/core";
import { StudixError } from "@studix/shared";

/**
 * Where platform credential audit events are written. Platform events belong to the platform, not to the
 * tenant workspace the operator happens to have selected, where that tenant's admins could read them: with
 * STUDIX_PLATFORM_WORKSPACE_ID set, they go to that workspace, and an operator who is not an operator member
 * there is refused before anything changes. Without it, events stay in the session's workspace.
 */
export function platformAuditContext(
  workspaceId: string | undefined,
  directory: Pick<TenantDirectory, "listMemberships">,
): ((ctx: TenantContext) => Promise<TenantContext>) | undefined {
  if (!workspaceId) return undefined;
  return async (ctx) => {
    if (ctx.workspaceId === workspaceId) return ctx;
    const memberships = await directory.listMemberships(ctx.actor.id);
    const platform = memberships.find((m) => m.workspace.id === workspaceId && m.member.role === "operator");
    if (!platform) {
      throw new StudixError("FORBIDDEN", "Platform credentials are managed from the platform workspace", {
        retryable: false,
        suggestedAction:
          "Ask for the operator role in the platform workspace (STUDIX_PLATFORM_WORKSPACE_ID).",
      });
    }
    return { organizationId: platform.organization.id, workspaceId, actor: ctx.actor };
  };
}
