import { testTenant } from "@studix/core/testing";
import { createManualClock, loadConfig, StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  attachmentDisposition,
  createS3StorageAdapterFromConfig,
  InMemoryStorageAdapter,
  resolveTenantKey,
  S3StorageAdapter,
} from "../src/index.ts";
import { describeStorageAdapterContract } from "./storage-adapter-contract.ts";

describeStorageAdapterContract("in-memory", () => new InMemoryStorageAdapter());

describe("InMemoryStorageAdapter", () => {
  it("stores objects under the tenant prefix and computes expiry from the clock", async () => {
    const clock = createManualClock(new Date("2026-01-01T00:00:00Z"));
    const adapter = new InMemoryStorageAdapter({ clock });
    const ctx = testTenant({ organizationId: "org_a", workspaceId: "ws_b" });
    await adapter.put(ctx, "renders/r/out.mp4", new Uint8Array([1, 2]), { contentType: "video/mp4" });
    expect(adapter.keys()).toEqual(["orgs/org_a/workspaces/ws_b/renders/r/out.mp4"]);
    const url = new URL(await adapter.signedUrl(ctx, "renders/r/out.mp4", { expiresInSeconds: 60 }));
    expect(url.searchParams.get("expires")).toBe(String(Date.parse("2026-01-01T00:01:00Z") / 1000));
  });
});

describe("resolveTenantKey", () => {
  it("builds orgs/<org>/workspaces/<ws>/<key>", () => {
    expect(resolveTenantKey({ organizationId: "org_1", workspaceId: "ws_2" }, "a/b.png")).toBe(
      "orgs/org_1/workspaces/ws_2/a/b.png",
    );
  });

  it("rejects tenant ids that could forge another prefix", () => {
    expect(() => resolveTenantKey({ organizationId: "org_1/workspaces/x", workspaceId: "ws" }, "a")).toThrow(
      StudixError,
    );
    expect(() => resolveTenantKey({ organizationId: "", workspaceId: "ws" }, "a")).toThrow(StudixError);
  });
});

describe("attachmentDisposition", () => {
  it("keeps the UTF-8 name and strips header-breaking characters", () => {
    const value = attachmentDisposition('giới "thiệu"\r\n.mp4');
    expect(value).not.toMatch(/[\r\n]/);
    expect(value).toContain(`filename*=UTF-8''${encodeURIComponent("giới thiệu.mp4")}`);
    expect(value).toContain('filename="gioi thieu.mp4"');
  });
});

describe("createS3StorageAdapterFromConfig", () => {
  const base = { NODE_ENV: "test", S3_ENDPOINT: "http://127.0.0.1:59000", S3_FORCE_PATH_STYLE: "true" };

  it("requires a bucket and paired credentials", () => {
    expect(() => createS3StorageAdapterFromConfig(loadConfig(base))).toThrow(/S3_BUCKET/);
    expect(() =>
      createS3StorageAdapterFromConfig(loadConfig({ ...base, S3_BUCKET: "b", S3_ACCESS_KEY_ID: "id" })),
    ).toThrow(/together/);
  });

  it("uses the configured TTL as default and ceiling", async () => {
    const adapter = createS3StorageAdapterFromConfig(
      loadConfig({
        ...base,
        S3_BUCKET: "studix-test",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret-value",
        S3_SIGNED_URL_TTL_SECONDS: "300",
      }),
    );
    expect(adapter).toBeInstanceOf(S3StorageAdapter);
    const ctx = testTenant();
    // Signing is local (no network), so this runs without MinIO.
    const url = new URL(await adapter.signedUrl(ctx, "renders/r/out.mp4"));
    expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
    expect(url.pathname).toBe(
      `/studix-test/orgs/${ctx.organizationId}/workspaces/${ctx.workspaceId}/renders/r/out.mp4`,
    );
    await expect(adapter.signedUrl(ctx, "renders/r/out.mp4", { expiresInSeconds: 301 })).rejects.toThrow(
      /out of range/,
    );
    adapter.destroy();
  });

  it("presigns with S3_PUBLIC_ENDPOINT when the clients reach storage on another host", async () => {
    const adapter = createS3StorageAdapterFromConfig(
      loadConfig({
        ...base,
        S3_ENDPOINT: "http://minio:9000",
        S3_PUBLIC_ENDPOINT: "http://localhost:59000",
        S3_BUCKET: "studix-test",
        S3_ACCESS_KEY_ID: "id",
        S3_SECRET_ACCESS_KEY: "secret-value",
      }),
    );
    const url = new URL(await adapter.signedUrl(testTenant(), "renders/r/out.mp4"));
    expect(url.origin).toBe("http://localhost:59000");
    adapter.destroy();
  });
});
