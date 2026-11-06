import type { TenantContext } from "@studix/core";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createWorkspaceFeatureService } from "../src/workspace-feature-service.ts";

const db = withTestDatabase();
const OFF = { claudePlanner: false, claudeSubscription: false };

async function workspace(slug: string) {
  const ownerId = `usr_${slug.replace(/-/g, "")}`;
  await insertTestUser(db.current, { id: ownerId, email: `${slug}@example.test` });
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
    ownerUserId: ownerId,
  });
  const as = (actor: TenantContext["actor"]): TenantContext => ({
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor,
  });
  return {
    owner: as({ type: "user", id: ownerId, role: "owner" }),
    admin: as({ type: "user", id: `${ownerId}_admin`, role: "admin" }),
  };
}

const service = (selfHosted: boolean, operator = OFF) =>
  createWorkspaceFeatureService({
    settings: db.current.repos.workspaceSettings,
    audit: db.current.repos.audit,
    selfHosted,
    operator,
  });

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => (e instanceof StudixError ? e.code : String(e)),
  );

describe("workspace Claude switches", () => {
  it("lets only the owner switch features on, and only on a self-hosted server", async () => {
    const { owner, admin } = await workspace("features-owner");
    expect(await codeOf(service(false).update(owner, { claudeSubscription: true }))).toBe("FORBIDDEN");
    expect(await codeOf(service(true).update(admin, { claudeSubscription: true }))).toBe("FORBIDDEN");
    expect(await codeOf(service(true).update(owner, { other: true }))).toBe("VALIDATION");

    const view = await service(true).update(owner, { claudeSubscription: true });
    expect(view.claudeSubscription).toEqual({ enabled: true, source: "workspace", canChange: true });
    expect(view.claudePlanner.enabled).toBe(false);
    expect(await service(true).effective(owner)).toEqual({ claudePlanner: false, claudeSubscription: true });
    expect((await service(true).view(admin)).claudeSubscription.canChange).toBe(false);
  });

  it("ignores saved switches on a hosted server and lets env flags win", async () => {
    const { owner } = await workspace("features-hosted");
    await service(true).update(owner, { claudePlanner: true });
    expect(await service(false).effective(owner)).toEqual(OFF);
    const forced = service(false, { claudePlanner: false, claudeSubscription: true });
    expect(await forced.effective(owner)).toEqual({ claudePlanner: false, claudeSubscription: true });
    expect((await forced.view(owner)).claudeSubscription).toEqual({
      enabled: true,
      source: "operator",
      canChange: false,
    });
  });
});
