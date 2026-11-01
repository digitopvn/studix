import { describe, expect, it } from "vitest";
import type { MediaJobRecord } from "../src/index.ts";
import { createInMemoryStudio, testTenant } from "../src/testing/index.ts";

const key = "job:upscale:shot-1";
const intent = (attempt: number, updatedAt: string, state: MediaJobRecord["state"] = "submitting") =>
  ({
    idempotencyKey: key,
    kind: "image",
    model: "atlas/upscaler",
    attempt,
    state,
    estimatedCostCents: 4,
    submittedAt: updatedAt,
    updatedAt,
  }) satisfies MediaJobRecord;

async function stuckJob(records: MediaJobRecord[][]) {
  const env = createInMemoryStudio();
  const ctx = testTenant();
  const { job } = await env.studio.createVideoProject(ctx, { brief: { prompt: "Brand intro" } });
  await env.repos.jobs.update(ctx, job.id, { status: "failed", attempts: records.length });
  for (const [index, mediaJobs] of records.entries()) {
    await env.repos.jobs.upsertStage(ctx, {
      jobId: job.id,
      name: "upscale",
      attempt: index + 1,
      status: "failed",
      mediaJobs,
    });
  }
  const input = { jobId: job.id, stage: "upscale", idempotencyKey: key, predictionId: "pred_42" };
  return { ...env, ctx, job, input };
}

describe("attaching a found Atlas prediction to a submitting record", () => {
  it("promotes the newest record of the key to submitted on its own stage row and audits it", async () => {
    const { studio, repos, ctx, job, input } = await stuckJob([
      [
        intent(1, "2026-01-01T00:00:00.000Z", "failed"),
        { ...intent(1, "2026-01-01T00:00:00.000Z"), idempotencyKey: "other" },
      ],
      [intent(2, "2026-01-01T00:00:05.000Z")],
    ]);
    const { job: view, mediaJob } = await studio.attachMediaJob(ctx, input);
    expect(view).toMatchObject({ id: job.id, status: "failed" });
    expect(mediaJob).toMatchObject({
      state: "submitted",
      attempt: 2,
      job: { provider: "atlas", id: "pred_42" },
    });

    const [first, second] = (await repos.jobs.listStages(ctx, job.id)).sort((a, b) => a.attempt - b.attempt);
    expect(first?.mediaJobs?.map((r) => r.state)).toEqual(["failed", "submitting"]);
    expect(second?.mediaJobs).toEqual([mediaJob]);
    const audit = await repos.audit.list(ctx, { subjectType: "job", subjectId: job.id });
    expect(audit.items[0]).toMatchObject({
      action: "job.media_job_attached",
      data: { stage: "upscale", idempotencyKey: key, predictionId: "pred_42", attempt: 2 },
    });
  });

  it("refuses a record that is not submitting, a job that is not failed, and readers", async () => {
    const done = await stuckJob([[intent(1, "2026-01-01T00:00:00.000Z", "completed")]]);
    await expect(done.studio.attachMediaJob(done.ctx, done.input)).rejects.toMatchObject({
      code: "CONFLICT",
    });

    const stuck = await stuckJob([[intent(1, "2026-01-01T00:00:00.000Z")]]);
    const viewer = { ...stuck.ctx, actor: { type: "user" as const, id: "usr_v", role: "viewer" as const } };
    await expect(stuck.studio.attachMediaJob(viewer, stuck.input)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      stuck.studio.attachMediaJob(stuck.ctx, { ...stuck.input, stage: "frames" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      stuck.studio.attachMediaJob(stuck.ctx, { ...stuck.input, predictionId: "a b" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });

    await stuck.repos.jobs.update(stuck.ctx, stuck.job.id, { status: "running" });
    await expect(stuck.studio.attachMediaJob(stuck.ctx, stuck.input)).rejects.toMatchObject({
      code: "CONFLICT",
    });
    const [stage] = await stuck.repos.jobs.listStages(stuck.ctx, stuck.job.id);
    expect(stage?.mediaJobs?.[0]?.state).toBe("submitting");
  });
});
