import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { testTenant } from "@studix/core/testing";
import { loadConfig, StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createS3StorageAdapterFromConfig,
  ENV_STORAGE_PROFILE_ID,
  ProfileStorageRouter,
  type StorageProfileSnapshot,
  type StorageProfileTarget,
} from "../src/index.ts";

/**
 * Two stored profiles and the `env` profile against MinIO (S3_* from .env.example). The profiles share the
 * bucket but use different key prefixes, so an object is only found through the profile it was written to.
 */
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
if (!config.S3_ENDPOINT || !config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) {
  throw new StudixError("UNAVAILABLE", "S3_* is not set for storage integration tests", {
    suggestedAction: "Run `docker compose up -d minio` and export the S3_* values from .env.example.",
  });
}

const run = Date.now().toString(36);
// A new context object per call (no shared pin) for the same tenant.
const tenant = () => testTenant({ organizationId: "org_router", workspaceId: `ws_${run}` });
const target = (id: string, prefix: string, revision = "1"): StorageProfileTarget => ({
  id,
  revision,
  options: {
    bucket: config.S3_BUCKET!,
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT!,
    forcePathStyle: true,
    keyPrefix: `router-${run}/${prefix}/`,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
  },
});

const env = createS3StorageAdapterFromConfig(config);
const routers: ProfileStorageRouter[] = [];
function routerWith(
  snapshot: { current: StorageProfileSnapshot },
  locate?: (key: string) => string | undefined,
) {
  const router = new ProfileStorageRouter({
    fallback: env,
    load: async () => snapshot.current,
    ...(locate ? { locate: async (_ctx, key) => locate(key) } : {}),
    refreshMs: 0,
  });
  routers.push(router);
  return router;
}

beforeAll(async () => {
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: true,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  } finally {
    client.destroy();
  }
});
afterAll(() => {
  for (const r of routers) r.destroy();
  env.destroy();
});

const bytes = (s: string) => new TextEncoder().encode(s);
const text = (body: ReadableStream<Uint8Array>) => new Response(body).text();

describe("ProfileStorageRouter against MinIO", () => {
  it("writes to the active profile and keeps old objects readable after a switch", async () => {
    const snapshot = {
      current: { activeId: "stp_a", profiles: [target("stp_a", "a"), target("stp_b", "b")] },
    };
    const router = routerWith(snapshot);
    const ctx = tenant();
    await router.put(ctx, "renders/one.txt", bytes("first"), { contentType: "text/plain" });

    snapshot.current = { ...snapshot.current, activeId: "stp_b" };
    const later = tenant();
    await router.put(later, "renders/two.txt", bytes("second"), { contentType: "text/plain" });
    expect(await router.activeProfileId()).toBe("stp_b");

    // A fresh router has no location cache: the read falls through to the profile that holds the object.
    const reader = routerWith(snapshot);
    const got = await reader.get(tenant(), "renders/one.txt");
    expect(await text(got.body)).toBe("first");
    expect(await reader.head(tenant(), "renders/two.txt")).toBeDefined();
    const url = await reader.signedUrl(tenant(), "renders/one.txt", { expiresInSeconds: 60 });
    expect(url).toContain(`router-${run}/a/`);
    expect(await (await fetch(url)).text()).toBe("first");
  });

  it("pins a job attempt to the profile of its first write", async () => {
    const snapshot = {
      current: { activeId: "stp_a", profiles: [target("stp_a", "a"), target("stp_b", "b")] },
    };
    const router = routerWith(snapshot);
    const job = tenant();
    await router.put(job, "renders/pinned/1.txt", bytes("1"), { contentType: "text/plain" });
    snapshot.current = { ...snapshot.current, activeId: "stp_b" };
    await router.put(job, "renders/pinned/2.txt", bytes("2"), { contentType: "text/plain" });
    const url = await routerWith(snapshot, () => "stp_a").signedUrl(tenant(), "renders/pinned/2.txt");
    expect(url).toContain(`router-${run}/a/`);
  });

  it("uses the recorded profile first and falls back to env", async () => {
    const snapshot = { current: { activeId: ENV_STORAGE_PROFILE_ID, profiles: [target("stp_a", "a")] } };
    const router = routerWith(snapshot, () => ENV_STORAGE_PROFILE_ID);
    const ctx = tenant();
    await router.put(ctx, "renders/env.txt", bytes("env"), { contentType: "text/plain" });
    expect(await env.head(ctx, "renders/env.txt")).toBeDefined();
    expect(await routerWith(snapshot, () => "stp_a").head(tenant(), "renders/env.txt")).toBeDefined();
    expect(await router.head(tenant(), "renders/missing.txt")).toBeUndefined();
  });

  it("still reads a deactivated profile and rebuilds a client whose revision changed", async () => {
    const snapshot = { current: { activeId: "stp_a", profiles: [target("stp_a", "a")] } };
    const router = routerWith(snapshot);
    const ctx = tenant();
    await router.put(ctx, "renders/rev.txt", bytes("rev"), { contentType: "text/plain" });
    snapshot.current = { activeId: ENV_STORAGE_PROFILE_ID, profiles: [target("stp_a", "a", "2")] };
    await router.refresh();
    expect(await router.activeProfileId()).toBe(ENV_STORAGE_PROFILE_ID);
    expect(await router.head(tenant(), "renders/rev.txt")).toBeDefined();
  });
});
