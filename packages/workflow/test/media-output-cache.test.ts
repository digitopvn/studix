import type { TenantContext } from "@studix/core";
import { createInMemoryStageCache } from "@studix/core/testing";
import type { AssetRef } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { MEDIA_OUTPUT_CACHE_STAGE, mediaOutputCache } from "../src/index.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};
const clock = { now: () => new Date("2026-01-01T00:00:00Z") };
const clip: AssetRef = {
  id: "s2-clip",
  kind: "video",
  storageKey: "generated/job_1/clips/s2.mp4",
  sha256: "a".repeat(64),
  mime: "video/mp4",
  provenance: { source: "generated", provider: "multix", model: "sume:seedance-2.5" },
};

describe("paid media outputs in the stage cache", () => {
  it("finds an output by its key with the job that paid for it, and keeps the first one stored", async () => {
    const cache = createInMemoryStageCache(clock);
    await mediaOutputCache(cache, ctx, "job_1").put("media@1:k", clip);
    await mediaOutputCache(cache, ctx, "job_2").put("media@1:k", { ...clip, sha256: "b".repeat(64) });
    expect(await mediaOutputCache(cache, ctx, "job_3").get("media@1:k")).toEqual({
      asset: clip,
      jobId: "job_1",
    });
    expect(await mediaOutputCache(cache, ctx, "job_3").get("media@1:other")).toBeUndefined();
  });

  it("treats an entry whose asset no longer parses as absent", async () => {
    const cache = createInMemoryStageCache(clock);
    await cache.put(ctx, {
      stage: MEDIA_OUTPUT_CACHE_STAGE,
      cacheKey: "media@1:k",
      output: { asset: { id: 1 } },
    });
    expect(await mediaOutputCache(cache, ctx, "job_2").get("media@1:k")).toBeUndefined();
  });

  it("does not share outputs between workspaces", async () => {
    const cache = createInMemoryStageCache(clock);
    await mediaOutputCache(cache, ctx, "job_1").put("media@1:k", clip);
    const other = { ...ctx, workspaceId: "ws_2" };
    expect(await mediaOutputCache(cache, other, "job_2").get("media@1:k")).toBeUndefined();
  });
});
