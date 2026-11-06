import { randomBytes } from "node:crypto";
import { createLiveCredentialEnv, createPlatformCredentialService, createSecretBox } from "@studix/auth";
import { MULTIX_VENDOR_KEYS } from "@studix/providers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createPlatformAdmin,
  storageSettingsFromConfig,
  VENDOR_CREDENTIAL_NAMES,
} from "../src/platform-admin.ts";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

const OPERATOR = `op-${Date.now()}@example.test`;
const UNVERIFIED = `unv-${Date.now()}@example.test`;
const KEY = "sk-sume-integration-key-7788";
const ROTATED = "sk-sume-rotated-key-0001";
const SECRET_ACCESS_KEY = "super-secret-access-key-value";

describe("platform storage and media API (Better Auth session, Postgres)", () => {
  let app: TestApp;
  let operator: string;
  let member: string;
  let unverified: string;
  let probe: { ok: boolean; step?: "put" | "head" | "delete"; status?: number; s3Code?: string };
  let multixKeys: Record<string, boolean>;
  let invalidations = 0;

  beforeAll(async () => {
    probe = { ok: true };
    multixKeys = {};
    app = await startTestApp();
    const secrets = createSecretBox(randomBytes(32));
    const credentials = createPlatformCredentialService({
      credentials: app.db.repos.platformCredentials,
      audit: app.db.repos.audit,
      secrets,
      names: VENDOR_CREDENTIAL_NAMES,
      env: {},
    });
    const live = createLiveCredentialEnv({
      credentials: app.db.repos.platformCredentials,
      secrets,
      base: {},
      names: Object.values(MULTIX_VENDOR_KEYS),
    });
    app.deps.platform = createPlatformAdmin({
      operatorEmails: [OPERATOR, UNVERIFIED],
      credentials,
      refreshCredentials: () => live.refresh(),
      storage: { probeWrite: async () => probe },
      storageSettings: storageSettingsFromConfig({
        S3_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
        S3_BUCKET: "studix-dev",
        S3_REGION: "auto",
        S3_FORCE_PATH_STYLE: false,
        S3_ACCESS_KEY_ID: "AKIAEXAMPLE000012345",
        S3_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
      }),
      multix: {
        status: () => ({ id: "multix", enabled: true, models: {} }) as never,
        readiness: async () => multixKeys as never,
        invalidateCapabilities: () => {
          invalidations += 1;
        },
      },
      multixBin: "/opt/multix/cli.js",
    });
    operator = await app.signUp(OPERATOR);
    member = await app.signUp(`member-${Date.now()}@example.test`);
    unverified = await app.signUp(UNVERIFIED);
    // Sign-in providers mark the address verified; password sign-up does not.
    await app.db.client`update users set email_verified = true where email = ${OPERATOR}`;
  });
  afterAll(async () => {
    await app?.close();
  });

  const call = (method: string, path: string, cookie?: string, body?: unknown) =>
    app.api(method, `/api/platform/media${path}`, { cookie, body });

  it("is operator-only: members, unverified emails and anonymous callers are refused", async () => {
    expect((await call("GET", "")).status).toBe(401);
    for (const cookie of [member, unverified]) {
      expect((await call("GET", "", cookie)).status).toBe(403);
      expect((await call("PUT", "/vendors/sume", cookie, { apiKey: KEY })).status).toBe(403);
      expect((await call("DELETE", "/vendors/sume", cookie)).status).toBe(403);
      expect((await call("POST", "/storage/test", cookie)).status).toBe(403);
      expect((await call("POST", "/multix/check", cookie)).status).toBe(403);
    }
    const flag = async (cookie: string) =>
      ((await (await app.api("GET", "/api/me", { cookie })).json()) as { operator: boolean }).operator;
    expect(await flag(operator)).toBe(true);
    expect(await flag(member)).toBe(false);
    expect(await flag(unverified)).toBe(false);
  });

  it("shows redacted storage and media status and never a secret", async () => {
    const res = await call("GET", "", operator);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    expect(text).not.toContain(SECRET_ACCESS_KEY);
    expect(text).not.toContain("AKIAEXAMPLE000012345");
    const body = JSON.parse(text);
    expect(body.storage).toMatchObject({
      source: "env",
      configured: true,
      endpointHost: "acct123.r2.cloudflarestorage.com",
      bucket: "studix-dev",
      accessKeyId: "…2345",
      secretAccessKey: "configured",
    });
    expect(body.multix).toMatchObject({ enabled: true, bin: "/opt/multix/cli.js" });
    const ids = body.vendors.map((v: { id: string }) => v.id);
    expect(ids).toEqual(["sume", "atlas", "elevenlabs", "fish", "minimax", "openrouter"]);
    const eleven = body.vendors.find((v: { id: string }) => v.id === "elevenlabs");
    expect(eleven.kinds).toEqual(["voice", "music", "sfx"]);
  });

  it("saves, rotates and revokes a vendor key; it is sealed, never returned and audited without the value", async () => {
    const saved = await call("PUT", "/vendors/sume", operator, { apiKey: KEY });
    expect(saved.status).toBe(200);
    expect(saved.headers.get("cache-control")).toBe("no-store");
    const savedText = await saved.text();
    expect(savedText).not.toContain(KEY);
    expect(JSON.parse(savedText)).toMatchObject({
      status: "configured",
      source: "platform",
      keyHint: "…7788",
      version: 1,
    });

    const [row] = await app.db
      .client`select secret_ciphertext from platform_credentials where name = 'SUME_API_KEY'`;
    expect(String(row?.secret_ciphertext)).toMatch(/^v1\./);
    expect(String(row?.secret_ciphertext)).not.toContain(KEY);

    const rotated = await call("PUT", "/vendors/sume", operator, { apiKey: ROTATED });
    expect(((await rotated.json()) as { version: number }).version).toBe(2);

    const audit = JSON.stringify(
      await app.db.client`select * from audit_events where subject_type = 'platform_credential'`,
    );
    expect(audit).toContain("platform_credential.saved");
    expect(audit).not.toContain(KEY);
    expect(audit).not.toContain(ROTATED);
    expect(await (await call("GET", "", operator)).text()).not.toContain(ROTATED);

    const revoked = await call("DELETE", "/vendors/sume", operator);
    expect(await revoked.json()).toMatchObject({ status: "revoked", source: "none" });
    const [after] = await app.db
      .client`select secret_ciphertext from platform_credentials where name = 'SUME_API_KEY'`;
    expect(after?.secret_ciphertext).toBeNull();
    expect(invalidations).toBeGreaterThan(0);
  });

  it("rejects malformed keys and unknown vendors without echoing the value", async () => {
    const bad = await call("PUT", "/vendors/sume", operator, { apiKey: "has a space" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).not.toContain("has a space");
    expect((await call("PUT", "/vendors/PATH", operator, { apiKey: KEY })).status).toBe(404);
    expect((await call("DELETE", "/vendors/nope", operator)).status).toBe(404);
  });

  it("tests object storage and classifies each failure without leaking credentials", async () => {
    const run = async () =>
      (await (await call("POST", "/storage/test", operator)).json()) as Record<string, unknown>;
    probe = { ok: true };
    expect(await run()).toMatchObject({ ok: true, diagnostic: "ok" });
    probe = { ok: false, step: "put", status: 403, s3Code: "AccessDenied" };
    expect(await run()).toMatchObject({
      ok: false,
      diagnostic: "missing_permission",
      step: "put",
      status: 403,
      s3Code: "AccessDenied",
    });
    probe = { ok: false, step: "put", status: 403, s3Code: "SignatureDoesNotMatch" };
    expect(await run()).toMatchObject({ diagnostic: "bad_credential" });
    probe = { ok: false, step: "put" };
    const down = await run();
    expect(down).toMatchObject({ diagnostic: "remote_unavailable" });
    expect(JSON.stringify(down)).not.toContain(SECRET_ACCESS_KEY);
  });

  it("runs the free multix check and reports which vendor keys it found", async () => {
    multixKeys = {
      sume: true,
      atlas: false,
      elevenlabs: false,
      fish: false,
      minimax: false,
      openrouter: false,
    };
    const all = await (await call("POST", "/multix/check", operator)).json();
    expect(all).toMatchObject({ ok: true, diagnostic: "ok", keyFound: { sume: true, atlas: false } });
    const one = await (await call("POST", "/vendors/atlas/test", operator)).json();
    expect(one).toMatchObject({ ok: false, diagnostic: "missing_credential" });
    expect((await call("POST", "/vendors/zzz/test", operator)).status).toBe(404);
  });
});
