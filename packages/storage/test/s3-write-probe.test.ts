import { S3ServiceException } from "@aws-sdk/client-s3";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { S3StorageAdapter } from "../src/index.ts";

const ctx = { organizationId: "org_a", workspaceId: "ws_b" };

function adapterWith(send: (command: { constructor: { name: string } }) => Promise<unknown>) {
  const adapter = new S3StorageAdapter({ bucket: "b", region: "auto", endpoint: "http://127.0.0.1:1" });
  (adapter as unknown as { client: { send: typeof send } }).client = { send };
  return adapter;
}

function accessDenied(): S3ServiceException {
  return new S3ServiceException({
    name: "AccessDenied",
    $fault: "client",
    $metadata: { httpStatusCode: 403 },
    message: "Access Denied",
  });
}

describe("S3StorageAdapter.verifyWritable", () => {
  it("writes, reads back and deletes a throwaway object, then caches the pass", async () => {
    const calls: string[] = [];
    const adapter = adapterWith(async (command) => {
      calls.push(command.constructor.name);
      return { ContentLength: 24, Metadata: {} };
    });
    await adapter.verifyWritable(ctx);
    await adapter.verifyWritable(ctx);
    expect(calls).toEqual(["PutObjectCommand", "HeadObjectCommand", "DeleteObjectCommand"]);
  });

  it("reports a 403 as a non-retryable UNAVAILABLE error with a credentials hint", async () => {
    const adapter = adapterWith(async () => {
      throw accessDenied();
    });
    const err = await adapter.verifyWritable(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StudixError);
    const e = err as StudixError;
    expect(e.code).toBe("UNAVAILABLE");
    expect(e.retryable).toBe(false);
    expect(e.details).toMatchObject({ action: "put", status: 403 });
    expect(e.suggestedAction).toMatch(/credentials were rejected/);
  });

  it("does not cache a failure", async () => {
    let fail = true;
    const adapter = adapterWith(async () => {
      if (fail) throw accessDenied();
      return { ContentLength: 24, Metadata: {} };
    });
    await expect(adapter.verifyWritable(ctx)).rejects.toBeInstanceOf(StudixError);
    fail = false;
    await expect(adapter.verifyWritable(ctx)).resolves.toBeUndefined();
  });
});
