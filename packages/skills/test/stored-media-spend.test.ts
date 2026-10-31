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
function stageWith(failing: ReadonlySet<string>, gate?: { id: string; open: Promise<void> }) {
  const media = new FakeMediaProvider({ pricing: { estimateCents: () => 2 } });
  const stored: string[] = [];
  const storage = {
    put: async (_c: TenantContext, key: string, _body: unknown, opts: { sha256?: string }) => {
      if (gate && key.includes(`/${gate.id}.`)) await gate.open;
      if ([...failing].some((id) => key.includes(`/${id}.`))) {
        throw new StudixError("UNAVAILABLE", "storage is down", { retryable: true });
      }
      stored.push(key);
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
  return { s, stored };
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
    const { s } = stageWith(new Set(["a"]));
    const err = await generateStoredMedia(s, "designs", request("a"), root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    const failed = err as StageFailedAfterSpend;
    expect(failed.error.code).toBe("UNAVAILABLE");
    expect(failed.usage).toHaveLength(1);
    expect(failed.usage[0]).toMatchObject({ item: "media-a", costCents: 2, unit: "image" });
  });

  it("bills the finished and in-flight items of a batch where one item fails", async () => {
    // `b` fails on upload at once, `c` is still uploading when it does, and `a` has already finished.
    let release: () => void = () => {};
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { s, stored } = stageWith(new Set(["b"]), { id: "c", open });
    let settled = false;
    const batch = mapBounded(
      ["a", "b", "c"],
      3,
      (id) => generateStoredMedia(s, "designs", request(id), root),
      (r: StoredMedia) => [r.usage],
    )
      .catch((e: unknown) => e)
      .finally(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false); // the failure waits for `c`
    release();
    const err = await batch;
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    const failed = err as StageFailedAfterSpend;
    expect(stored.map((k) => k.split("/").pop()).sort()).toEqual(["a.png", "c.png"]);
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
