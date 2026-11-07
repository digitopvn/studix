import type { Actor, AuditEvent, AuditRepository, TenantContext } from "@studix/core";
import type {
  PlatformCredentialRecord,
  PlatformCredentialRepository,
  PlatformTestRecord,
} from "@studix/database";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createPlatformCredentialService } from "../src/platform-credential-service.ts";
import { createSecretBox, parseSecretKey } from "../src/secret-box.ts";

const MASTER = Buffer.alloc(32, 7).toString("base64");
const OTHER_MASTER = Buffer.alloc(32, 9).toString("base64");
const NAMES = ["SUME_API_KEY", "ELEVENLABS_API_KEY"] as const;
const KEY = "sk-live-0123456789abcdefWXYZ";

function ctxOf(actor: Actor): TenantContext {
  return { organizationId: "org_1", workspaceId: "ws_1", actor };
}
const operator = ctxOf({ type: "user", id: "usr_op", role: "operator" });

function memoryRepo(): PlatformCredentialRepository & { rows: Map<string, PlatformCredentialRecord> } {
  const rows = new Map<string, PlatformCredentialRecord>();
  return {
    rows,
    async list() {
      return [...rows.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
    async upsert(input, by) {
      const prev = rows.get(input.name);
      const now = new Date();
      const row: PlatformCredentialRecord = {
        ...input,
        version: (prev?.version ?? 0) + 1,
        updatedBy: by,
        createdAt: prev?.createdAt ?? now,
        updatedAt: now,
      };
      rows.set(input.name, row);
      return row;
    },
    async delete(name) {
      return rows.delete(name);
    },
    async recordTest(name, result: PlatformTestRecord) {
      const row = rows.get(name);
      if (!row) return false;
      rows.set(name, { ...row, lastTest: result });
      return true;
    },
  };
}

function setup(options: { master?: string | null; env?: Record<string, string> } = {}) {
  const repo = memoryRepo();
  const events: AuditEvent[] = [];
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
  const master = options.master === undefined ? MASTER : options.master;
  const service = createPlatformCredentialService({
    credentials: repo,
    audit,
    ...(master ? { secrets: createSecretBox(parseSecretKey(master)) } : {}),
    allowedNames: NAMES,
    env: options.env ?? {},
    cacheMs: 0,
  });
  return { repo, events, service };
}

describe("platform credential service permissions", () => {
  it.each([
    ["owner", { type: "user", id: "u", role: "owner" }],
    ["admin", { type: "user", id: "u", role: "admin" }],
    ["editor", { type: "user", id: "u", role: "editor" }],
    ["api key", { type: "apiKey", id: "k", scopes: ["workspace:read", "member:manage", "apikey:manage"] }],
    ["oauth agent", { type: "oauth", id: "u", clientId: "c", scopes: ["workspace:read", "member:manage"] }],
    ["system", { type: "system", id: "worker" }],
  ] as const)("refuses a %s for every operation", async (_label, actor) => {
    const { service, repo } = setup();
    const ctx = ctxOf(actor as Actor);
    await expect(service.overview(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.set(ctx, "SUME_API_KEY", KEY)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.revoke(ctx, "SUME_API_KEY")).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.recordTest(ctx, "SUME_API_KEY", { ok: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(repo.rows.size).toBe(0);
  });
});

describe("platform credential service storage", () => {
  it("seals the key, shows only a hint and never returns the value", async () => {
    const { service, repo, events } = setup();
    const view = await service.set(operator, "SUME_API_KEY", `  ${KEY}  `);
    expect(view).toMatchObject({ name: "SUME_API_KEY", source: "dashboard", keyHint: "…WXYZ", version: 1 });
    const stored = repo.rows.get("SUME_API_KEY")!;
    expect(stored.secretCiphertext).not.toContain(KEY);
    expect(stored.secretCiphertext.startsWith("v1.")).toBe(true);
    const overview = await service.overview(operator);
    expect(overview.storage).toBe("available");
    expect(JSON.stringify(overview)).not.toContain(KEY);
    expect(JSON.stringify(view)).not.toContain(KEY);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(events.map((e) => e.action)).toEqual(["platform_credential.created"]);
  });

  it("rotates in place, bumps the version and clears the previous test", async () => {
    const { service, events } = setup();
    await service.set(operator, "SUME_API_KEY", KEY);
    await service.recordTest(operator, "SUME_API_KEY", { ok: true, detail: "found" });
    const rotated = await service.set(operator, "SUME_API_KEY", "sk-live-rotated-000000009999");
    expect(rotated).toMatchObject({ version: 2, keyHint: "…9999" });
    expect(rotated.lastTest).toBeUndefined();
    expect(events.map((e) => e.action)).toEqual([
      "platform_credential.created",
      "platform_credential.tested",
      "platform_credential.rotated",
    ]);
    expect((await service.loadValues()).values.SUME_API_KEY).toBe("sk-live-rotated-000000009999");
  });

  it("reports the environment as the source until a key is stored, and again after revoke", async () => {
    const { service, events } = setup({ env: { ELEVENLABS_API_KEY: "from-env-1234567890" } });
    const before = (await service.overview(operator)).credentials;
    expect(before.find((c) => c.name === "ELEVENLABS_API_KEY")?.source).toBe("environment");
    expect(before.find((c) => c.name === "SUME_API_KEY")?.source).toBe("missing");
    await service.set(operator, "ELEVENLABS_API_KEY", KEY);
    expect((await service.revoke(operator, "ELEVENLABS_API_KEY")).source).toBe("environment");
    expect((await service.loadValues()).values).toEqual({});
    expect(events.map((e) => e.action)).toEqual([
      "platform_credential.created",
      "platform_credential.revoked",
    ]);
    await expect(service.revoke(operator, "ELEVENLABS_API_KEY")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses names outside the allowlist and malformed values without storing anything", async () => {
    const { service, repo } = setup();
    for (const name of ["PATH", "LD_PRELOAD", "NODE_OPTIONS", "S3_SECRET_ACCESS_KEY", "sume_api_key"]) {
      await expect(service.set(operator, name, KEY)).rejects.toMatchObject({ code: "VALIDATION" });
      await expect(service.revoke(operator, name)).rejects.toMatchObject({ code: "VALIDATION" });
    }
    for (const value of ["short", "has space inside-key", "line\nbreak-key-12345", "x".repeat(513), ""]) {
      const err = await service.set(operator, "SUME_API_KEY", value).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StudixError);
      expect(err).toMatchObject({ code: "VALIDATION" });
      expect(JSON.stringify(err)).not.toContain("has space");
    }
    expect(repo.rows.size).toBe(0);
  });

  it("shows no hint for a short key", async () => {
    const { service } = setup();
    expect((await service.set(operator, "SUME_API_KEY", "short-key-12")).keyHint).toBe("…");
  });

  it("changes the revision when a key is revoked and stored again", async () => {
    const { service } = setup();
    await service.set(operator, "SUME_API_KEY", KEY);
    const first = await service.loadValues();
    await service.revoke(operator, "SUME_API_KEY");
    await new Promise((r) => setTimeout(r, 5));
    await service.set(operator, "SUME_API_KEY", KEY);
    expect((await service.loadValues()).revision).not.toBe(first.revision);
  });

  it("answers UNAVAILABLE without a master key and never stores plaintext", async () => {
    const { service, repo } = setup({ master: null });
    await expect(service.set(operator, "SUME_API_KEY", KEY)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect((await service.overview(operator)).storage).toBe("unavailable");
    expect(repo.rows.size).toBe(0);
    expect(await service.loadValues()).toEqual({ values: {}, revision: "none" });
  });
});

describe("platform credential service values for the vendor calls", () => {
  it("returns plaintext only through loadValues and changes the revision on every change", async () => {
    const { service } = setup();
    const empty = await service.loadValues();
    await service.set(operator, "SUME_API_KEY", KEY);
    const one = await service.loadValues();
    expect(one.values).toEqual({ SUME_API_KEY: KEY });
    expect(one.revision).not.toBe(empty.revision);
    await service.set(operator, "SUME_API_KEY", "sk-live-rotated-000000009999");
    const two = await service.loadValues();
    expect(two.revision).not.toBe(one.revision);
    await service.revoke(operator, "SUME_API_KEY");
    expect((await service.loadValues()).values).toEqual({});
  });

  it("skips a row sealed for another name or opened with another master key", async () => {
    const { service, repo } = setup();
    await service.set(operator, "SUME_API_KEY", KEY);
    // A ciphertext copied under another name fails to open: the name is bound into the seal.
    const stolen = repo.rows.get("SUME_API_KEY")!;
    repo.rows.set("ELEVENLABS_API_KEY", { ...stolen, name: "ELEVENLABS_API_KEY" });
    expect((await service.loadValues()).values).toEqual({ SUME_API_KEY: KEY });

    const rotatedMaster = createPlatformCredentialService({
      credentials: repo,
      audit: { append: async () => ({}) as AuditEvent, list: async () => ({ items: [] }) },
      secrets: createSecretBox(parseSecretKey(OTHER_MASTER)),
      allowedNames: NAMES,
      cacheMs: 0,
    });
    expect((await rotatedMaster.loadValues()).values).toEqual({});
  });

  it("opens existing rows after the master key is rotated with the old key kept", async () => {
    const { service, repo } = setup();
    await service.set(operator, "SUME_API_KEY", KEY);
    const rotated = createPlatformCredentialService({
      credentials: repo,
      audit: { append: async () => ({}) as AuditEvent, list: async () => ({ items: [] }) },
      secrets: createSecretBox(parseSecretKey(OTHER_MASTER), [parseSecretKey(MASTER)]),
      allowedNames: NAMES,
      cacheMs: 0,
    });
    expect((await rotated.loadValues()).values).toEqual({ SUME_API_KEY: KEY });
  });

  it("ignores stored rows whose name left the allowlist", async () => {
    const { service, repo } = setup();
    await service.set(operator, "SUME_API_KEY", KEY);
    const row = repo.rows.get("SUME_API_KEY")!;
    repo.rows.set("NODE_OPTIONS", { ...row, name: "NODE_OPTIONS" });
    expect(Object.keys((await service.loadValues()).values)).toEqual(["SUME_API_KEY"]);
  });

  it("keeps serving the last values when the database read fails", async () => {
    const { service, repo } = setup();
    await service.set(operator, "SUME_API_KEY", KEY);
    const first = await service.loadValues();
    repo.list = async () => {
      throw new Error("connection refused");
    };
    expect(await service.loadValues()).toEqual(first);
  });
});
