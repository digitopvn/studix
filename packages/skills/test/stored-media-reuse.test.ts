import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MediaGenerationRequest, MediaProvider, TenantContext } from "@studix/core";
import { FakeMediaProvider, InMemoryMediaJobJournal } from "@studix/providers";
import type { AssetRef } from "@studix/video-ir";
import type { MediaOutputCache, ReusableMedia, StageContext } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  estimateMediaCents,
  generateStoredMedia,
  mediaOutputKey,
  type StoredMediaRequest,
} from "../src/stored-media.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-stored-media-reuse-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One tenant's storage, paid-output cache and media provider, shared by the stage contexts of its jobs. */
function tenant(opts: { model?: () => string } = {}) {
  const objects = new Map<string, string>();
  const entries = new Map<string, ReusableMedia>();
  const calls: MediaGenerationRequest[] = [];
  const fake = new FakeMediaProvider({ pricing: { estimateCents: () => 7 } });
  const media: MediaProvider = {
    id: fake.id,
    capabilities: () => fake.capabilities(),
    estimateCostCents: (r) => fake.estimateCostCents(r),
    generate: (c, r) => {
      calls.push(r);
      return fake.generate(c, r);
    },
    ...(opts.model ? { resolveModel: opts.model } : {}),
  };
  const storage = {
    put: async (_c: TenantContext, key: string, body: { filePath: string }) => {
      const sha256 = createHash("sha256")
        .update(await readFile(body.filePath))
        .digest("hex");
      objects.set(key, sha256);
      return { key, sha256, bytes: 1 };
    },
    head: async (_c: TenantContext, key: string) => {
      const sha256 = objects.get(key);
      return sha256 ? { key, sha256, bytes: 1, contentType: "" } : undefined;
    },
  };
  const stage = (jobId: string): StageContext => {
    const mediaOutputs: MediaOutputCache = {
      get: async (key) => entries.get(key),
      put: async (key: string, asset: AssetRef) => {
        if (!entries.has(key)) entries.set(key, { asset, jobId });
      },
    };
    return {
      ctx,
      job: { id: jobId },
      attempt: 1,
      signal: new AbortController().signal,
      mediaJournal: new InMemoryMediaJobJournal(),
      mediaOutputs,
      services: { media, storage, workRoot: root },
    } as unknown as StageContext;
  };
  return { stage, calls, objects, entries };
}

const line = (jobId: string, over: Partial<StoredMediaRequest> = {}): StoredMediaRequest => ({
  assetId: `l1-vo-${jobId}`,
  kind: "voice",
  prompt: "Vừa kịp lúc.",
  params: { language: "vi", instructions: "whisper" },
  keyPrefix: `generated/${jobId}/dialogue/l1`,
  maxCostCents: 10,
  reuse: {},
  ...over,
});

describe("reuse of paid media outputs", () => {
  it("serves an identical request of a later job from the stored output, at no cost", async () => {
    const t = tenant();
    const first = await generateStoredMedia(t.stage("job_1"), "dialogue", line("job_1"));
    expect(first.reusedFrom).toBeUndefined();
    expect(first.usage.costCents).toBeGreaterThan(0);

    const later = t.stage("job_2");
    expect(await estimateMediaCents(later, [line("job_2")])).toBe(0);
    const again = await generateStoredMedia(later, "dialogue", line("job_2"));
    expect(t.calls).toHaveLength(1);
    expect(again.reusedFrom).toEqual({ jobId: "job_1" });
    expect(again.asset).toEqual({ ...first.asset, id: "l1-vo-job_2" });
    expect(again.usage).toMatchObject({
      item: "media-l1-vo-job_2",
      quantity: 0,
      costCents: 0,
      metadata: { reused: true, reusedFromJob: "job_1" },
    });
    expect(again.usage.upstreamJob).toBeUndefined();
  });

  it("pays for a request whose prompt, parameters or input file differ", async () => {
    const t = tenant();
    const clip = (jobId: string, image: string, over: Partial<StoredMediaRequest> = {}) =>
      line(jobId, {
        kind: "video",
        prompt: "slow push in",
        params: { durationMs: 4000, image: join(root, jobId, "key.png") },
        reuse: { inputs: { image } },
        ...over,
      });
    await generateStoredMedia(t.stage("job_1"), "motion", clip("job_1", "a".repeat(64)));
    // The local path differs per job and is not part of the key; the keyframe's digest is.
    await generateStoredMedia(t.stage("job_2"), "motion", clip("job_2", "a".repeat(64)));
    expect(t.calls).toHaveLength(1);
    await generateStoredMedia(t.stage("job_3"), "motion", clip("job_3", "b".repeat(64)));
    await generateStoredMedia(
      t.stage("job_4"),
      "motion",
      clip("job_4", "a".repeat(64), { prompt: "pan left" }),
    );
    await generateStoredMedia(
      t.stage("job_5"),
      "motion",
      clip("job_5", "a".repeat(64), { params: { durationMs: 5000, image: "x" } }),
    );
    expect(t.calls).toHaveLength(4);
  });

  it("never matches a file parameter left out of the inputs", () => {
    const t = tenant();
    const withPath = (jobId: string) =>
      mediaOutputKey(t.stage(jobId), line(jobId, { params: { image: join(root, jobId, "key.png") } }));
    expect(withPath("job_1")).not.toBe(withPath("job_2"));
  });

  it("pays again when the stored object is gone or no longer has the recorded digest", async () => {
    const t = tenant();
    const first = await generateStoredMedia(t.stage("job_1"), "dialogue", line("job_1"));
    t.objects.set(first.asset.storageKey as string, "f".repeat(64));
    await generateStoredMedia(t.stage("job_2"), "dialogue", line("job_2"));
    t.objects.clear();
    await generateStoredMedia(t.stage("job_3"), "dialogue", line("job_3"));
    expect(t.calls).toHaveLength(3);
  });

  it("follows the provider's default model: a request without a model is not reused across a new default", async () => {
    let model = "vendor:voice-1";
    const t = tenant({ model: () => model });
    await generateStoredMedia(t.stage("job_1"), "dialogue", line("job_1"));
    await generateStoredMedia(t.stage("job_2"), "dialogue", line("job_2"));
    model = "vendor:voice-2";
    await generateStoredMedia(t.stage("job_3"), "dialogue", line("job_3"));
    expect(t.calls).toHaveLength(2);
  });

  it("neither looks up nor records a request that does not opt in", async () => {
    const t = tenant();
    const { reuse: _, ...plain } = line("job_1");
    await generateStoredMedia(t.stage("job_1"), "designs", plain);
    await generateStoredMedia(t.stage("job_2"), "designs", { ...plain, assetId: "l1-vo-job_2" });
    expect(t.calls).toHaveLength(2);
    expect(t.entries.size).toBe(0);
  });
});
