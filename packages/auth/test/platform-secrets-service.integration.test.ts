import { randomBytes } from "node:crypto";
import type { TenantContext } from "@studix/core";
import { schema } from "@studix/database";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { StudixError } from "@studix/shared";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createPlatformCredentialService,
  type PlatformStoragePort,
  type StorageProbeOutcome,
} from "../src/platform-credential-service.ts";
import { createPlatformSecretSource } from "../src/platform-secret-source.ts";
import { createSecretBox } from "../src/secret-box.ts";

const db = withTestDatabase();

// The table is platform-wide, not per workspace, so each test starts from an empty one.
beforeEach(async () => {
  await db.current.db.delete(schema.platformSecrets);
});
const ACCESS = "AKIAEXAMPLEACCESS1234";
const SECRET = "s3cr3t-value-that-must-never-leak-9876";
const VENDOR_KEY = "vendor-key-abcdefghijkl-7777";
const ENV_KEY = "deployment-key-0000-1111";

async function actors(slug: string) {
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
    operator: as({ type: "user", id: ownerId, role: "operator" }),
    owner: as({ type: "user", id: ownerId, role: "owner" }),
    admin: as({ type: "user", id: ownerId, role: "admin" }),
    apiKey: as({ type: "apiKey", id: "key_1", scopes: ["workspace:read", "project:read"] }),
    system: as({ type: "system", id: "worker" }),
  };
}

function storagePort(outcome: StorageProbeOutcome = { ok: true, latencyMs: 3 }) {
  const probes: Array<{ accessKeyId: string } | undefined> = [];
  const port: PlatformStoragePort = {
    describe: () => ({ bucket: "b", region: "auto", forcePathStyle: true, signedUrlTtlSeconds: 60 }),
    async probe(candidate) {
      probes.push(candidate);
      return outcome;
    },
  };
  return { port, probes };
}

interface BuildOptions {
  box?: boolean;
  outcome?: StorageProbeOutcome;
  deployment?: Record<string, string>;
}

function build(opts: BuildOptions = {}) {
  const box = opts.box === false ? undefined : createSecretBox(randomBytes(32));
  const storage = storagePort(opts.outcome);
  const deployment = opts.deployment ?? {};
  const svc = createPlatformCredentialService({
    secrets: db.current.repos.platformSecrets,
    box,
    audit: db.current.repos.audit,
    env: deployment,
    storage: storage.port,
    vendorTester: async (_name, value) => ({
      verdict: value.startsWith("bad") ? "invalid" : "available",
      httpStatus: 200,
    }),
  });
  return { svc, box, storage, deployment };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  return promise.then(
    () => undefined,
    (e: unknown) => (e instanceof StudixError ? e.code : String(e)),
  );
}

const vendorOf = (view: { media: { vendors: Array<{ name: string }> } }, name: string) =>
  view.media.vendors.find((v) => v.name === name);

describe("platform credential service over Postgres", () => {
  it("is operator only: tenant roles, keys and system actors are refused", async () => {
    const { svc } = build();
    const t = await actors("ps-rbac");
    for (const ctx of [t.owner, t.admin, t.apiKey, t.system]) {
      expect(await codeOf(svc.overview(ctx))).toBe("FORBIDDEN");
      expect(await codeOf(svc.saveMediaKey(ctx, "SUME_API_KEY", { apiKey: VENDOR_KEY }))).toBe("FORBIDDEN");
    }
    expect((await svc.overview(t.operator)).secretStorage).toBe("available");
  });

  it("seals the key and never exposes it in views, rows or audit", async () => {
    const { svc } = build();
    const t = await actors("ps-seal");
    const view = await svc.saveMediaKey(t.operator, "SUME_API_KEY", { apiKey: VENDOR_KEY });
    expect(vendorOf(view, "SUME_API_KEY")).toMatchObject({
      source: "dashboard",
      status: "configured",
      version: 1,
      hint: "…7777",
    });
    const rows = await db.current.db.select().from(schema.platformSecrets);
    expect(JSON.stringify(rows)).not.toContain(VENDOR_KEY);
    expect(rows[0]?.secretCiphertext).toMatch(/^v1\./);
    const audit = await db.current.repos.audit.list(t.operator, { subjectId: "SUME_API_KEY" });
    expect(audit.items.map((e) => e.action)).toContain("platform_secret.created");
    expect(JSON.stringify(audit.items)).not.toContain(VENDOR_KEY);
    expect(JSON.stringify(view)).not.toContain(VENDOR_KEY);
  });

  it("bumps the version on rotation and falls back to the deployment value on revoke", async () => {
    const { svc } = build({ deployment: { SUME_API_KEY: ENV_KEY } });
    const t = await actors("ps-rotate");
    await svc.saveMediaKey(t.operator, "SUME_API_KEY", { apiKey: VENDOR_KEY });
    const rotated = await svc.saveMediaKey(t.operator, "SUME_API_KEY", { apiKey: `${VENDOR_KEY}-b` });
    expect(vendorOf(rotated, "SUME_API_KEY")).toMatchObject({ version: 2 });
    const revoked = await svc.revoke(t.operator, "SUME_API_KEY");
    expect(vendorOf(revoked, "SUME_API_KEY")).toMatchObject({
      source: "environment",
      environmentFallback: true,
    });
    expect(await codeOf(svc.revoke(t.operator, "SUME_API_KEY"))).toBe("NOT_FOUND");
  });

  it("accepts only allowlisted vendor names and well-formed keys", async () => {
    const { svc } = build();
    const t = await actors("ps-allow");
    for (const name of ["PATH", "S3_SECRET_ACCESS_KEY", "MULTIX_BIN"]) {
      expect(await codeOf(svc.saveMediaKey(t.operator, name, { apiKey: VENDOR_KEY }))).toBe("NOT_FOUND");
    }
    expect(await codeOf(svc.saveMediaKey(t.operator, "SUME_API_KEY", { apiKey: "has space in it" }))).toBe(
      "VALIDATION",
    );
  });

  it("cannot store anything without a master key", async () => {
    const { svc } = build({ box: false });
    const t = await actors("ps-nobox");
    expect((await svc.overview(t.operator)).secretStorage).toBe("unavailable");
    expect(await codeOf(svc.saveMediaKey(t.operator, "SUME_API_KEY", { apiKey: VENDOR_KEY }))).toBe(
      "UNAVAILABLE",
    );
  });

  it("probes the storage pair before saving and stores nothing when it fails", async () => {
    const t = await actors("ps-storage");
    const failing = build({
      outcome: { ok: false, latencyMs: 4, step: "put", status: 403, s3Code: "AccessDenied" },
    });
    const error = await failing.svc
      .saveStorageCredentials(t.operator, { accessKeyId: ACCESS, secretAccessKey: SECRET })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StudixError);
    expect(JSON.stringify(error)).not.toContain(SECRET);
    expect(String((error as Error).message)).not.toContain(SECRET);
    expect(failing.storage.probes[0]).toMatchObject({ accessKeyId: ACCESS });
    expect(await db.current.db.select().from(schema.platformSecrets)).toHaveLength(0);

    const ok = build();
    const saved = await ok.svc.saveStorageCredentials(t.operator, {
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
    });
    expect(saved.storage.credentials).toMatchObject({
      source: "dashboard",
      status: "configured",
      hint: "…1234",
    });
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(await db.current.db.select().from(schema.platformSecrets))).not.toContain(SECRET);
  });

  it("refuses to revoke storage credentials when the deployment has none", async () => {
    const { svc } = build();
    const t = await actors("ps-revoke-storage");
    const saved = await svc.saveStorageCredentials(t.operator, {
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
    });
    expect(await codeOf(svc.revoke(t.operator, saved.storage.credentials.name))).toBe("CONFLICT");
  });
});

describe("platform secret source over Postgres", () => {
  it("lays stored vendor keys over the deployment and follows rotation and revoke", async () => {
    const { svc, box } = build({ deployment: { SUME_API_KEY: ENV_KEY } });
    const t = await actors("pss-follow");
    const source = createPlatformSecretSource({
      secrets: db.current.repos.platformSecrets,
      box,
      base: { SUME_API_KEY: ENV_KEY, PATH: "/usr/bin" },
    });
    await source.refresh();
    expect(source.mediaEnv.SUME_API_KEY).toBe(ENV_KEY);
    await svc.saveMediaKey(t.operator, "SUME_API_KEY", { apiKey: VENDOR_KEY });
    await source.refresh();
    expect(source.mediaEnv.SUME_API_KEY).toBe(VENDOR_KEY);
    expect(source.mediaEnv.PATH).toBe("/usr/bin");
    await svc.revoke(t.operator, "SUME_API_KEY");
    await source.refresh();
    expect(source.mediaEnv.SUME_API_KEY).toBe(ENV_KEY);
  });

  it("serves the stored storage pair, else the deployment's, else fails clearly", async () => {
    const { svc, box } = build();
    const t = await actors("pss-storage");
    const secrets = db.current.repos.platformSecrets;
    const empty = createPlatformSecretSource({ secrets, box, base: {} });
    await empty.refresh();
    expect(await codeOf(empty.storageCredentials())).toBe("UNAVAILABLE");
    const fromDeployment = createPlatformSecretSource({
      secrets,
      box,
      base: { S3_ACCESS_KEY_ID: "envid", S3_SECRET_ACCESS_KEY: "envsecret" },
    });
    await fromDeployment.refresh();
    expect(await fromDeployment.storageCredentials()).toEqual({
      accessKeyId: "envid",
      secretAccessKey: "envsecret",
    });
    await svc.saveStorageCredentials(t.operator, { accessKeyId: ACCESS, secretAccessKey: SECRET });
    await fromDeployment.refresh();
    expect(await fromDeployment.storageCredentials()).toEqual({
      accessKeyId: ACCESS,
      secretAccessKey: SECRET,
    });
  });

  it("ignores a ciphertext moved to another name and keeps the deployment value", async () => {
    const { svc, box } = build();
    const t = await actors("pss-aad");
    await svc.saveMediaKey(t.operator, "SUME_API_KEY", { apiKey: VENDOR_KEY });
    await db.current.db
      .update(schema.platformSecrets)
      .set({ name: "FISH_API_KEY" })
      .where(eq(schema.platformSecrets.name, "SUME_API_KEY"));
    const source = createPlatformSecretSource({
      secrets: db.current.repos.platformSecrets,
      box,
      base: { FISH_API_KEY: "deployment-fish-0000" },
    });
    await source.refresh();
    expect(source.mediaEnv.FISH_API_KEY).toBe("deployment-fish-0000");
  });
});

describe("platform secret source refresh ordering", () => {
  it("a refresh asked for during a load still reads what was committed meanwhile", async () => {
    const { svc, box } = build();
    const t = await actors("pss-order");
    const source = createPlatformSecretSource({
      secrets: db.current.repos.platformSecrets,
      box,
      base: {},
    });
    const inFlight = source.refresh();
    await svc.saveMediaKey(t.operator, "SUME_API_KEY", { apiKey: VENDOR_KEY });
    await Promise.all([inFlight, source.refresh()]);
    expect(source.mediaEnv.SUME_API_KEY).toBe(VENDOR_KEY);
  });
});
