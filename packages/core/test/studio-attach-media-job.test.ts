import { describe, expect, it } from "vitest";
import type { MediaJobRecord, ProviderJobInfo } from "../src/index.ts";
import { createInMemoryStudio, testTenant } from "../src/testing/index.ts";

const key = "job:upscale:shot-1";
const intent = (attempt: number, updatedAt: string, state: MediaJobRecord["state"] = "submitting") =>
  ({
    idempotencyKey: key,
    kind: "image",
    model: "atlas:atlascloud/upscaler",
    attempt,
    state,
    estimatedCostCents: 4,
    submittedAt: updatedAt,
    updatedAt,
  }) satisfies MediaJobRecord;

/** Predictions Atlas knows, as `atlas status` reports them. */
const ATLAS: Record<string, ProviderJobInfo> = {
  pred_42: { model: "atlascloud/upscaler", createdAt: "2026-01-01T00:00:06.000Z" },
  pred_old: { model: "atlascloud/upscaler", createdAt: "2025-12-31T23:00:00.000Z" },
  pred_video: { model: "kwaivgi/kling-video", createdAt: "2026-01-01T00:00:06.000Z" },
};

async function stuckJob(records: MediaJobRecord[][], options: { inspector?: boolean } = {}) {
  const inspected: string[] = [];
  const env = createInMemoryStudio({
    providerJobs:
      options.inspector === false
        ? undefined
        : {
            inspectJob: async (job) => {
              inspected.push(job.id);
              return ATLAS[job.id];
            },
          },
  });
  // `job:recover` is a platform operator's: tenant owners and admins do not hold it.
  const ctx = testTenant({ role: "operator" });
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
  return { ...env, ctx, job, input, inspected };
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
    // Every copy of the key is replaced, so no stale copy can win on retry; other keys are untouched.
    expect(first?.mediaJobs).toEqual([mediaJob, expect.objectContaining({ idempotencyKey: "other" })]);
    expect(first?.mediaJobs?.[1]?.state).toBe("submitting");
    expect(second?.mediaJobs).toEqual([mediaJob]);
    // An upstream job is attached once.
    await expect(studio.attachMediaJob(ctx, { ...input, idempotencyKey: "other" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
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
    for (const role of ["editor", "admin", "owner"] as const) {
      const member = { ...stuck.ctx, actor: { type: "user" as const, id: `usr_${role}`, role } };
      await expect(stuck.studio.attachMediaJob(member, stuck.input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
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

  it("refuses a prediction Atlas does not know, that runs another model, or that predates the call", async () => {
    const stuck = await stuckJob([[intent(1, "2026-01-01T00:00:05.000Z")]]);
    const refusals = [];
    for (const predictionId of ["pred_missing", "pred_video", "pred_old"]) {
      refusals.push(
        await stuck.studio.attachMediaJob(stuck.ctx, { ...stuck.input, predictionId }).catch((e) => e),
      );
    }
    // One error for every mismatch, so the answer does not say which predictions exist or what they ran.
    expect(refusals.map((e) => e.code)).toEqual(["VALIDATION", "VALIDATION", "VALIDATION"]);
    expect(new Set(refusals.map((e) => e.message.replace(/pred_\w+/, "")))).toHaveProperty("size", 1);
    expect(stuck.inspected).toEqual(["pred_missing", "pred_video", "pred_old"]);
    const [stage] = await stuck.repos.jobs.listStages(stuck.ctx, stuck.job.id);
    expect(stage?.mediaJobs?.[0]?.state).toBe("submitting");

    // A prediction created a little before the record (clock skew) still matches.
    const skewed = await stuckJob([[intent(1, "2026-01-01T00:01:00.000Z")]]);
    await expect(skewed.studio.attachMediaJob(skewed.ctx, skewed.input)).resolves.toMatchObject({
      mediaJob: { state: "submitted" },
    });
  });

  it("refuses to attach when no provider can check the prediction", async () => {
    const stuck = await stuckJob([[intent(1, "2026-01-01T00:00:05.000Z")]], { inspector: false });
    await expect(stuck.studio.attachMediaJob(stuck.ctx, stuck.input)).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });
});
