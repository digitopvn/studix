import { randomBytes } from "node:crypto";
import type { AuditEvent, TenantContext } from "@studix/core";
import type { PlatformCredentialRecord, PlatformCredentialRepository } from "@studix/database";
import { describe, expect, it } from "vitest";
import {
  createLiveCredentialEnv,
  createPlatformCredentialService,
  createSecretBox,
  platformCredentialAad,
} from "../src/index.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_op", role: "owner" },
};
const NAMES = { sume: "SUME_API_KEY", fish: "FISH_API_KEY" };
const KEY = "sk-sume-1234567890abcd";

function memoryRepo(): PlatformCredentialRepository & { rows: Map<string, PlatformCredentialRecord> } {
  const rows = new Map<string, PlatformCredentialRecord>();
  return {
    rows,
    async list() {
      return [...rows.values()];
    },
    async get(name) {
      return rows.get(name);
    },
    async save(name, value, by) {
      const row: PlatformCredentialRecord = {
        name,
        status: "active",
        secretCiphertext: value.secretCiphertext,
        secretHint: value.secretHint,
        version: (rows.get(name)?.version ?? 0) + 1,
        updatedBy: by,
        updatedAt: new Date(),
      };
      rows.set(name, row);
      return row;
    },
    async revoke(name, by) {
      const row: PlatformCredentialRecord = {
        name,
        status: "revoked",
        version: (rows.get(name)?.version ?? 0) + 1,
        updatedBy: by,
        updatedAt: new Date(),
        revokedAt: new Date(),
      };
      rows.set(name, row);
      return row;
    },
    async recordTest(name, result) {
      const row = rows.get(name);
      if (row) rows.set(name, { ...row, lastTest: result });
    },
  };
}

const auditSink = (events: unknown[] = []) => ({
  async append(_ctx: TenantContext, input: unknown) {
    events.push(input);
    return input as AuditEvent;
  },
  async list() {
    return { items: [] };
  },
});

function setup(processEnv: Record<string, string | undefined> = {}) {
  const credentials = memoryRepo();
  const events: unknown[] = [];
  const secrets = createSecretBox(randomBytes(32));
  const service = createPlatformCredentialService({
    credentials,
    secrets,
    env: processEnv,
    names: NAMES,
    audit: auditSink(events),
  });
  return { credentials, events, secrets, service };
}

describe("platform credential service", () => {
  it("seals the key, returns only a hint and keeps the plaintext out of the audit trail", async () => {
    const { credentials, events, service, secrets } = setup();
    const view = await service.save(ctx, "sume", { apiKey: KEY });
    expect(view).toMatchObject({
      id: "sume",
      envName: "SUME_API_KEY",
      status: "configured",
      source: "platform",
      keyHint: "…abcd",
      version: 1,
    });
    expect(JSON.stringify(view)).not.toContain(KEY);
    const stored = credentials.rows.get("SUME_API_KEY")?.secretCiphertext ?? "";
    expect(stored).not.toContain(KEY);
    expect(secrets.open(stored, platformCredentialAad("SUME_API_KEY"))).toBe(KEY);
    expect(JSON.stringify(events)).not.toContain(KEY);
    expect(events[0]).toMatchObject({ action: "platform_credential.saved", subjectId: "sume" });
    expect(JSON.stringify(await service.list())).not.toContain(KEY);
  });

  it("rotates (the version increases) and revokes without leaving a readable value", async () => {
    const { credentials, service } = setup();
    await service.save(ctx, "sume", { apiKey: KEY });
    const rotated = await service.save(ctx, "sume", { apiKey: "sk-sume-rotated-9999" });
    expect(rotated).toMatchObject({ version: 2, keyHint: "…9999" });
    const revoked = await service.revoke(ctx, "sume");
    expect(revoked).toMatchObject({ status: "revoked", source: "none" });
    expect(credentials.rows.get("SUME_API_KEY")?.secretCiphertext).toBeUndefined();
  });

  it("rejects values that could inject a second variable, and unknown credentials", async () => {
    const { service } = setup();
    const bad = ["short", "has space in it", "line\nbreak-key-123", "nul\u0000key-1234567", "x".repeat(513)];
    for (const apiKey of bad) {
      await expect(service.save(ctx, "sume", { apiKey })).rejects.toMatchObject({ code: "VALIDATION" });
    }
    await expect(service.save(ctx, "sume", { apiKey: KEY, extra: 1 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(service.save(ctx, "PATH", { apiKey: KEY })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.save(ctx, "__proto__", { apiKey: KEY })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses to store without a secrets key instead of falling back to plaintext", async () => {
    const service = createPlatformCredentialService({
      credentials: memoryRepo(),
      names: NAMES,
      audit: auditSink(),
    });
    await expect(service.save(ctx, "sume", { apiKey: KEY })).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("reports an environment value as configured, and a revoked name as off although env still has it", async () => {
    const { service } = setup({ SUME_API_KEY: KEY });
    expect(await service.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "sume", status: "configured", source: "env" }),
        expect.objectContaining({ id: "fish", status: "missing", source: "none" }),
      ]),
    );
    await service.revoke(ctx, "sume");
    expect((await service.list()).find((v) => v.id === "sume")).toMatchObject({ status: "revoked" });
  });

  it("marks a stored key invalid when it cannot be opened with the current secrets key", async () => {
    const { credentials, service } = setup();
    await service.save(ctx, "sume", { apiKey: KEY });
    const row = credentials.rows.get("SUME_API_KEY");
    if (row) credentials.rows.set("SUME_API_KEY", { ...row, secretCiphertext: "v1.deadbeef.AAAA" });
    expect((await service.list()).find((v) => v.id === "sume")).toMatchObject({ status: "invalid" });
  });
});

describe("live credential environment", () => {
  const base = { PATH: "/usr/bin", SUME_API_KEY: "env-sume-value", FISH_API_KEY: "env-fish-value" };
  const names = Object.values(NAMES);

  it("prefers the stored key, applies a rotation on refresh and hides a revoked name", async () => {
    const { credentials, secrets, service } = setup();
    const live = createLiveCredentialEnv({ credentials, secrets, base, names });
    await live.refresh();
    expect(live.env.SUME_API_KEY).toBe("env-sume-value");

    await service.save(ctx, "sume", { apiKey: KEY });
    expect(live.env.SUME_API_KEY).toBe("env-sume-value"); // not applied until the next reload
    await live.refresh();
    expect(live.env.SUME_API_KEY).toBe(KEY);
    expect(live.env.PATH).toBe("/usr/bin");

    await service.revoke(ctx, "sume");
    await live.refresh();
    expect(live.env.SUME_API_KEY).toBeUndefined();
    expect("SUME_API_KEY" in live.env).toBe(false);
    expect(live.env.FISH_API_KEY).toBe("env-fish-value");
  });

  it("ignores rows outside the allowlist and treats an unreadable row as missing, not as the env value", async () => {
    const { credentials, secrets, service } = setup();
    await service.save(ctx, "sume", { apiKey: KEY });
    const evil = secrets.seal("x-evil-value-1234", platformCredentialAad("EVIL_VAR"));
    await credentials.save("EVIL_VAR", { secretCiphertext: evil, secretHint: "" }, ctx.actor);
    await credentials.save(
      "FISH_API_KEY",
      { secretCiphertext: "v1.deadbeef.AAAA", secretHint: "" },
      ctx.actor,
    );
    const live = createLiveCredentialEnv({ credentials, secrets, base, names });
    await live.refresh();
    expect(live.env.EVIL_VAR).toBeUndefined();
    expect(live.env.SUME_API_KEY).toBe(KEY);
    expect(live.env.FISH_API_KEY).toBeUndefined();
  });

  it("keeps the previous snapshot when a reload fails", async () => {
    const { credentials, secrets, service } = setup();
    await service.save(ctx, "sume", { apiKey: KEY });
    let failing = false;
    const flaky = {
      ...credentials,
      list: async () => {
        if (failing) throw new Error("db down");
        return credentials.list();
      },
    };
    const live = createLiveCredentialEnv({ credentials: flaky, secrets, base, names });
    await live.refresh();
    failing = true;
    await expect(live.refresh()).rejects.toThrow("db down");
    expect(live.env.SUME_API_KEY).toBe(KEY);
  });

  it("hides managed names until the first load succeeds, so a revoked key is never briefly live", async () => {
    const { credentials, secrets } = setup();
    const broken = { ...credentials, list: async () => Promise.reject(new Error("db down")) };
    const live = createLiveCredentialEnv({ credentials: broken, secrets, base, names });
    await expect(live.refresh()).rejects.toThrow("db down");
    expect(live.env.SUME_API_KEY).toBeUndefined();
    expect("SUME_API_KEY" in live.env).toBe(false);
    expect(live.env.PATH).toBe("/usr/bin");
  });

  it("treats stored keys as missing, and says so, when this process has no secrets key", async () => {
    const { credentials, service } = setup();
    await service.save(ctx, "sume", { apiKey: KEY });
    const warnings: string[] = [];
    const logger = { warn: (m: string) => warnings.push(m), info() {}, error() {}, debug() {} };
    const live = createLiveCredentialEnv({ credentials, base, names, logger: logger as never });
    await live.refresh();
    expect(live.env.SUME_API_KEY).toBeUndefined();
    expect(warnings.join()).toContain("STUDIX_SECRETS_KEY");
  });

  it("cannot be written through", () => {
    const { credentials, secrets } = setup();
    const live = createLiveCredentialEnv({ credentials, secrets, base, names });
    expect(() => {
      (live.env as Record<string, string>).SUME_API_KEY = "x";
    }).toThrow();
  });
});
