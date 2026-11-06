import type { AddressInfo } from "node:net";
import { createPlatformCredentialService, createSecretBox, parseSecretKey } from "@studix/auth";
import type { Actor, AuditEvent, AuditRepository, TenantContext } from "@studix/core";
import type { PlatformCredentialRecord, PlatformCredentialRepository } from "@studix/database";
import { MULTIX_VENDOR_KEYS, type MultixDiagnosis } from "@studix/providers";
import { createLogger } from "@studix/shared";
import type { StorageProbeResult } from "@studix/storage";
import express from "express";
import { afterEach, describe, expect, it } from "vitest";
import { platformRoutes } from "../src/api/platform-routes.ts";
import type { AppDeps } from "../src/app-deps.ts";
import { apiErrorHandler } from "../src/http/http-errors.ts";
import { createPlatformSettingsService, storageDiagnosis } from "../src/platform-settings.ts";

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

interface SetupOptions {
  probe?: StorageProbeResult;
  diagnosis?: MultixDiagnosis;
  bucket?: string | undefined;
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
  const credentials = createPlatformCredentialService({
    credentials: memoryRepo(),
    audit,
    secrets: createSecretBox(parseSecretKey(MASTER)),
    allowedNames: Object.values(MULTIX_VENDOR_KEYS),
    env: {},
    cacheMs: 0,
  });
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
  });
  return { service, events, credentials };
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
      if (who) res.locals.session = { ctx: who === "operator" ? operator : owner };
      next();
    });
    const api = express.Router();
    api.use("/platform", platformRoutes({ platform: service } as unknown as AppDeps));
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
    ];
    for (const [path, method, body] of routes) {
      expect((await call(base, path, method, undefined, body)).status).toBe(401);
      expect((await call(base, path, method, "owner", body)).status).toBe(403);
    }
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
