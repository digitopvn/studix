import type { TenantContext } from "@studix/core";
import { createInMemoryStudio } from "@studix/core/testing";
import { createManualClock, StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "../src/api-key-format.ts";
import { createApiKeyService } from "../src/api-key-service.ts";

async function setup() {
  const clock = createManualClock(new Date("2026-01-01T00:00:00Z"));
  const studio = createInMemoryStudio({ clock });
  const { directory, apiKeys } = studio.repos;
  const service = createApiKeyService({ directory, apiKeys, env: "test", clock });
  const provision = async (slug: string): Promise<TenantContext> => {
    const { organization, workspace } = await directory.provisionWorkspace({
      organization: { name: slug, slug },
      workspace: { name: slug, slug },
    });
    return {
      organizationId: organization.id,
      workspaceId: workspace.id,
      actor: { type: "user", id: `usr_${slug}`, role: "owner" },
    };
  };
  return { ...studio, clock, service, provision };
}

async function expectCode(promise: Promise<unknown>, code: string) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(StudixError);
  expect((error as StudixError).code).toBe(code);
  return error as StudixError;
}

describe("api key service", () => {
  it("stores only the hash and prefix, returns the secret once, and authenticates to the key's tenant", async () => {
    const { service, provision, repos } = await setup();
    const ctx = await provision("alpha");
    const created = await service.create(ctx, { name: "ci", role: "editor" });
    expect(created.secret).toMatch(/^stx_test_/);
    const stored = (await repos.apiKeys.list(ctx))[0]!;
    expect(stored.hash).toBe(hashApiKey(created.secret));
    expect(JSON.stringify(stored)).not.toContain(created.secret);
    expect(JSON.stringify(await service.list(ctx))).not.toContain(created.secret);
    expect(created.apiKey).not.toHaveProperty("hash");
    expect(created.apiKey.role).toBe("editor");

    const tenant = await service.authenticate(`Bearer ${created.secret}`);
    expect(tenant.workspaceId).toBe(ctx.workspaceId);
    expect(tenant.organizationId).toBe(ctx.organizationId);
    expect(tenant.actor).toMatchObject({ type: "apiKey", id: created.apiKey.id });
    expect((await service.list(ctx))[0]!.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects missing, malformed and unknown keys without echoing them", async () => {
    const { service } = await setup();
    await expectCode(service.authenticate(undefined), "UNAUTHENTICATED");
    await expectCode(service.authenticate("Basic abc"), "UNAUTHENTICATED");
    const forged = `stx_test_${"A".repeat(43)}`;
    const error = await expectCode(service.authenticate(`Bearer ${forged}`), "UNAUTHENTICATED");
    expect(JSON.stringify(error.toJSON())).not.toContain(forged);
    expect(error.message).not.toContain(forged);
  });

  it("rejects a revoked key on the next request", async () => {
    const { service, provision } = await setup();
    const ctx = await provision("beta");
    const { secret, apiKey } = await service.create(ctx, { name: "temp" });
    await service.authenticate(`Bearer ${secret}`);
    const revoked = await service.revoke(ctx, apiKey.id);
    expect(revoked.status).toBe("revoked");
    await expectCode(service.authenticate(`Bearer ${secret}`), "UNAUTHENTICATED");
  });

  it("rejects an expired key", async () => {
    const { service, provision, clock } = await setup();
    const ctx = await provision("gamma");
    const { secret } = await service.create(ctx, {
      name: "short",
      expiresAt: new Date(clock.now().getTime() + 60_000),
    });
    await service.authenticate(`Bearer ${secret}`);
    clock.advance(61_000);
    await expectCode(service.authenticate(`Bearer ${secret}`), "UNAUTHENTICATED");
    expect((await service.list(ctx))[0]!.status).toBe("expired");
  });

  it("refuses expiry in the past and scopes the caller does not hold", async () => {
    const { service, provision, clock } = await setup();
    const owner = await provision("delta");
    await expectCode(
      service.create(owner, { name: "old", expiresAt: new Date(clock.now().getTime() - 1) }),
      "VALIDATION",
    );
    const editor: TenantContext = { ...owner, actor: { type: "user", id: "usr_ed", role: "editor" } };
    await expectCode(service.create(editor, { name: "x" }), "FORBIDDEN");
    const keyActor: TenantContext = {
      ...owner,
      actor: { type: "apiKey", id: "key_1", scopes: ["apikey:manage"] },
    };
    await expectCode(service.create(keyActor, { name: "x", scopes: ["publish"] }), "FORBIDDEN");
  });

  it("cannot list or revoke another workspace's keys", async () => {
    const { service, provision } = await setup();
    const a = await provision("ws-a");
    const b = await provision("ws-b");
    const { apiKey, secret } = await service.create(a, { name: "a-key" });
    expect(await service.list(b)).toEqual([]);
    await expectCode(service.revoke(b, apiKey.id), "NOT_FOUND");
    expect((await service.authenticate(`Bearer ${secret}`)).workspaceId).toBe(a.workspaceId);
  });

  it("blocks cross-tenant project and job reads through StudioService", async () => {
    const { service, provision, studio } = await setup();
    const a = await provision("tenant-a");
    const b = await provision("tenant-b");
    const keyA = await service.create(a, { name: "a", role: "editor" });
    const keyB = await service.create(b, { name: "b", role: "editor" });
    const ctxA = await service.authenticate(`Bearer ${keyA.secret}`);
    const ctxB = await service.authenticate(`Bearer ${keyB.secret}`);
    const created = await studio.createVideoProject(ctxB, { brief: { prompt: "Tenant B video" } });

    await expectCode(studio.getJob(ctxA, created.job.id), "NOT_FOUND");
    await expectCode(studio.getProject(ctxA, created.project.id), "NOT_FOUND");
    await expectCode(studio.cancelJob(ctxA, created.job.id), "NOT_FOUND");
    expect((await studio.listProjects(ctxA)).items).toEqual([]);
    expect((await studio.getJob(ctxB, created.job.id)).id).toBe(created.job.id);
  });
});
