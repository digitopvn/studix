import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import type { MediaJobRecord } from "../src/index.ts";
import { createInMemoryStudio, testTenant } from "../src/testing/index.ts";

const brief = { prompt: "Video giới thiệu thương hiệu cà phê Sương Mai, 15 giây, dọc", language: "vi" };
const KEY = "stage-2:upscale";

function record(patch: Partial<MediaJobRecord> = {}): MediaJobRecord {
  return {
    idempotencyKey: KEY,
    kind: "image",
    model: "atlas:atlascloud/image-upscaler",
    attempt: 1,
    state: "submitting",
    estimatedCostCents: 3,
    submittedAt: "2025-12-31T00:00:00.000Z",
    updatedAt: "2025-12-31T00:00:00.000Z",
    ...patch,
  };
}

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof StudixError) return err.code;
    throw err;
  }
  throw new Error("expected a StudixError");
}

/** A failed job whose "upscale" stage stored `records`, as a worker leaves it. */
async function failedJob(records: MediaJobRecord[] = [record()]) {
  const env = createInMemoryStudio();
  const ctx = testTenant();
  const created = await env.studio.createVideoProject(ctx, { brief });
  const jobId = created.job.id;
  await env.repos.jobs.upsertStage(ctx, {
    jobId,
    name: "upscale",
    attempt: 1,
    status: "failed",
    mediaJobs: records,
  });
  await env.repos.jobs.update(ctx, jobId, { status: "failed", finishedAt: env.clock.now() });
  return { ...env, ctx, jobId };
}

const attach = { stage: "upscale", idempotencyKey: KEY, job: { provider: "atlas", id: "pred_123" } };

describe("StudioService.attachMediaJob", () => {
  it("promotes the submitting record so the stage journal collects the prediction, and audits it", async () => {
    const { studio, repos, ctx, jobId, clock } = await failedJob();
    clock.advance(1000);
    await studio.attachMediaJob(ctx, jobId, attach);

    const [stage] = await repos.jobs.listStages(ctx, jobId);
    expect(stage?.mediaJobs).toEqual([
      expect.objectContaining({
        idempotencyKey: KEY,
        state: "submitted",
        job: { provider: "atlas", id: "pred_123" },
        attempt: 1,
        submittedAt: "2025-12-31T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:01.000Z",
      }),
    ]);
    const audit = await repos.audit.list(ctx, {});
    expect(audit.items.map((e) => e.action)).toContain("job.media_attached");
    // The job itself stays failed: the operator decides when to retry it.
    expect((await repos.jobs.get(ctx, jobId))?.status).toBe("failed");
  });

  it("refuses a job that is not failed, so no worker can be holding it", async () => {
    const { studio, repos, ctx, jobId } = await failedJob();
    await repos.jobs.update(ctx, jobId, { status: "running" });
    expect(await code(studio.attachMediaJob(ctx, jobId, attach))).toBe("CONFLICT");
    const [stage] = await repos.jobs.listStages(ctx, jobId);
    expect(stage?.mediaJobs?.[0]?.state).toBe("submitting");
  });

  it("refuses a record that already left submitting, a missing key and a non-Atlas job", async () => {
    const submitted = await failedJob([record({ state: "submitted", job: { provider: "atlas", id: "p0" } })]);
    expect(await code(submitted.studio.attachMediaJob(submitted.ctx, submitted.jobId, attach))).toBe(
      "CONFLICT",
    );
    const released = await failedJob([record({ state: "failed" })]);
    expect(await code(released.studio.attachMediaJob(released.ctx, released.jobId, attach))).toBe("CONFLICT");

    const { studio, ctx, jobId } = await failedJob();
    expect(await code(studio.attachMediaJob(ctx, jobId, { ...attach, idempotencyKey: "other" }))).toBe(
      "NOT_FOUND",
    );
    expect(await code(studio.attachMediaJob(ctx, jobId, { ...attach, stage: "nope" }))).toBe("NOT_FOUND");
    expect(
      await code(studio.attachMediaJob(ctx, jobId, { ...attach, job: { provider: "sume", id: "x" } })),
    ).toBe("VALIDATION");
    expect(
      await code(studio.attachMediaJob(ctx, jobId, { ...attach, job: { provider: "atlas", id: "a b" } })),
    ).toBe("VALIDATION");

    const sume = await failedJob([record({ model: "sume:veo" })]);
    expect(await code(sume.studio.attachMediaJob(sume.ctx, sume.jobId, attach))).toBe("CONFLICT");
  });

  it("promotes only the newest record of the key across attempts", async () => {
    const env = await failedJob([record({ state: "failed", updatedAt: "2025-12-31T00:00:00.000Z" })]);
    await env.repos.jobs.upsertStage(env.ctx, {
      jobId: env.jobId,
      name: "upscale",
      attempt: 2,
      status: "failed",
      mediaJobs: [record({ attempt: 2, updatedAt: "2025-12-31T06:00:00.000Z" })],
    });
    await env.studio.attachMediaJob(env.ctx, env.jobId, attach);
    const stages = await env.repos.jobs.listStages(env.ctx, env.jobId);
    const byAttempt = new Map(stages.map((s) => [s.attempt, s.mediaJobs?.[0]?.state]));
    expect(byAttempt.get(1)).toBe("failed");
    expect(byAttempt.get(2)).toBe("submitted");
    // Attaching again is refused: the record is no longer submitting.
    expect(await code(env.studio.attachMediaJob(env.ctx, env.jobId, attach))).toBe("CONFLICT");
  });

  it("is limited to owners and admins and to the job's own tenant", async () => {
    const { studio, ctx, jobId } = await failedJob();
    const editor = { ...ctx, actor: { type: "user" as const, id: "usr_e", role: "editor" as const } };
    expect(await code(studio.attachMediaJob(editor, jobId, attach))).toBe("FORBIDDEN");
    const retryOnly = testTenant({
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      scopes: ["job:retry"],
    });
    expect(await code(studio.attachMediaJob(retryOnly, jobId, attach))).toBe("FORBIDDEN");
    const foreign = testTenant();
    expect(await code(studio.attachMediaJob(foreign, jobId, attach))).toBe("NOT_FOUND");
  });
});
