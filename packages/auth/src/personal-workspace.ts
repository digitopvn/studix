import type { Member, Organization, TenantDirectory, Workspace } from "@studix/core";
import { isStudixError, type Logger } from "@studix/shared";

export interface Membership {
  member: Member;
  organization: Organization;
  workspace: Workspace;
}

export interface PersonalWorkspaceUser {
  id: string;
  name?: string | null;
  email: string;
}

/** Deterministic, globally unique org slug derived from the user id (ids are unique and slug-safe). */
export function personalOrganizationSlug(userId: string): string {
  return `u-${userId
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")}`.slice(0, 63);
}

function displayName(user: PersonalWorkspaceUser): string {
  const name = user.name?.trim() || user.email.split("@")[0] || "My";
  return name.slice(0, 80);
}

/**
 * Make sure a dashboard user belongs to at least one workspace. A fresh signup gets a personal organization,
 * a "Personal" workspace and an owner membership, so they can work immediately. Idempotent and safe under
 * concurrent calls: the org slug is derived from the user id, so a racing second call hits CONFLICT and
 * re-reads the memberships the first call created.
 */
export async function ensurePersonalWorkspace(
  directory: Pick<TenantDirectory, "listMemberships" | "provisionWorkspace">,
  user: PersonalWorkspaceUser,
  logger?: Logger,
): Promise<Membership[]> {
  const existing = await directory.listMemberships(user.id);
  if (existing.length > 0) return existing;
  try {
    const { organization, workspace, owner } = await directory.provisionWorkspace({
      organization: { name: displayName(user), slug: personalOrganizationSlug(user.id) },
      workspace: { name: "Personal", slug: "personal" },
      ownerUserId: user.id,
    });
    logger?.info("personal workspace provisioned", { userId: user.id, workspaceId: workspace.id });
    if (owner) return [{ member: owner, organization, workspace }];
  } catch (error) {
    if (!isStudixError(error) || error.code !== "CONFLICT") throw error;
  }
  return directory.listMemberships(user.id);
}
