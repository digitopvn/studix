import type { Actor, AuditEvent, AuditRepository, TenantContext } from "@studix/core";
import type { StorageProfileRecord, StorageProfileRepository } from "@studix/database";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createSecretBox, parseSecretKey } from "../src/secret-box.ts";
import { createStorageProfileService, type StorageProfileFields } from "../src/storage-profile-service.ts";

const MASTER = Buffer.alloc(32, 7).toString("base64");
const ACCESS = "AKIAEXAMPLEACCESS0001";
const SECRET = "secret-value-0123456789abcdefWXYZ";
const FIELDS: StorageProfileFields = {
  name: "Media R2",
  providerType: "cloudflare-r2",
  endpoint: "https://acct.r2.cloudflarestorage.com",
  bucket: "studix-media",
  region: "auto",
};

function ctxOf(actor: Actor, workspaceId = "ws_1"): TenantContext {
  return { organizationId: "org_1", workspaceId, actor };
}
const operator = ctxOf({ type: "user", id: "usr_op", role: "operator" });

function memoryRepo(references: Map<string, number> = new Map()) {
  const rows = new Map<string, StorageProfileRecord>();
  const repo: StorageProfileRepository = {
    async list() {
      return [...rows.values()];
    },
    async get(id) {
      return rows.get(id);
    },
    async create(input, by) {
      const now = new Date();
      const row: StorageProfileRecord = {
        ...input,
        active: false,
        version: 1,
        updatedBy: by,
        createdAt: now,
        updatedAt: now,
      };
      rows.set(input.id, row);
      return row;
    },
    async update(id, input, by) {
      const prev = rows.get(id);
      if (!prev) return undefined;
      const row = { ...prev, ...input, version: prev.version + 1, updatedBy: by, updatedAt: new Date() };
      rows.set(id, row);
      return row;
    },
    async activate(id) {
      for (const [k, r] of rows) rows.set(k, { ...r, active: k === id });
    },
    async delete(id) {
      const row = rows.get(id);
      return Boolean(row && !row.active && rows.delete(id));
    },
    async recordTest(id, result) {
      const row = rows.get(id);
      if (!row) return false;
      rows.set(id, { ...row, lastTest: result });
      return true;
    },
    async countReferences(id) {
      return references.get(id) ?? 0;
    },
    async locate() {
      return undefined;
    },
  };
  return { rows, repo, references };
}

function setup(options: { checkEndpoint?: (e: string) => Promise<{ endpoint: string }> } = {}) {
  const { rows, repo, references } = memoryRepo();
  const events: AuditEvent[] = [];
  const logs: string[] = [];
  const audit: AuditRepository = {
    async append(_ctx, input) {
      const event = { id: `aud_${events.length}`, createdAt: new Date(), ...input } as unknown as AuditEvent;
      events.push(event);
      return event;
    },
    async list() {
      return { items: events };
    },
  };
  const log = (msg: string, data?: unknown) => logs.push(`${msg} ${JSON.stringify(data ?? {})}`);
  const service = createStorageProfileService({
    profiles: repo,
    audit,
    secrets: createSecretBox(parseSecretKey(MASTER)),
    checkEndpoint: async (e) => (options.checkEndpoint ? options.checkEndpoint(e) : { endpoint: e }),
    checkKeyPrefix: (p) => {
      if (p.includes("..")) throw new StudixError("VALIDATION", "bad prefix", { retryable: false });
    },
    cacheMs: 0,
    logger: { debug: log, info: log, warn: log, error: log } as never,
  });
  return { rows, references, events, logs, service };
}

const ok = async () => {};
const key = { accessKeyId: ACCESS, secretAccessKey: SECRET };

describe("storage profile service permissions", () => {
  it.each([
    ["owner", { type: "user", id: "u", role: "owner" }],
    ["admin", { type: "user", id: "u", role: "admin" }],
    ["member", { type: "user", id: "u", role: "editor" }],
    ["api key", { type: "apiKey", id: "k", scopes: ["workspace:read", "member:manage", "apikey:manage"] }],
    ["oauth agent", { type: "oauth", id: "u", clientId: "c", scopes: ["workspace:read", "member:manage"] }],
    ["system", { type: "system", id: "worker" }],
  ] as const)("refuses a %s for every operation", async (_label, actor) => {
    const { service, rows } = setup();
    const ctx = ctxOf(actor as Actor);
    await expect(service.list(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.create(ctx, FIELDS, key, ok)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.update(ctx, "stp_x", FIELDS, key, ok)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.activate(ctx, "env")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.revoke(ctx, "stp_x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.candidate(ctx, "stp_x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(rows.size).toBe(0);
  });

  it("serves the same platform-wide profiles to an operator from any workspace", async () => {
    const { service } = setup();
    await service.create(operator, FIELDS, key, ok);
    const fromOther = await service.list(ctxOf({ type: "user", id: "usr_op", role: "operator" }, "ws_other"));
    expect(fromOther.map((p) => p.id)).toEqual(["env", expect.stringMatching(/^stp_/)]);
  });
});

describe("storage profile service storage", () => {
  it("verifies before storing and never returns or audits the key pair", async () => {
    const { service, rows, events } = setup();
    let verified: unknown;
    const view = await service.create(operator, FIELDS, key, async (c) => {
      verified = c;
    });
    expect(verified).toMatchObject({ bucket: "studix-media", credentials: key });
    const row = rows.get(view.id)!;
    expect(row.accessKeyCiphertext).not.toContain(ACCESS);
    expect(row.secretCiphertext).not.toContain(SECRET);
    const text = JSON.stringify([view, await service.list(operator), events]);
    expect(text).not.toContain(ACCESS);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(row.secretCiphertext);
    expect(events.map((e) => e.action)).toContain("storage_profile.created");
    expect(view.secretHint).toBe("…WXYZ");
  });

  it("stores nothing when the probe fails, and the error carries no secret", async () => {
    const { service, rows, events, logs } = setup();
    const err = await service
      .create(operator, FIELDS, key, async () => {
        throw new StudixError("UNAVAILABLE", "Access denied by the bucket", { retryable: false });
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudixError);
    expect(rows.size).toBe(0);
    expect(events).toHaveLength(0);
    expect(JSON.stringify([String(err), logs])).not.toContain(SECRET);
  });

  it("rejects an endpoint the SSRF check refuses, before verifying", async () => {
    const { service, rows } = setup({
      checkEndpoint: async () => {
        throw new StudixError("VALIDATION", "private", { retryable: false, details: { field: "endpoint" } });
      },
    });
    let called = false;
    await expect(
      service.create(operator, FIELDS, key, async () => {
        called = true;
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(called).toBe(false);
    expect(rows.size).toBe(0);
  });

  it("rejects malformed fields and keys", async () => {
    const { service } = setup();
    await expect(
      service.create(operator, { ...FIELDS, bucket: "Bad_Bucket" }, key, ok),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(
      service.create(operator, FIELDS, { accessKeyId: "short", secretAccessKey: SECRET }, ok),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      service.create(operator, { ...FIELDS, keyPrefix: "a/../b/" }, key, ok),
    ).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("re-verifies an update with the stored pair when no key is given", async () => {
    const { service } = setup();
    const created = await service.create(operator, FIELDS, key, ok);
    let seen: unknown;
    const updated = await service.update(
      operator,
      created.id,
      { ...FIELDS, bucket: "other-bucket" },
      undefined,
      async (c) => {
        seen = c.credentials;
      },
    );
    expect(seen).toEqual(key);
    expect(updated.bucket).toBe("other-bucket");
  });

  it("keeps exactly one active profile and switches back to env", async () => {
    const { service } = setup();
    const a = await service.create(operator, FIELDS, key, ok);
    const b = await service.create(operator, { ...FIELDS, name: "Second" }, key, ok);
    await service.activate(operator, a.id);
    await service.activate(operator, b.id);
    let list = await service.list(operator);
    expect(list.filter((p) => p.active).map((p) => p.id)).toEqual([b.id]);
    expect((await service.snapshot()).activeId).toBe(b.id);
    await service.activate(operator, "env");
    list = await service.list(operator);
    expect(list.filter((p) => p.active).map((p) => p.id)).toEqual(["env"]);
  });

  it("refuses to delete env, the active profile or a referenced one", async () => {
    const { service, references, rows, events } = setup();
    const a = await service.create(operator, FIELDS, key, ok);
    await expect(service.revoke(operator, "env")).rejects.toMatchObject({ code: "VALIDATION" });
    await service.activate(operator, a.id);
    await expect(service.revoke(operator, a.id)).rejects.toMatchObject({ code: "CONFLICT" });
    await service.activate(operator, "env");
    references.set(a.id, 3);
    await expect(service.revoke(operator, a.id)).rejects.toMatchObject({ code: "CONFLICT" });
    references.set(a.id, 0);
    await service.revoke(operator, a.id);
    expect(rows.size).toBe(0);
    expect(events.map((e) => e.action)).toEqual([
      "storage_profile.created",
      "storage_profile.activated",
      "storage_profile.activated",
      "storage_profile.revoked",
    ]);
  });

  it("snapshot opens every profile for the routers", async () => {
    const { service } = setup();
    const a = await service.create(operator, FIELDS, key, ok);
    const snap = await service.snapshot();
    expect(snap.profiles.map((p) => p.id)).toEqual([a.id]);
    expect(snap.profiles[0]!.candidate.credentials).toEqual(key);
  });
});
