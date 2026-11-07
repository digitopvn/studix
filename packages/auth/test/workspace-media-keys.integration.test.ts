import { randomBytes } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import type { ProviderKeyTester } from "../src/anthropic-key-tester.ts";
import { createProviderConnectionService } from "../src/provider-connection-service.ts";
import { createSecretBox } from "../src/secret-box.ts";

const db = withTestDatabase();
const SUME_KEY = "sume-live-workspace-key-0001";
const ATLAS_KEY = "atlas-workspace-key-0002";
const MEDIA_KEYS = { sume: "SUME_API_KEY", atlas: "ATLASCLOUD_API_KEY" };

const tester: ProviderKeyTester = {
  async test() {
    return { at: new Date(), latencyMs: 1, ok: true, verdict: "available" };
  },
};

function service(secrets = createSecretBox(randomBytes(32))) {
  return createProviderConnectionService({
    connections: db.current.repos.providerConnections,
    audit: db.current.repos.audit,
    tester,
    isSupportedProvider: () => true,
    secrets,
    mediaKeyNames: MEDIA_KEYS,
  });
}

async function workspace(slug: string) {
  const ownerId = `usr_${slug.replace(/-/g, "")}`;
  await insertTestUser(db.current, { id: ownerId, email: `${slug}@example.test` });
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
    ownerUserId: ownerId,
  });
  const base = { organizationId: organization.id, workspaceId: workspace.id };
  const as = (actor: TenantContext["actor"]): TenantContext => ({ ...base, actor });
  return {
    admin: as({ type: "user", id: ownerId, role: "owner" }),
    editor: as({ type: "user", id: `${ownerId}_editor`, role: "editor" }),
    worker: as({ type: "system", id: "worker" }),
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof StudixError ? e.code : String(e)),
  );
}

describe("workspace media keys (BYOK)", () => {
  it("stores, rotates and removes a workspace key without ever returning it", async () => {
    const providers = service();
    const t = await workspace("mk-crud");
    const saved = await providers.saveMediaKey(t.admin, "sume", { apiKey: SUME_KEY });
    expect(saved).toMatchObject({ vendor: "sume", source: "workspace", keyHint: "…0001", version: 1 });
    expect(JSON.stringify(saved)).not.toContain(SUME_KEY);

    const listed = await providers.listMediaKeys(t.editor);
    expect(listed).toMatchObject({ storage: "available", canManage: false });
    expect(listed.keys).toEqual([
      expect.objectContaining({ vendor: "sume", source: "workspace" }),
      { vendor: "atlas", source: "platform" },
    ]);
    expect(await providers.resolveMediaKeys(t.worker)).toEqual({ SUME_API_KEY: SUME_KEY });

    const rotated = await providers.saveMediaKey(t.admin, "sume", { apiKey: "sume-rotated-key-9999" });
    expect(rotated).toMatchObject({ keyHint: "…9999", version: 2 });
    expect(await providers.resolveMediaKeys(t.worker)).toEqual({ SUME_API_KEY: "sume-rotated-key-9999" });

    expect(await providers.removeMediaKey(t.admin, "sume")).toEqual({ vendor: "sume", source: "platform" });
    expect(await providers.resolveMediaKeys(t.worker)).toEqual({});
    expect(await codeOf(providers.removeMediaKey(t.admin, "sume"))).toBe("NOT_FOUND");
  });

  it("lets only workspace admins write, and only listed vendors", async () => {
    const providers = service();
    const t = await workspace("mk-rbac");
    expect(await codeOf(providers.saveMediaKey(t.editor, "sume", { apiKey: SUME_KEY }))).toBe("FORBIDDEN");
    expect(await codeOf(providers.saveMediaKey(t.admin, "openai", { apiKey: SUME_KEY }))).toBe("VALIDATION");
    expect(await codeOf(providers.saveMediaKey(t.admin, "sume", { apiKey: "has space key" }))).toBe(
      "VALIDATION",
    );
    await providers.saveMediaKey(t.admin, "sume", { apiKey: SUME_KEY });
    expect(await codeOf(providers.removeMediaKey(t.editor, "sume"))).toBe("FORBIDDEN");
  });

  it("never releases one workspace's key to another workspace", async () => {
    const providers = service();
    const a = await workspace("mk-iso-a");
    const b = await workspace("mk-iso-b");
    await providers.saveMediaKey(a.admin, "sume", { apiKey: SUME_KEY });
    await providers.saveMediaKey(b.admin, "atlas", { apiKey: ATLAS_KEY });
    expect(await providers.resolveMediaKeys(a.worker)).toEqual({ SUME_API_KEY: SUME_KEY });
    expect(await providers.resolveMediaKeys(b.worker)).toEqual({ ATLASCLOUD_API_KEY: ATLAS_KEY });
    expect((await providers.listMediaKeys(b.admin)).keys[0]).toEqual({ vendor: "sume", source: "platform" });
    expect(await codeOf(providers.removeMediaKey(b.admin, "sume"))).toBe("NOT_FOUND");
  });

  it("keeps media keys out of agent runtimes and the AI provider list", async () => {
    const providers = service();
    const t = await workspace("mk-agents");
    await providers.saveMediaKey(t.admin, "sume", { apiKey: SUME_KEY });
    expect((await providers.list(t.admin)).connections).toEqual([]);
    const [row] = await db.current.repos.providerConnections.listActive(t.admin);
    expect(row).toMatchObject({ provider: "media-sume", runtimes: [] });
    const id = row?.id as string;
    for (const runtime of ["pi", "claude"] as const) {
      expect(
        await codeOf(
          providers.resolveForExecution(t.admin, {
            connectionId: id,
            requestedBy: { type: "user", id: t.admin.actor.id },
            runtime,
          }),
        ),
      ).toBe("UNAVAILABLE");
    }
    // The generic calls cannot opt a media key into a runtime or touch it otherwise.
    expect(await codeOf(providers.setRuntimes(t.admin, id, { runtimes: ["pi"] }))).toBe("NOT_FOUND");
    expect(await codeOf(providers.remove(t.admin, id))).toBe("NOT_FOUND");
  });

  it("skips a key sealed with another master key instead of failing the call", async () => {
    const t = await workspace("mk-rekey");
    await service().saveMediaKey(t.admin, "sume", { apiKey: SUME_KEY });
    expect(await service().resolveMediaKeys(t.worker)).toEqual({});
  });
});
