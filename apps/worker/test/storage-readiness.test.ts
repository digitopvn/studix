import { createLogger } from "@studix/shared";
import { InMemoryStorageAdapter } from "@studix/storage";
import { describe, expect, it } from "vitest";
import { createStorageReadiness } from "../src/storage-readiness.ts";

describe("storage readiness", () => {
  it("caches the probe within the ttl and re-probes after it", async () => {
    const storage = new InMemoryStorageAdapter();
    let puts = 0;
    const put = storage.put.bind(storage);
    storage.put = async (...args) => {
      puts++;
      return put(...args);
    };
    let t = 0;
    const readiness = createStorageReadiness(storage, createLogger({ service: "t" }, { level: "error" }), {
      ttlMs: 1000,
      now: () => t,
    });
    expect((await readiness.check()).ok).toBe(true);
    await readiness.check();
    expect(puts).toBe(1);
    t = 2000;
    await readiness.check();
    expect(puts).toBe(2);
  });
});
