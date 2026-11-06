import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDefaultApprovalPolicy,
  PERMISSIONS,
  type Permission,
  StudioService,
  type TenantContext,
} from "@studix/core";
import { MIGRATIONS_FOLDER, schema } from "@studix/database";
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

describe("api key scopes after job:retry joined the role matrix", () => {
  it("upgrades keys issued with a role's earlier scope set and leaves custom keys alone", async () => {
    const { keys, repos } = services();
    const ctx = await tenant("pg-retry-scope");
    const createdBy = { type: "user" as const, id: ctx.actor.id };
    const issue = (name: string, scopes: Permission[]) =>
      repos.apiKeys.create(ctx, {
        name,
        hash: hashApiKey(`stx_test_${name}`),
        prefix: name,
        scopes,
        createdBy,
      });
    // Scope sets as issued before `job:retry` existed, in a shuffled stored order.
    const editor = await issue("old-editor", [
      "approval:request",
      "asset:write",
      "job:cancel",
      "project:write",
      "asset:read",
      "project:read",
      "workspace:read",
    ]);
    // `job:recover` came later still; 0017 adds it below and 0020 takes it back for operators only.
    const admin = await issue(
      "old-admin",
      PERMISSIONS.filter((p) => !p.startsWith("skill:") && p !== "job:retry" && p !== "job:recover"),
    );
    const custom = await issue("custom", ["project:read", "job:cancel"]);
    const already = await issue("already", ["project:read", "job:retry"]);
    // A reviewer key never got job:cancel, so it must not gain job:retry either.
    const reviewer = await issue("reviewer", [
      "workspace:read",
      "project:read",
      "asset:read",
      "approval:decide",
    ]);

    const sql = readFileSync(join(MIGRATIONS_FOLDER, "0012_api_key_job_retry.sql"), "utf8");
    await db.current.client.unsafe(sql);
    for (const later of [
      "0017_api_key_job_recover.sql",
      "0020_api_key_operator_job_recover.sql",
      "0024_api_key_skill_scopes.sql",
    ]) {
      await db.current.client.unsafe(readFileSync(join(MIGRATIONS_FOLDER, later), "utf8"));
    }

    const byId = new Map((await keys.list(ctx)).map((k) => [k.id, k]));
    expect(byId.get(editor.id)).toMatchObject({ role: "editor" });
    expect(byId.get(editor.id)?.scopes).toContain("job:retry");
    // owner and admin share one permission set; the label is the first role that matches.
    expect(byId.get(admin.id)).toMatchObject({ role: "owner" });
    expect(byId.get(custom.id)).toMatchObject({ role: "custom", scopes: ["project:read", "job:cancel"] });
    expect(byId.get(already.id)?.scopes).toEqual(["project:read", "job:retry"]);
    expect(byId.get(reviewer.id)).toMatchObject({ role: "reviewer" });
    expect(byId.get(reviewer.id)?.scopes).not.toContain("job:retry");

    // Running it again changes nothing.
    await db.current.client.unsafe(sql);
    expect(
      (await keys.list(ctx)).find((k) => k.id === editor.id)?.scopes.filter((s) => s === "job:retry"),
    ).toHaveLength(1);
  });
});

describe("api key scopes as job:recover joined the admin roles, then moved to operators", () => {
  it("gives the scope to owner and admin keys only, then takes it from every key", async () => {
    const { keys, repos } = services();
    const ctx = await tenant("pg-recover-scope");
    const createdBy = { type: "user" as const, id: ctx.actor.id };
    const issue = (name: string, scopes: Permission[]) =>
      repos.apiKeys.create(ctx, {
        name,
        hash: hashApiKey(`stx_test_recover_${name}`),
        prefix: name,
        scopes,
        createdBy,
      });
    const admin = await issue(
      "old-admin",
      [...PERMISSIONS.filter((p) => !p.startsWith("skill:") && p !== "job:recover")].reverse(),
    );
    const editor = await issue("editor", [
      "workspace:read",
      "project:read",
      "asset:read",
      "project:write",
      "job:cancel",
      "job:retry",
      "asset:write",
      "approval:request",
    ]);
    const sql = readFileSync(join(MIGRATIONS_FOLDER, "0017_api_key_job_recover.sql"), "utf8");
    await db.current.client.unsafe(sql);
    await db.current.client.unsafe(sql);

    const scopesOf = async () => new Map((await keys.list(ctx)).map((k) => [k.id, k.scopes]));
    const granted = await scopesOf();
    expect(granted.get(admin.id)?.filter((s) => s === "job:recover")).toHaveLength(1);
    expect(granted.get(editor.id)).not.toContain("job:recover");

    // A custom key minted by an owner while owners held the scope loses it too.
    const custom = await issue("custom", ["project:read", "job:recover"]);
    const strip = readFileSync(join(MIGRATIONS_FOLDER, "0020_api_key_operator_job_recover.sql"), "utf8");
    await db.current.client.unsafe(strip);
    await db.current.client.unsafe(strip);
    const skillScopes = readFileSync(join(MIGRATIONS_FOLDER, "0024_api_key_skill_scopes.sql"), "utf8");
    await db.current.client.unsafe(skillScopes);
    await db.current.client.unsafe(skillScopes);

    const byId = new Map((await keys.list(ctx)).map((k) => [k.id, k]));
    // The admin key is an owner/admin key again: owner and admin share one set, labelled by the first match.
    expect(byId.get(admin.id)).toMatchObject({ role: "owner" });
    expect(byId.get(admin.id)?.scopes).not.toContain("job:recover");
    expect(byId.get(editor.id)).toMatchObject({ role: "editor" });
    expect(byId.get(custom.id)?.scopes).toEqual(["project:read"]);
  });
});
