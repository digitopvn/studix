import { createDefaultApprovalPolicy, StudioService, type TenantContext } from "@studix/core";
import { schema } from "@studix/database";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { StudixError, systemClock } from "@studix/shared";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hashApiKey } from "../src/api-key-format.ts";
import { createApiKeyService } from "../src/api-key-service.ts";

const db = withTestDatabase();

function services() {
  const repos = db.current.repos;
  const keys = createApiKeyService({ directory: repos.directory, apiKeys: repos.apiKeys, env: "test" });
  const studio = new StudioService({
    ...repos,
    approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
    clock: systemClock,
  });
  return { keys, studio, repos };
}

async function tenant(slug: string): Promise<TenantContext> {
  const userId = `usr_${slug.replace(/-/g, "")}`;
  await insertTestUser(db.current, { id: userId, email: `${slug}@example.test` });
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
    ownerUserId: userId,
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: userId, role: "owner" },
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof StudixError ? e.code : String(e)),
  );
}

describe("workspace API keys over Postgres", () => {
  it("persists only the sha256 hash and prefix", async () => {
    const { keys } = services();
    const ctx = await tenant("pg-hash");
    const { secret, apiKey } = await keys.create(ctx, { name: "ci" });
    const rows = await db.current.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, apiKey.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.hash).toBe(hashApiKey(secret));
    expect(rows[0]!.prefix).toBe(apiKey.prefix);
    expect(JSON.stringify(rows[0])).not.toContain(secret);
  });

  it("authenticates, records last use, and rejects after revocation and expiry", async () => {
    const { keys } = services();
    const ctx = await tenant("pg-revoke");
    const live = await keys.create(ctx, { name: "live" });
    const resolved = await keys.authenticate(`Bearer ${live.secret}`);
    expect(resolved).toMatchObject({ workspaceId: ctx.workspaceId, organizationId: ctx.organizationId });
    expect((await keys.list(ctx)).find((k) => k.id === live.apiKey.id)?.lastUsedAt).toBeInstanceOf(Date);
    await keys.revoke(ctx, live.apiKey.id);
    expect(await codeOf(keys.authenticate(`Bearer ${live.secret}`))).toBe("UNAUTHENTICATED");

    const expiring = await keys.create(ctx, { name: "soon", expiresAt: new Date(Date.now() + 1500) });
    await keys.authenticate(`Bearer ${expiring.secret}`);
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(await codeOf(keys.authenticate(`Bearer ${expiring.secret}`))).toBe("UNAUTHENTICATED");
  });

  it("scopes each key to one workspace: workspace A's key cannot reach workspace B", async () => {
    const { keys, studio } = services();
    const a = await tenant("pg-tenant-a");
    const b = await tenant("pg-tenant-b");
    const keyA = await keys.create(a, { name: "a", role: "editor" });
    const ctxA = await keys.authenticate(`Bearer ${keyA.secret}`);
    const inB = await studio.createVideoProject(b, {
      brief: { prompt: "Only for B" },
      idempotencyKey: "b-1",
    });

    expect(await codeOf(studio.getJob(ctxA, inB.job.id))).toBe("NOT_FOUND");
    expect(await codeOf(studio.getProject(ctxA, inB.project.id))).toBe("NOT_FOUND");
    expect(await codeOf(studio.cancelJob(ctxA, inB.job.id))).toBe("NOT_FOUND");
    expect((await studio.listProjects(ctxA)).items).toEqual([]);
    // Same idempotency key in A creates A's own job instead of replaying B's.
    const inA = await studio.createVideoProject(ctxA, { brief: { prompt: "A" }, idempotencyKey: "b-1" });
    expect(inA.job.id).not.toBe(inB.job.id);
    expect(inA.replayed).toBe(false);
    // Key management is tenant-scoped too.
    expect(await codeOf(keys.revoke(b, keyA.apiKey.id))).toBe("NOT_FOUND");
  });
});
