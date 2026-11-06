import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MediaChargedError,
  type MediaProvider,
  type NewProviderExecution,
  type TenantContext,
} from "@studix/core";
import { FakeMediaProvider } from "@studix/providers";
import { StudixError } from "@studix/shared";
import { type StageContext, StageFailedAfterSpend } from "@studix/workflow";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { generateStoredMedia, type StoredMedia } from "../src/stored-media.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "studix-stored-media-exec-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function stageWith(media: MediaProvider, failRecorder = false) {
  const rows: NewProviderExecution[] = [];
  const storage = {
    put: async (_c: TenantContext, key: string, _body: unknown, opts: { sha256?: string }) => ({
      key,
      sha256: opts.sha256 ?? "",
      bytes: 1,
    }),
  };
  const executions = {
    recordProviderExecution: async (_c: TenantContext, input: NewProviderExecution) => {
      if (failRecorder) throw new Error("db down");
      rows.push(input);
      return input;
    },
  };
  const s = {
    ctx,
    job: { id: "job_1" },
    attempt: 1,
    signal: new AbortController().signal,
    mediaJournal: undefined,
    services: { media, storage, workRoot: root, executions },
  } as unknown as StageContext;
  return { s, rows };
}

const request = {
  assetId: "a",
  kind: "image" as const,
  prompt: "frame a",
  keyPrefix: "generated/job_1/a",
  maxCostCents: 10,
};

const failing = (error: StudixError): MediaProvider => ({
  id: "multix",
  capabilities: async () => [],
  estimateCostCents: async () => 2,
  generate: async () => {
    throw error;
  },
});

describe("provider executions of media calls", () => {
  it("records a successful call and links its usage line to the row", async () => {
    const { s, rows } = stageWith(new FakeMediaProvider({ pricing: { estimateCents: () => 2 } }));
    const out = (await generateStoredMedia(s, "designs", request)) as StoredMedia;
    expect(rows).toEqual([
      expect.objectContaining({
        jobId: "job_1",
        stageId: "designs",
        operation: "media.image",
        status: "succeeded",
        costCents: 2,
        attempt: 1,
      }),
    ]);
    expect(rows[0]?.provider).toBeTruthy();
    expect(out.usage.providerExecutionId).toBe(rows[0]?.id);
  });

  it("records a charged failure with its prediction id and links the billed usage", async () => {
    const cause = new StudixError("PROVIDER_ERROR", "finished without outputs", { retryable: false });
    const media = failing(
      new MediaChargedError(cause, {
        provider: "multix",
        model: "atlas:seedance",
        costCents: 3,
        costSource: "receipt",
        job: { provider: "atlas", id: "pred_9" },
      }),
    );
    const { s, rows } = stageWith(media);
    const err = (await generateStoredMedia(s, "i2v", request).catch(
      (e: unknown) => e,
    )) as StageFailedAfterSpend;
    expect(err).toBeInstanceOf(StageFailedAfterSpend);
    expect(rows).toEqual([
      expect.objectContaining({
        status: "failed",
        model: "atlas:seedance",
        costCents: 3,
        externalId: "atlas:pred_9",
        error: expect.objectContaining({ code: "PROVIDER_ERROR" }),
      }),
    ]);
    expect(err.usage[0]).toMatchObject({ providerExecutionId: rows[0]?.id, upstreamJob: "atlas:pred_9" });
  });

  it("records a cancelled call as cancelled", async () => {
    const { s, rows } = stageWith(failing(new StudixError("CANCELLED", "job cancelled")));
    await expect(generateStoredMedia(s, "designs", request)).rejects.toThrow("job cancelled");
    expect(rows).toEqual([
      expect.objectContaining({ status: "cancelled", costCents: 0, provider: "multix" }),
    ]);
  });

  it("never fails the stage when the row cannot be written", async () => {
    const { s } = stageWith(new FakeMediaProvider({ pricing: { estimateCents: () => 2 } }), true);
    const out = (await generateStoredMedia(s, "designs", request)) as StoredMedia;
    expect(out.asset.id).toBe("a");
    expect(out.usage.providerExecutionId).toBeUndefined();
  });
});
