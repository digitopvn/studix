import { randomBytes } from "node:crypto";
import { CreateBucketCommand, HeadBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { testTenant } from "@studix/core/testing";
import { loadConfig, StudixError } from "@studix/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createS3StorageAdapterFromConfig, type S3StorageAdapter } from "../src/index.ts";
import { describeStorageAdapterContract } from "./storage-adapter-contract.ts";

/**
 * Runs against MinIO from `docker compose up -d minio` (S3_* from the environment, see .env.example).
 * The bucket is created here when missing, so the test does not depend on the compose init container.
 */
const config = loadConfig({ ...process.env, NODE_ENV: "test" });
if (!config.S3_ENDPOINT || !config.S3_BUCKET || !config.S3_ACCESS_KEY_ID || !config.S3_SECRET_ACCESS_KEY) {
  throw new StudixError("UNAVAILABLE", "S3_* is not set for storage integration tests", {
    suggestedAction:
      "Run `docker compose up -d minio` and export the S3_* values from .env.example (S3_BUCKET=studix-test).",
  });
}

async function ensureBucket(): Promise<void> {
  const client = new S3Client({
    region: config.S3_REGION,
    endpoint: config.S3_ENDPOINT,
    forcePathStyle: config.S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: config.S3_ACCESS_KEY_ID!, secretAccessKey: config.S3_SECRET_ACCESS_KEY! },
  });
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.S3_BUCKET }));
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: config.S3_BUCKET }));
  } finally {
    client.destroy();
  }
}

const adapters: S3StorageAdapter[] = [];
beforeAll(ensureBucket);
afterAll(() => {
  for (const adapter of adapters) adapter.destroy();
});

describeStorageAdapterContract("S3 (MinIO)", () => {
  const adapter = createS3StorageAdapterFromConfig(config);
  adapters.push(adapter);
  return adapter;
});

describe("S3StorageAdapter against MinIO", () => {
  it("serves a signed URL that downloads the object and rejects a tampered tenant path", async () => {
    const adapter = createS3StorageAdapterFromConfig(config);
    adapters.push(adapter);
    const ctx = testTenant();
    const body = randomBytes(1024);
    await adapter.put(ctx, "renders/signed/out.mp4", body, { contentType: "video/mp4" });
    const url = await adapter.signedUrl(ctx, "renders/signed/out.mp4", {
      expiresInSeconds: 60,
      downloadName: "giới-thiệu.mp4",
    });
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("video/mp4");
    expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
    expect(Buffer.compare(Buffer.from(await response.arrayBuffer()), body)).toBe(0);

    const tampered = url.replace(ctx.workspaceId, testTenant().workspaceId);
    expect((await fetch(tampered)).status).toBe(403);
  });
});
