import type { StorageAdapter } from "@studix/core";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { InMemoryStorageAdapter, probeStorageWriteAccess } from "../src/index.ts";

describe("probeStorageWriteAccess", () => {
  it("passes on a working store and leaves no object behind", async () => {
    const storage = new InMemoryStorageAdapter();
    const result = await probeStorageWriteAccess(storage);
    expect(result.ok).toBe(true);
    expect(result.step).toBeUndefined();
  });

  it("reports a denied put with the status and an actionable hint, without throwing", async () => {
    const storage = new InMemoryStorageAdapter();
    (storage as StorageAdapter).put = async () => {
      throw new StudixError("UNAVAILABLE", "Object storage put failed: Access Denied", {
        details: { action: "put", status: 403 },
      });
    };
    const result = await probeStorageWriteAccess(storage);
    expect(result).toMatchObject({ ok: false, step: "put", status: 403 });
    expect(result.hint).toMatch(/S3_ACCESS_KEY_ID/);
  });

  it("cleans up the probe object when a later step fails", async () => {
    const storage = new InMemoryStorageAdapter();
    let deletes = 0;
    const realDelete = storage.delete.bind(storage);
    storage.delete = async (...args) => {
      deletes++;
      if (deletes === 1) throw new StudixError("UNAVAILABLE", "boom", { details: { status: 500 } });
      return realDelete(...args);
    };
    const result = await probeStorageWriteAccess(storage);
    expect(result).toMatchObject({ ok: false, step: "delete", status: 500 });
    expect(deletes).toBe(2);
  });
});
