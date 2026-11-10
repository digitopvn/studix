import { createManualClock, StudixError } from "@studix/shared";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { STUDIX_TOOLS } from "../src/index.ts";
import { toJobView } from "../src/studio/job-view.ts";
import { createInMemoryStudio, testTenant, withActor } from "../src/testing/index.ts";

const brief = { prompt: "Video giới thiệu thương hiệu cà phê Sương Mai, 15 giây, dọc", language: "vi" };

async function rejects(promise: Promise<unknown>): Promise<StudixError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof StudixError) return err;
    throw err;
  }
  throw new Error("expected a StudixError");
}

describe("StudioService.createVideoProject", () => {
  it("stores an opt-in Claude planner selection on the job and refuses it together with a spec", async () => {
    const { studio, repos } = createInMemoryStudio();
    const ctx = testTenant();
    const planner = { runtime: "claude" as const, providerConnectionId: "pcn_1" };
    const out = await studio.createVideoProject(ctx, { brief, planner });
    const job = await repos.jobs.get(ctx, out.job.id);
    expect(job?.payload).toMatchObject({ projectId: out.project.id, planner });

    const withSpec = await rejects(studio.createVideoProject(ctx, { brief, spec: brandIntro, planner }));
    expect(withSpec.code).toBe("VALIDATION");
    const unknownRuntime = await rejects(
      studio.createVideoProject(ctx, {
        brief,
        planner: { runtime: "gpt", providerConnectionId: "x" } as never,
      }),
    );
    expect(unknownRuntime.code).toBe("VALIDATION");
  });

  it("combines a Claude agent with a workflow pack, keeping both on the job", async () => {
    const { studio, repos } = createInMemoryStudio();
    const ctx = testTenant();
    const agent = {
      runtime: "claude" as const,
      connectionId: "pcn_1",
      provider: "anthropic",
      modelId: "claude-opus-5-5",
    };
    const out = await studio.createVideoProject(ctx, { brief, agent, workflowTemplate: "motion-graphic" });
    const job = await repos.jobs.get(ctx, out.job.id);
    expect(job?.payload).toMatchObject({
      workflowTemplate: "motion-graphic",
      agent,
      planner: { runtime: "claude", providerConnectionId: "pcn_1" },
    });
  });

  it("shows a stage that fell back to its template on the job view", async () => {
    const { studio, repos } = createInMemoryStudio();
    const ctx = testTenant();
    const out = await studio.createVideoProject(ctx, { brief });
    const job = await repos.jobs.get(ctx, out.job.id);
    const stage = (output: Record<string, unknown>) => ({
      name: "motion-graphic.storyboard",
      status: "succeeded",
      attempt: 1,
      output,
    });
    const view = toJobView(
      job as never,
      [
        stage({ source: "template", fallbackReason: "The Claude agent process failed on the worker" }),
        stage({ source: "agent" }),
      ] as never,
    );
    expect(view.stages[0]?.fallback).toBe("The Claude agent process failed on the worker");
    expect(view.stages[1]).not.toHaveProperty("fallback");
  });

  it("carries the agent mode into the job payload and rejects unknown modes", async () => {
    const { studio, repos } = createInMemoryStudio();
    const ctx = testTenant();
    const host = await studio.createVideoProject(ctx, { brief, agentMode: "host" });
    expect((await repos.jobs.get(ctx, host.job.id))?.payload).toMatchObject({ agentMode: "host" });
    const plain = await studio.createVideoProject(ctx, { brief });
    expect((await repos.jobs.get(ctx, plain.job.id))?.payload).not.toHaveProperty("agentMode");
    const bogus = await rejects(studio.createVideoProject(ctx, { brief, agentMode: "cloud" as never }));
    expect(bogus.code).toBe("VALIDATION");
  });

  it("creates a draft project and a queued job with polling hints", async () => {
    const { studio, repos } = createInMemoryStudio();
    const ctx = testTenant();
    const out = await studio.createVideoProject(ctx, { brief });
    expect(out.replayed).toBe(false);
    expect(out.project).toMatchObject({ status: "draft", title: brief.prompt, workspaceId: ctx.workspaceId });
    expect(out.job).toMatchObject({
      status: "queued",
      kind: "video.create",
      projectId: out.project.id,
      progress: 0,
    });
    expect(out.job.budget).toEqual({ limitCents: 500, spentCents: 0 });
    expect(out.next).toEqual([
      expect.objectContaining({ tool: STUDIX_TOOLS.getJob, arguments: { jobId: out.job.id } }),
    ]);
    const audit = await repos.audit.list(ctx, { subjectId: out.project.id });
    expect(audit.items.map((e) => e.action)).toEqual(["project.created"]);
  });

  it("stores a client-supplied spec as version 1", async () => {
    const { studio } = createInMemoryStudio();
    const ctx = testTenant();
    const out = await studio.createVideoProject(ctx, { brief, spec: brandIntro });
    const details = await studio.getProject(ctx, out.project.id);
    expect(details.currentVersion).toMatchObject({ version: 1, source: "client" });
    expect(details.currentVersion?.ir.title).toBe(brandIntro.title);
    expect(details.jobs.map((j) => j.id)).toEqual([out.job.id]);
  });

  it("rejects invalid briefs and specs with structured issues", async () => {
    const { studio } = createInMemoryStudio();
    const ctx = testTenant();
    const badBrief = await rejects(studio.createVideoProject(ctx, { brief: { prompt: "" } }));
    expect(badBrief.code).toBe("VALIDATION");
    const badSpec = await rejects(
      studio.createVideoProject(ctx, {
        brief,
        spec: { ...brandIntro, format: { ...brandIntro.format, durationMs: 1 } },
      }),
    );
    expect(badSpec.code).toBe("VALIDATION");
    expect(badSpec.details?.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "timeline" })]),
    );
    expect((await studio.listProjects(ctx)).items).toHaveLength(0);
  });

  it("is idempotent per workspace", async () => {
    const { studio } = createInMemoryStudio();
    const ctx = testTenant();
    const first = await studio.createVideoProject(ctx, { brief, idempotencyKey: "req-1" });
    const second = await studio.createVideoProject(ctx, { brief, idempotencyKey: "req-1" });
    expect(second.replayed).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(second.project.id).toBe(first.project.id);
    expect((await studio.listProjects(ctx)).items).toHaveLength(1);

    const otherTenant = testTenant();
    const third = await studio.createVideoProject(otherTenant, { brief, idempotencyKey: "req-1" });
    expect(third.replayed).toBe(false);
    expect(third.job.id).not.toBe(first.job.id);
  });

  it("requires project:write", async () => {
    const { studio } = createInMemoryStudio();
    const viewer = testTenant({ role: "viewer" });
    expect((await rejects(studio.createVideoProject(viewer, { brief }))).code).toBe("FORBIDDEN");
    const readOnlyKey = testTenant({ scopes: ["project:read"] });
    expect((await rejects(studio.createVideoProject(readOnlyKey, { brief }))).code).toBe("FORBIDDEN");
  });

  it("gives a skill-agent job an hour that starts when the job is claimed", async () => {
    const { studio, repos } = createInMemoryStudio();
    const ctx = testTenant();
    const out = await studio.createVideoProject(ctx, { brief, workflowTemplate: "skill-agent" });
    const job = await repos.jobs.get(ctx, out.job.id);
    expect(job?.deadlineAt).toBeUndefined();
    expect(job?.deadlineRemainingMs).toBe(60 * 60_000);
    const plain = await repos.jobs.get(ctx, (await studio.createVideoProject(ctx, { brief })).job.id);
    expect(plain?.deadlineAt).toBeUndefined();
    expect(plain?.deadlineRemainingMs).toBeGreaterThan(0);
    const explicit = await studio.createVideoProject(ctx, {
      brief,
      deadlineAt: new Date(Date.now() + 5 * 60_000),
    });
    expect((await repos.jobs.get(ctx, explicit.job.id))?.deadlineAt).toBeInstanceOf(Date);
  });

  it("tells a queued job what it waits behind", async () => {
    const { studio } = createInMemoryStudio();
    const ctx = testTenant();
    const first = await studio.createVideoProject(ctx, { brief });
    const second = await studio.createVideoProject(ctx, { brief });
    const view = await studio.getJob(ctx, second.job.id);
    expect(view.queue?.ahead).toBe(1);
    expect(view.queue?.reason).toContain("1 queued job(s)");
    expect((await studio.getJob(ctx, first.job.id)).queue?.ahead).toBe(0);
  });

  it("rejects deadlines in the past", async () => {
    const { studio } = createInMemoryStudio();
    const err = await rejects(
      studio.createVideoProject(testTenant(), { brief, deadlineAt: new Date("2020-01-01") }),
    );
    expect(err.code).toBe("VALIDATION");
  });
});

describe("high-cost jobs wait for approval", () => {
  it("parks the job, then resumes it when a reviewer approves", async () => {
    const { studio, repos } = createInMemoryStudio({ approvalCostThresholdCents: 100 });
    const ctx = testTenant({ role: "editor" });
    const out = await studio.createVideoProject(ctx, { brief, budgetCents: 5000 });
    expect(out.job.status).toBe("waiting_approval");
    expect(out.approval).toMatchObject({
      status: "pending",
      action: "job.start",
      subject: { type: "job", id: out.job.id },
    });
    expect(out.next[0]).toMatchObject({ tool: STUDIX_TOOLS.getJob, arguments: { jobId: out.job.id } });

    const editorTry = await rejects(
      studio.approve(ctx, { approvalId: out.approval!.id, decision: "approved" }),
    );
    expect(editorTry.code).toBe("FORBIDDEN");

    // An API key with the decide permission still cannot clear its own cost gate.
    const agentKey = withActor(ctx, { type: "apiKey", id: "key_1", scopes: ["approval:decide"] });
    const keyTry = await rejects(
      studio.approve(agentKey, { approvalId: out.approval!.id, decision: "approved" }),
    );
    expect(keyTry.code).toBe("FORBIDDEN");
    expect((await studio.getJob(ctx, out.job.id)).status).toBe("waiting_approval");

    const reviewer = withActor(ctx, { type: "user", id: "usr_reviewer", role: "reviewer" });
    const approved = await studio.approve(reviewer, { approvalId: out.approval!.id, decision: "approved" });
    expect(approved).toMatchObject({ status: "approved", decidedBy: { type: "user", id: "usr_reviewer" } });
    expect((await studio.getJob(ctx, out.job.id)).status).toBe("queued");

    const again = await rejects(
      studio.approve(reviewer, { approvalId: out.approval!.id, decision: "rejected" }),
    );
    expect(again.code).toBe("CONFLICT");
    const actions = (await repos.audit.list(ctx)).items.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["approval.requested", "approval.approved"]));
  });

  it("cancels the job when the approval is rejected", async () => {
    const { studio } = createInMemoryStudio({ approvalCostThresholdCents: 100 });
    const ctx = testTenant();
    const out = await studio.createVideoProject(ctx, { brief, budgetCents: 5000 });
    await studio.approve(ctx, {
      approvalId: out.approval!.id,
      decision: "rejected",
      comment: "too expensive",
    });
    const job = await studio.getJob(ctx, out.job.id);
    expect(job.status).toBe("cancelled");
    expect(job.next).toEqual([]);
  });

  it("expires stale approval requests", async () => {
    const clock = createManualClock(new Date("2026-01-01T00:00:00Z"));
    const { studio } = createInMemoryStudio({
      clock,
      approvalCostThresholdCents: 0,
      defaults: { approvalTtlMs: 1000 },
    });
    const ctx = testTenant();
    const out = await studio.createVideoProject(ctx, { brief, budgetCents: 10 });
    clock.advance(2000);
    const err = await rejects(studio.approve(ctx, { approvalId: out.approval!.id, decision: "approved" }));
    expect(err.code).toBe("CONFLICT");
    expect((await studio.getJob(ctx, out.job.id)).status).toBe("waiting_approval");
  });

  it("fails closed when the approval policy errors", async () => {
    const { studio } = createInMemoryStudio({
      approvalPolicy: { decide: () => Promise.reject(new Error("down")) },
    });
    const out = await studio.createVideoProject(testTenant(), { brief });
    expect(out.job.status).toBe("waiting_approval");
  });
});
