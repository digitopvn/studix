import { randomBytes } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { describe, expect, it } from "vitest";
import { createCredentialVault, parseCredentialKeyring } from "../src/index.ts";

const db = withTestDatabase();

async function provision(
  slug: string,
  userId: string,
  role: "owner" | "editor" = "owner",
): Promise<TenantContext> {
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: slug, slug },
  });
  return {
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor: { type: "user", id: userId, role },
  };
}

const as = (ctx: TenantContext, userId: string): TenantContext => ({
  ...ctx,
  actor: { type: "user", id: userId, role: "editor" },
});

const newConnection = (over: Record<string, unknown> = {}) => ({
  provider: "anthropic",
  label: "main",
  authMethod: "api_key" as const,
  owner: { type: "workspace" as const },
  status: "connected" as const,
  billingSource: "usage-based" as const,
  runtimes: ["pi" as const],
  createdBy: { type: "user" as const, id: "u1" },
  ...over,
});

describe("provider connections (Postgres)", () => {
  it("hides another member's personal connection from get, list, update and delete", async () => {
    const r = db.current.repos;
    const admin = await provision("pc-a", "u_admin");
    const shared = await r.providerConnections.create(admin, newConnection());
    const mine = await r.providerConnections.create(
      admin,
      newConnection({ label: "personal", owner: { type: "user", userId: "u_admin" } }),
    );

    const other = as(admin, "u_other");
    expect((await r.providerConnections.list(other)).map((c) => c.id)).toEqual([shared.id]);
    expect(await r.providerConnections.get(other, mine.id)).toBeUndefined();
    await expect(r.providerConnections.update(other, mine.id, { label: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await r.providerConnections.delete(other, mine.id);
    expect(await r.providerConnections.get(admin, mine.id)).toBeDefined();
    expect((await r.providerConnections.list(admin)).map((c) => c.id).sort()).toEqual(
      [shared.id, mine.id].sort(),
    );
  });

  it("isolates tenants and bumps version on update", async () => {
    const r = db.current.repos;
    const a = await provision("pc-t1", "u1");
    const b = await provision("pc-t2", "u1");
    const conn = await r.providerConnections.create(a, newConnection());
    expect(await r.providerConnections.get(b, conn.id)).toBeUndefined();
    expect(await r.providerConnections.list(b)).toEqual([]);
    const updated = await r.providerConnections.update(a, conn.id, {
      status: "expired",
      lastTest: { ok: false, at: new Date(1000), latencyMs: 12, code: "unauthenticated" },
    });
    expect(updated.version).toBe(2);
    expect(updated.lastTest?.at).toEqual(new Date(1000));
  });

  it("rejects a duplicate label per owner but allows it across owners", async () => {
    const r = db.current.repos;
    const ctx = await provision("pc-dup", "u1");
    await r.providerConnections.create(ctx, newConnection());
    await expect(r.providerConnections.create(ctx, newConnection())).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await r.providerConnections.create(ctx, newConnection({ owner: { type: "user", userId: "u1" } }));
  });

  it("stores ciphertext only and keeps credentials per workspace", async () => {
    const r = db.current.repos;
    const a = await provision("pc-v1", "u1");
    const b = await provision("pc-v2", "u1");
    const vault = createCredentialVault({
      store: r.sealedCredentials,
      keyring: parseCredentialKeyring(`k1:${randomBytes(32).toString("base64")}`),
    });
    const ref = await vault.put(a, "sk-ant-api03-supersecretvalue1234");
    const raw = await r.sealedCredentials.get(a, ref);
    expect(raw).toBeDefined();
    expect(raw).not.toContain("supersecret");
    expect(await r.sealedCredentials.get(b, ref)).toBeUndefined();
    await expect(r.sealedCredentials.put(b, ref, "forged")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await vault.reveal(a, ref)).toBe("sk-ant-api03-supersecretvalue1234");
    await vault.remove(a, ref);
    expect(await r.sealedCredentials.get(a, ref)).toBeUndefined();
  });

  it("upserts one preference per scope, stage and runtime and keeps personal ones private", async () => {
    const r = db.current.repos;
    const ctx = await provision("pc-pref", "u_admin");
    const conn = await r.providerConnections.create(ctx, newConnection());
    const input = {
      scope: { type: "workspace" as const },
      stage: "default",
      runtime: "pi" as const,
      connectionId: conn.id,
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      allowFallback: false,
      fallbacks: [],
    };
    const first = await r.modelPreferences.upsert(ctx, input);
    const second = await r.modelPreferences.upsert(ctx, { ...input, modelId: "claude-opus-4-5" });
    expect(second.id).toBe(first.id);
    expect(second.modelId).toBe("claude-opus-4-5");
    await r.modelPreferences.upsert(ctx, { ...input, scope: { type: "user", userId: "u_admin" } });
    const other = as(ctx, "u_other");
    expect((await r.modelPreferences.list(other)).map((p) => p.scope.type)).toEqual(["workspace"]);
    expect(await r.modelPreferences.list(ctx)).toHaveLength(2);
    expect(await r.modelPreferences.list(ctx, { runtime: "claude-agent-sdk" })).toEqual([]);
  });

  it("removes preferences when their connection is deleted", async () => {
    const r = db.current.repos;
    const ctx = await provision("pc-cascade", "u1");
    const conn = await r.providerConnections.create(ctx, newConnection());
    await r.modelPreferences.upsert(ctx, {
      scope: { type: "workspace" },
      stage: "default",
      runtime: "pi",
      connectionId: conn.id,
      provider: "anthropic",
      modelId: "m",
      allowFallback: false,
      fallbacks: [],
    });
    await r.providerConnections.delete(ctx, conn.id);
    expect(await r.modelPreferences.list(ctx)).toEqual([]);
  });

  it("refuses to create personal rows for a different user or a non-user actor", async () => {
    const r = db.current.repos;
    const ctx = await provision("pc-bind", "u1");
    const personal = newConnection({ label: "p", owner: { type: "user", userId: "someone_else" } });
    await expect(r.providerConnections.create(ctx, personal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const system: TenantContext = { ...ctx, actor: { type: "system", id: "worker" } };
    await expect(r.providerConnections.create(system, personal)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const conn = await r.providerConnections.create(ctx, newConnection());
    const pref = {
      scope: { type: "user" as const, userId: "someone_else" },
      stage: "default",
      runtime: "pi" as const,
      connectionId: conn.id,
      provider: "anthropic",
      modelId: "m",
      allowFallback: false,
      fallbacks: [],
    };
    await expect(r.modelPreferences.upsert(ctx, pref)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("only accepts preference connections the caller can see, and workspace-owned ones for workspace scope", async () => {
    const r = db.current.repos;
    const ctx = await provision("pc-pref-conn", "u1");
    const other = await provision("pc-pref-other", "u1");
    const foreign = await r.providerConnections.create(other, newConnection());
    const mine = await r.providerConnections.create(
      ctx,
      newConnection({ label: "p", owner: { type: "user", userId: "u1" } }),
    );
    const base = {
      stage: "default",
      runtime: "pi" as const,
      provider: "anthropic",
      modelId: "m",
      allowFallback: true,
      fallbacks: [],
    };
    await expect(
      r.modelPreferences.upsert(ctx, { ...base, scope: { type: "workspace" }, connectionId: foreign.id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      r.modelPreferences.upsert(ctx, { ...base, scope: { type: "workspace" }, connectionId: mine.id }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const shared = await r.providerConnections.create(ctx, newConnection());
    await expect(
      r.modelPreferences.upsert(ctx, {
        ...base,
        scope: { type: "workspace" },
        connectionId: shared.id,
        fallbacks: [{ connectionId: mine.id, provider: "anthropic", modelId: "m" }],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await r.modelPreferences.upsert(ctx, {
      ...base,
      scope: { type: "user", userId: "u1" },
      connectionId: mine.id,
    });
  });

  it("deletes the sealed secret together with its connection", async () => {
    const r = db.current.repos;
    const ctx = await provision("pc-del-secret", "u1");
    const vault = createCredentialVault({
      store: r.sealedCredentials,
      keyring: parseCredentialKeyring(`k1:${randomBytes(32).toString("base64")}`),
    });
    const secretRef = await vault.put(ctx, "sk-ant-api03-supersecretvalue1234");
    const conn = await r.providerConnections.create(ctx, newConnection({ secretRef }));
    await r.providerConnections.delete(ctx, conn.id);
    expect(await r.sealedCredentials.get(ctx, secretRef)).toBeUndefined();
  });

  it("pins the first model snapshot of a job and hides it from other workspaces", async () => {
    const r = db.current.repos;
    const ctx = await provision("pc-snap", "u1");
    const other = await provision("pc-snap-2", "u1");
    const project = await r.projects.create(ctx, {
      title: "Snap",
      status: "draft",
      brief: { prompt: "intro" },
      createdBy: { type: "user", id: "u1" },
    });
    const { job } = await r.queue.enqueue(ctx, {
      kind: "video.create",
      projectId: project.id,
      payload: { projectId: project.id },
      createdBy: { type: "user", id: "u1" },
    });
    const snapshot = {
      runtime: "pi" as const,
      stage: "plan",
      source: "workspace-stage" as const,
      connectionId: "pconn_1",
      connectionVersion: 1,
      provider: "openrouter",
      modelId: "model/a",
      authMethod: "api_key" as const,
      billingSource: "usage-based" as const,
      allowFallback: false,
      fallbacks: [],
    };

    expect(await r.modelSnapshots.pin(ctx, job.id, snapshot)).toEqual(snapshot);
    expect(await r.modelSnapshots.pin(ctx, job.id, { ...snapshot, modelId: "model/b" })).toEqual(snapshot);
    expect(await r.modelSnapshots.get(ctx, job.id, { runtime: "pi", stage: "plan" })).toEqual(snapshot);
    expect(await r.modelSnapshots.get(ctx, job.id, { runtime: "pi", stage: "render" })).toBeUndefined();

    expect(await r.modelSnapshots.get(other, job.id, { runtime: "pi", stage: "plan" })).toBeUndefined();
    await expect(r.modelSnapshots.pin(other, job.id, snapshot)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
