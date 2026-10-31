import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantContext } from "@studix/core";
import { FakeMediaProvider } from "@studix/providers";
import { StudixError } from "@studix/shared";
import { mapBounded, type StageContext, StageFailedAfterSpend } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateStoredMedia, type StoredMedia } from "../src/stored-media.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-stored-media-spend-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A stage context whose storage refuses the puts of `failing` assets. */
function stageWith(failing: ReadonlySet<string>) {
  const media = new FakeMediaProvider({ pricing: { estimateCents: () => 2 } });
  const storage = {
    put: async (_c: TenantContext, key: string, _body: unknown, opts: { sha256?: string }) => {
      if ([...failing].some((id) => key.includes(id))) {
        throw new StudixError("UNAVAILABLE", "storage is down", { retryable: true });
      }
      return { key, sha256: opts.sha256 ?? "", bytes: 1 };
    },
  };
  const s = {
    ctx,
    job: { id: "job_1" },
    attempt: 1,
    signal: new AbortController().signal,
    mediaJournal: undefined,
    services: { media, storage, workRoot: root },
  } as unknown as StageContext;
  return s;
}

const request = (assetId: string) => ({
  assetId,
  kind: "image" as const,
  prompt: `frame ${assetId}`,
  keyPrefix: `generated/job_1/${assetId}`,
  maxCostCents: 10,
});

describe("media spend of a failed stage", () => {
  it("bills a generation whose upload failed", async () => {
    const s = stageWith(new Set(["a"]));
    const err = await generateStoredMedia(s, "designs", request("a"), root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    const failed = err as StageFailedAfterSpend;
    expect(failed.error.code).toBe("UNAVAILABLE");
    expect(failed.usage).toHaveLength(1);
    expect(failed.usage[0]).toMatchObject({ item: "media-a", costCents: 2, unit: "image" });
  });

  it("bills the finished and in-flight items of a batch where one item fails", async () => {
    // Concurrency 3: `b` fails on upload while `a` and `c` are generated; all three were paid.
    const s = stageWith(new Set(["b"]));
    const err = await mapBounded(
      ["a", "b", "c"],
      3,
      (id) => generateStoredMedia(s, "designs", request(id), root),
      (r: StoredMedia) => [r.usage],
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    const failed = err as StageFailedAfterSpend;
    expect(failed.usage.map((u) => u.item).sort()).toEqual(["media-a", "media-b", "media-c"]);
    expect(failed.usage.reduce((sum, u) => sum + u.costCents, 0)).toBe(6);
  });

  it("does not start items after a failure, and keeps a plain failure plain", async () => {
    const started: number[] = [];
    const err = await mapBounded(
      [0, 1, 2, 3],
      1,
      async (i) => {
        started.push(i);
        if (i === 1) throw new StudixError("VALIDATION", "bad", { retryable: false });
        return { usage: [] };
      },
      (r: { usage: never[] }) => r.usage,
    ).catch((e: unknown) => e);
    expect(started).toEqual([0, 1]);
    expect(err).toBeInstanceOf(StudixError);
  });
});
