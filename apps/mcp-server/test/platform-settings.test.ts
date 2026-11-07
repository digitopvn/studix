import type { AddressInfo } from "node:net";
import {
  createPlatformCredentialService,
  createSecretBox,
  createStorageProfileService,
  parseSecretKey,
  STORAGE_KEY_NAMES,
  type VendorKeyTester,
} from "@studix/auth";
import type { Actor, AuditEvent, AuditRepository, TenantContext } from "@studix/core";
import type {
  PlatformCredentialRecord,
  PlatformCredentialRepository,
  StorageProfileRecord,
  StorageProfileRepository,
} from "@studix/database";
import { MULTIX_VENDOR_KEYS, type MultixDiagnosis } from "@studix/providers";
import { createLogger, StudixError } from "@studix/shared";
import type { StorageProbeResult } from "@studix/storage";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { platformRoutes, workspaceStorageRoutes } from "../src/api/platform-routes.ts";
import type { AppDeps } from "../src/app-deps.ts";
import { apiErrorHandler } from "../src/http/http-errors.ts";
import {
  createPlatformSettingsService,
  fetchWorkerMedia,
  storageDiagnosis,
  type WorkerMediaReport,
} from "../src/platform-settings.ts";

const MASTER = Buffer.alloc(32, 5).toString("base64");
const SECRET = "sk-live-0123456789abcdefWXYZ";
const S3_SECRET = "r2-secret-access-key-do-not-leak";
const S3_KEY_ID = "AKIA1234567890ABCDEF";

const ctxOf = (actor: Actor): TenantContext => ({ organizationId: "org_1", workspaceId: "ws_1", actor });
const operator = ctxOf({ type: "user", id: "usr_op", role: "operator" });
const owner = ctxOf({ type: "user", id: "usr_owner", role: "owner" });
const otherWorkspaceOperator: TenantContext = { ...operator, organizationId: "org_2", workspaceId: "ws_2" };

function memoryRepo(): PlatformCredentialRepository {
  const rows = new Map<string, PlatformCredentialRecord>();
  return {
    async list() {
      return [...rows.values()];
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
    async recordTest(name, result) {
      const row = rows.get(name);
      if (!row) return false;
      rows.set(name, { ...row, lastTest: result });
      return true;
    },
  };
}

function memoryProfiles(): StorageProfileRepository {
  const rows = new Map<string, StorageProfileRecord>();
  return {
    async list() {
      return [...rows.values()];
    },
    async get(id) {
      return rows.get(id);
    },
    async create(input, by) {
      const now = new Date();
      const row = { ...input, active: false, version: 1, updatedBy: by, createdAt: now, updatedAt: now };
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
    async listScope(workspaceId) {
      return [...rows.values()].filter((r) => r.workspaceId === workspaceId);
    },
    async activate(id, _by, workspaceId) {
      for (const [k, r] of rows) if (r.workspaceId === workspaceId) rows.set(k, { ...r, active: k === id });
    },
    async delete(id) {
      return Boolean(!rows.get(id)?.active && rows.delete(id));
    },
    async recordTest(id, result) {
      const row = rows.get(id);
      if (row) rows.set(id, { ...row, lastTest: result });
      return Boolean(row);
    },
    async countReferences() {
      return 0;
    },
    async locate() {
      return undefined;
    },
  };
}

interface SetupOptions {
  profileProbe?: StorageProbeResult;
  probe?: StorageProbeResult;
  diagnosis?: MultixDiagnosis;
  worker?: { media(): Promise<WorkerMediaReport | undefined> };
  bucket?: string | undefined;
  candidate?: StorageProbeResult;
  vendorTester?: VendorKeyTester;
  env?: Record<string, string>;
}

function setup(options: SetupOptions = {}) {
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
  const repo = memoryRepo();
  const box = createSecretBox(parseSecretKey(MASTER));
  const credentials = createPlatformCredentialService({
    credentials: repo,
    audit,
    secrets: box,
    allowedNames: Object.values(MULTIX_VENDOR_KEYS),
    env: {},
    cacheMs: 0,
  });
  const storageCredentials = createPlatformCredentialService({
    credentials: repo,
    audit,
    secrets: box,
    allowedNames: STORAGE_KEY_NAMES,
    env: {},
    cacheMs: 0,
  });
  const probed: Array<{ accessKeyId: string; secretAccessKey: string }> = [];
  const profiles = createStorageProfileService({
    profiles: memoryProfiles(),
    audit,
    secrets: box,
    checkEndpoint: async (endpoint) => {
      if (endpoint.includes("169.254")) {
        throw new StudixError("VALIDATION", "The endpoint must be a hostname, not an IP address", {
          retryable: false,
          details: { field: "endpoint", reason: "ip" },
        });
      }
      return { endpoint };
    },
    checkKeyPrefix: () => {},
    cacheMs: 0,
  });
  let changes = 0;
  const service = createPlatformSettingsService({
    config: {
      S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
      S3_BUCKET: "bucket" in options ? options.bucket : "studix",
      S3_REGION: "auto",
      S3_ACCESS_KEY_ID: S3_KEY_ID,
      S3_SECRET_ACCESS_KEY: S3_SECRET,
      S3_FORCE_PATH_STYLE: false,
      S3_SIGNED_URL_TTL_SECONDS: 900,
      MULTIX_BIN: "/usr/local/bin/multix",
      MULTIX_ALLOW_HOME_ENV: false,
    },
    storage: { probeWrite: async () => options.probe ?? { ok: true } },
    multix: {
      diagnose: async () =>
        options.diagnosis ?? {
          state: "ready",
          vendors: {
            sume: true,
            atlas: false,
            elevenlabs: false,
            fish: false,
            minimax: false,
            openrouter: false,
          },
        },
    },
    credentials,
    storageCredentials,
    probeCandidate: async (pair) => {
      probed.push(pair);
      return options.candidate ?? { ok: true };
    },
    ...(options.vendorTester ? { vendorTester: options.vendorTester } : {}),
    profiles,
    probeProfile: async (candidate) => {
      probed.push(candidate.credentials);
      return options.profileProbe ?? { ok: true };
    },
    profilesChanged: async () => {
      changes += 1;
    },
    env: options.env ?? {},
    ...(options.worker ? { worker: options.worker } : {}),
  });
  return { service, events, credentials, storageCredentials, probed, changes: () => changes };
}

describe("storageDiagnosis", () => {
  it.each([
    [{ ok: true }, "ok"],
    [{ ok: false, step: "put", status: 403, s3Code: "InvalidAccessKeyId" }, "bad_credential"],
    [{ ok: false, step: "put", status: 403, s3Code: "SignatureDoesNotMatch" }, "bad_credential"],
    [{ ok: false, step: "put", status: 401 }, "bad_credential"],
    [{ ok: false, step: "put", status: 403, s3Code: "AccessDenied" }, "missing_permission"],
    [{ ok: false, step: "put", status: 404, s3Code: "NoSuchBucket" }, "missing_bucket"],
    [{ ok: false, step: "put", status: 503 }, "remote_unavailable"],
    [{ ok: false, step: "put" }, "remote_unavailable"],
  ] as const)("maps %j to %s", (probe, expected) => {
    expect(storageDiagnosis(probe as StorageProbeResult)).toBe(expected);
  });
});

describe("platform settings service", () => {
  it("refuses everyone but a platform operator", async () => {
    const { service } = setup();
    for (const ctx of [owner, ctxOf({ type: "system", id: "worker" })]) {
      await expect(service.overview(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.testStorage(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.testMedia(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.setMediaKey(ctx, "SUME_API_KEY", SECRET)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(service.revokeMediaKey(ctx, "SUME_API_KEY")).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("shows redacted storage status and never the secret key", async () => {
    const { service } = setup();
    const view = await service.overview(operator);
    expect(view.storage).toMatchObject({
      configured: true,
      endpointHost: "acct.r2.cloudflarestorage.com",
      bucket: "studix",
      accessKeyId: "AKIA…CDEF",
      secretAccessKey: "unverified",
      changeNeedsRedeploy: true,
    });
    const text = JSON.stringify(view);
    expect(text).not.toContain(S3_SECRET);
    expect(text).not.toContain(S3_KEY_ID);
  });

  it("runs the storage test and reports the diagnosis with an action", async () => {
    const ok = setup();
    expect(await ok.service.testStorage(operator)).toMatchObject({ ok: true, diagnosis: "ok" });
    expect((await ok.service.overview(operator)).storage.secretAccessKey).toBe("configured");

    const bad = setup({
      probe: { ok: false, step: "put", status: 403, s3Code: "InvalidAccessKeyId", message: "bad key" },
    });
    const result = await bad.service.testStorage(operator);
    expect(result).toMatchObject({
      ok: false,
      diagnosis: "bad_credential",
      failedStep: "put",
      httpStatus: 403,
    });
    expect(result.suggestedAction).toContain("S3_SECRET_ACCESS_KEY");
    expect((await bad.service.overview(operator)).storage.secretAccessKey).toBe("invalid");

    const noBucket = setup({ bucket: undefined });
    expect(await noBucket.service.testStorage(operator)).toMatchObject({
      ok: false,
      diagnosis: "missing_credential",
    });
  });

  it("stores, rotates and revokes a media key without ever returning it", async () => {
    const { service, events } = setup();
    const set = await service.setMediaKey(operator, "SUME_API_KEY", SECRET);
    expect(set).toMatchObject({ source: "dashboard", keyHint: "…WXYZ", version: 1 });
    const view = await service.overview(operator);
    const sume = view.media.vendors.find((v) => v.keyName === "SUME_API_KEY");
    expect(sume?.credential.source).toBe("dashboard");
    expect(sume?.kinds.length).toBeGreaterThan(0);
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(JSON.stringify(events)).not.toContain(SECRET);
    await service.revokeMediaKey(operator, "SUME_API_KEY");
    const after = await service.overview(operator);
    expect(after.media.vendors.find((v) => v.keyName === "SUME_API_KEY")?.credential.source).toBe("missing");
  });

  it("stores a storage key pair only after it passes the probe, and never returns it", async () => {
    const newSecret = "r2-rotated-secret-0123456789";
    const failing = setup({ candidate: { ok: false, step: "put", status: 403, s3Code: "AccessDenied" } });
    await expect(
      failing.service.setStorageKey(operator, {
        accessKeyId: "NEWKEYID12345678",
        secretAccessKey: newSecret,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { diagnosis: "missing_permission" } });
    expect((await failing.storageCredentials.loadValues()).values).toEqual({});
    expect((await failing.service.overview(operator)).storage.source).toBe("environment");

    const { service, events, probed, storageCredentials } = setup();
    await service.setStorageKey(operator, { accessKeyId: " NEWKEYID12345678 ", secretAccessKey: newSecret });
    expect(probed).toEqual([{ accessKeyId: "NEWKEYID12345678", secretAccessKey: newSecret }]);
    const view = await service.overview(operator);
    expect(view.storage).toMatchObject({
      source: "dashboard",
      credentialStorage: "available",
      accessKeyId: "NEWK…5678",
      secretAccessKey: "configured",
      changeNeedsRedeploy: false,
      credential: { keyHint: "…6789", version: 1 },
    });
    expect(JSON.stringify(view)).not.toContain(newSecret);
    expect(JSON.stringify(events)).not.toContain(newSecret);
    // The stored pair stays out of the values handed to Multix.
    expect(Object.keys((await storageCredentials.loadValues()).values).sort()).toEqual([
      ...STORAGE_KEY_NAMES,
    ]);
    await service.revokeStorageKey(operator);
    expect((await service.overview(operator)).storage).toMatchObject({
      source: "environment",
      changeNeedsRedeploy: true,
    });
    await expect(service.revokeStorageKey(operator)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.setStorageKey(owner, { accessKeyId: "NEWKEYID12345678", secretAccessKey: newSecret }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("tests the media key in use with the vendor and records the outcome on a stored key", async () => {
    const seen: string[] = [];
    const { service } = setup({
      env: { OPENROUTER_API_KEY: "sk-or-env-0123456789" },
      vendorTester: async (name, value) => {
        seen.push(`${name}=${value}`);
        return name === "OPENROUTER_API_KEY" ? { verdict: "invalid", httpStatus: 401 } : undefined;
      },
    });
    await expect(service.testMediaKey(operator, "OPENROUTER_API_KEY")).resolves.toMatchObject({
      verdict: "invalid",
      httpStatus: 401,
    });
    await service.setMediaKey(operator, "SUME_API_KEY", SECRET);
    const sume = await service.testMediaKey(operator, "SUME_API_KEY");
    expect(sume.verdict).toBe("unverified");
    expect(seen).toEqual(["OPENROUTER_API_KEY=sk-or-env-0123456789", `SUME_API_KEY=${SECRET}`]);
    const view = await service.overview(operator);
    expect(view.media.vendors.find((v) => v.keyName === "SUME_API_KEY")?.credential.lastTest?.ok).toBe(false);
    await expect(service.testMediaKey(operator, "FISH_API_KEY")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.testMediaKey(operator, "S3_SECRET_ACCESS_KEY")).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("refuses a name outside the vendor allowlist", async () => {
    const { service } = setup();
    await expect(service.setMediaKey(operator, "S3_SECRET_ACCESS_KEY", SECRET)).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("keeps the platform view identical across workspaces: the keys are platform-wide", async () => {
    const { service } = setup();
    await service.setMediaKey(operator, "SUME_API_KEY", SECRET);
    const other = await service.overview(otherWorkspaceOperator);
    expect(other.media.vendors.find((v) => v.keyName === "SUME_API_KEY")?.credential.source).toBe(
      "dashboard",
    );
  });

  it("runs the safe media check and says it made no paid call", async () => {
    const { service } = setup();
    const result = await service.testMedia(operator);
    expect(result).toMatchObject({ ok: true, diagnosis: "ok", paidCalls: false });
    expect(result.vendors.find((v) => v.vendor === "sume")?.hasKey).toBe(true);
    const view = await service.overview(operator);
    expect(view.media.vendors.find((v) => v.vendor === "sume")?.status).toBe("configured");
    expect(view.media.vendors.find((v) => v.vendor === "fish")?.status).toBe("missing");
  });

  it("redacts the check reason in the overview as well as in the test answer", async () => {
    const none = {
      sume: false,
      atlas: false,
      elevenlabs: false,
      fish: false,
      minimax: false,
      openrouter: false,
    };
    const leaked = "request failed, api_key=sk-proj-abcdef0123456789abcdef";
    const { service } = setup({ diagnosis: { state: "check_failed", vendors: none, reason: leaked } });
    const answer = await service.testMedia(operator);
    expect(JSON.stringify(answer)).not.toContain("sk-proj-abcdef0123456789abcdef");
    const view = await service.overview(operator);
    expect(JSON.stringify(view.media.lastCheck)).not.toContain("sk-proj-abcdef0123456789abcdef");
  });

  it("records the check outcome on a stored key and audits it", async () => {
    const { service, events } = setup();
    await service.setMediaKey(operator, "SUME_API_KEY", SECRET);
    await service.testMedia(operator);
    const view = await service.overview(operator);
    expect(view.media.vendors.find((v) => v.keyName === "SUME_API_KEY")?.credential.lastTest).toMatchObject({
      ok: true,
    });
    expect(events.map((e) => e.action)).toContain("platform_credential.tested");
  });

  it("distinguishes a missing executable, a failed check and no keys", async () => {
    const none = {
      sume: false,
      atlas: false,
      elevenlabs: false,
      fish: false,
      minimax: false,
      openrouter: false,
    };
    const missing = setup({
      diagnosis: {
        state: "missing_executable",
        vendors: none,
        reason: "could not be started",
        code: "ENOENT",
      },
    });
    expect(await missing.service.testMedia(operator)).toMatchObject({
      ok: false,
      diagnosis: "missing_executable",
      code: "ENOENT",
    });
    const failed = setup({ diagnosis: { state: "check_failed", vendors: none, reason: "exit 3" } });
    expect(await failed.service.testMedia(operator)).toMatchObject({ ok: false, diagnosis: "check_failed" });
    const empty = setup({ diagnosis: { state: "ready", vendors: none } });
    expect(await empty.service.testMedia(operator)).toMatchObject({
      ok: false,
      diagnosis: "missing_credential",
    });
  });
});

describe("platform routes", () => {
  const servers: Array<{ close: () => void }> = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.close();
  });

  /** A real HTTP round trip with a stand-in session: the `x-actor` header picks who is signed in. */
  async function start() {
    const { service, events } = setup();
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => {
      const who = req.header("x-actor");
      if (who)
        res.locals.session = {
          ctx:
            who === "operator"
              ? operator
              : who === "editor"
                ? ctxOf({ type: "user", id: "usr_ed", role: "editor" })
                : owner,
        };
      next();
    });
    const api = express.Router();
    api.use("/platform", platformRoutes({ platform: service } as unknown as AppDeps));
    api.use("/workspace-storage", workspaceStorageRoutes({ platform: service } as unknown as AppDeps));
    api.use(apiErrorHandler(createLogger({}, { level: "error" })));
    app.use("/api", api);
    const server = app.listen(0);
    servers.push(server);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/platform`;
    return { base, events };
  }

  const call = (base: string, path: string, method: string, actor?: string, body?: unknown) =>
    fetch(`${base}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(actor ? { "x-actor": actor } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  it("answers 401 without a session and 403 to a non-operator on every route", async () => {
    const { base } = await start();
    const routes: Array<[string, string, unknown?]> = [
      ["/storage-media", "GET"],
      ["/storage/test", "POST", {}],
      ["/media/test", "POST", {}],
      ["/media-keys/SUME_API_KEY", "PUT", { value: SECRET }],
      ["/media-keys/SUME_API_KEY", "DELETE"],
      ["/storage/profiles", "GET"],
      ["/storage/profiles", "POST", {}],
      ["/storage/profiles/stp_abcdef12", "PUT", {}],
      ["/storage/profiles/env/activate", "POST", {}],
      ["/storage/profiles/env/test", "POST", {}],
      ["/storage/profiles/stp_abcdef12", "DELETE"],
    ];
    for (const [path, method, body] of routes) {
      expect((await call(base, path, method, undefined, body)).status).toBe(401);
      expect((await call(base, path, method, "owner", body)).status).toBe(403);
    }
  });

  it("serves workspace storage to owners and admins only, before reading the body", async () => {
    const { base } = await start();
    const ws = base.replace(/\/platform$/, "/workspace-storage");
    const routes: Array<[string, string, unknown?]> = [
      ["/storage/profiles", "GET"],
      ["/storage/profiles", "POST", {}],
      ["/storage/profiles/stp_abcdef12", "PUT", {}],
      ["/storage/profiles/env/activate", "POST", {}],
      ["/storage/profiles/stp_abcdef12/test", "POST", {}],
      ["/storage/profiles/stp_abcdef12", "DELETE"],
    ];
    for (const [path, method, body] of routes) {
      expect((await call(ws, path, method, undefined, body)).status).toBe(401);
      expect((await call(ws, path, method, "editor", body)).status).toBe(403);
    }
    const listed = await call(ws, "/storage/profiles", "GET", "owner");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toBe("no-store");
    expect(((await listed.json()) as Array<{ id: string; providerType: string }>)[0]).toMatchObject({
      id: "env",
      providerType: "platform",
    });
  });

  it("serves an operator with no-store responses that never carry a key value", async () => {
    const { base, events } = await start();
    const put = await call(base, "/media-keys/SUME_API_KEY", "PUT", "operator", { value: SECRET });
    expect(put.status).toBe(200);
    expect(put.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(await put.json())).not.toContain(SECRET);

    const overview = await call(base, "/storage-media", "GET", "operator");
    expect(overview.status).toBe(200);
    expect(overview.headers.get("cache-control")).toBe("no-store");
    const text = await overview.text();
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(S3_SECRET);

    const del = await call(base, "/media-keys/SUME_API_KEY", "DELETE", "operator");
    expect(del.status).toBe(200);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it("rejects malformed input before it reaches the service", async () => {
    const { base } = await start();
    expect((await call(base, "/media-keys/sume_api_key", "PUT", "operator", { value: SECRET })).status).toBe(
      400,
    );
    expect((await call(base, "/media-keys/SUME_API_KEY", "PUT", "operator", { value: "" })).status).toBe(400);
    expect(
      (await call(base, "/media-keys/SUME_API_KEY", "PUT", "operator", { value: SECRET, extra: 1 })).status,
    ).toBe(400);
    const outsideAllowlist = await call(base, "/media-keys/PATH_OVERRIDE", "PUT", "operator", {
      value: SECRET,
    });
    expect(outsideAllowlist.status).toBe(400);
    expect(JSON.stringify(await outsideAllowlist.json())).not.toContain(SECRET);
  });
});

describe("worker media report", () => {
  const workerReport = (over: Partial<WorkerMediaReport> = {}): WorkerMediaReport => ({
    executable: "configured",
    state: "ready",
    secretsKey: true,
    vendors: { sume: false, atlas: false, elevenlabs: false, fish: false, minimax: false, openrouter: false },
    ...over,
  });

  it("lists where the worker disagrees with the app after a check", async () => {
    const { service } = setup({
      worker: { media: async () => workerReport({ secretsKey: false, executable: "missing" }) },
    });
    await service.testMedia(operator);
    const { worker } = (await service.overview(operator)).media;
    expect(worker?.reachable).toBe(true);
    expect(worker?.mismatches).toEqual([
      "MULTIX_BIN is set on the app but not on the worker.",
      "STUDIX_SECRETS_KEY is missing on the worker, so it ignores keys set here.",
      `${MULTIX_VENDOR_KEYS.sume} is found on the app but not on the worker.`,
    ]);
  });

  it("reports no mismatch when they agree, and an unreachable worker as such", async () => {
    const agree = setup({ worker: { media: async () => workerReport({ vendors: { sume: true } }) } });
    await agree.service.testMedia(operator);
    expect((await agree.service.overview(operator)).media.worker?.mismatches).toEqual([]);

    const down = setup({ worker: { media: () => Promise.reject(new Error("ECONNREFUSED")) } });
    expect((await down.service.overview(operator)).media.worker).toEqual({
      reachable: false,
      mismatches: [],
    });
    expect((await setup().service.overview(operator)).media.worker).toBeUndefined();
  });

  it("keeps only known presence fields from the worker's /readyz", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({
          status: "ok",
          media: {
            executable: "configured",
            state: "ready",
            secretsKey: true,
            path: "/secret/path",
            vendors: { sume: true, unknown: true, atlas: "yes" },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    expect(await fetchWorkerMedia("http://worker:8081", fake)).toEqual({
      executable: "configured",
      state: "ready",
      secretsKey: true,
      vendors: { sume: true },
    });
    const noMedia = (async () =>
      new Response(JSON.stringify({ status: "unavailable" }), { status: 503 })) as unknown as typeof fetch;
    expect(await fetchWorkerMedia("http://worker:8081", noMedia)).toBeUndefined();
  });
});

describe("storage profiles", () => {
  const fields = {
    name: "Media R2",
    providerType: "cloudflare-r2" as const,
    endpoint: "https://acct.r2.cloudflarestorage.com",
    bucket: "studix-media",
    region: "auto",
  };
  const key = { accessKeyId: S3_KEY_ID, secretAccessKey: S3_SECRET };

  it("refuses everyone but a platform operator", async () => {
    const { service } = setup();
    for (const ctx of [owner, ctxOf({ type: "system", id: "worker" })]) {
      await expect(service.listStorageProfiles(ctx)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.createStorageProfile(ctx, fields, key)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(service.activateStorageProfile(ctx, "env")).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.testStorageProfile(ctx, "env")).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(service.deleteStorageProfile(ctx, "stp_x")).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("probes before saving and stores nothing when the key is invalid", async () => {
    const { service, probed, changes } = setup({
      profileProbe: { ok: false, step: "put", status: 403, s3Code: "InvalidAccessKeyId", message: "bad key" },
    });
    const err = await service.createStorageProfile(operator, fields, key).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudixError);
    expect(JSON.stringify({ message: String(err), details: (err as StudixError).details })).not.toContain(
      S3_SECRET,
    );
    expect(probed).toHaveLength(1);
    expect(changes()).toBe(0);
    expect((await service.listStorageProfiles(operator)).map((p) => p.id)).toEqual(["env"]);
  });

  it("refuses a metadata endpoint without probing it", async () => {
    const { service, probed } = setup();
    await expect(
      service.createStorageProfile(
        operator,
        { ...fields, providerType: "s3-compatible", endpoint: "https://169.254.169.254" },
        key,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", details: { field: "endpoint" } });
    expect(probed).toHaveLength(0);
  });

  it("creates, activates from another workspace, tests and deletes without leaking the key", async () => {
    const { service, events, changes } = setup();
    const created = await service.createStorageProfile(operator, fields, key);
    await service.activateStorageProfile(otherWorkspaceOperator, created.id);
    expect(changes()).toBe(2);
    const list = await service.listStorageProfiles(operator);
    expect(list.find((p) => p.active)?.id).toBe(created.id);
    expect(await service.testStorageProfile(operator, created.id)).toMatchObject({ ok: true });
    await expect(service.deleteStorageProfile(operator, created.id)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await service.activateStorageProfile(operator, "env");
    await service.deleteStorageProfile(operator, created.id);
    const text = JSON.stringify([created, list, events]);
    expect(text).not.toContain(S3_SECRET);
    expect(text).not.toContain(S3_KEY_ID);
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        "storage_profile.created",
        "storage_profile.activated",
        "storage_profile.tested",
        "storage_profile.revoked",
      ]),
    );
  });
});
