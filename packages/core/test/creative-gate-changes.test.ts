import { StudixError } from "@studix/shared";
import type { VideoIR } from "@studix/video-ir";
import brandIntro from "@studix/video-ir/fixtures/brand-intro-9x16.json" with { type: "json" };
import { describe, expect, it } from "vitest";
import { createInMemoryStudio, testTenant, withActor } from "../src/testing/index.ts";

/** `run` may throw before it returns a promise (input validation), so it is called inside the try. */
async function rejects(run: () => Promise<unknown>): Promise<StudixError> {
  try {
    await run();
  } catch (err) {
    if (err instanceof StudixError) return err;
    throw err;
  }
  throw new Error("expected a StudixError");
}

/** The brand-intro fixture with one generated design shown by `feature-2`. */
function boardIr(): VideoIR {
  const ir = structuredClone(brandIntro) as VideoIR;
  ir.assets = [
    {
      id: "hero-sheet-v1",
      kind: "image",
      storageKey: "generated/job/designs/hero-sheet-v1.png",
      sha256: "a".repeat(64),
      mime: "image/png",
      provenance: { source: "generated", provider: "fake", model: "fake-image", prompt: "hero" },
    },
  ];
  const feature = ir.scenes[2] as VideoIR["scenes"][number];
  const old = feature.shots[1] as VideoIR["scenes"][number]["shots"][number];
  feature.shots[1] = {
    id: old.id,
    type: "image",
    startMs: old.startMs,
    durationMs: old.durationMs,
    assetId: "hero-sheet-v1",
    alt: "Hero model sheet",
  };
  return ir;
}

async function setup() {
  const env = createInMemoryStudio();
  const ctx = testTenant();
  const { project } = await env.studio.createVideoProject(ctx, {
    brief: { prompt: "Hero" },
    spec: boardIr(),
  });
  const { job } = await env.repos.queue.enqueue(ctx, {
    kind: "video.create",
    projectId: project.id,
    payload: { projectId: project.id },
    createdBy: { type: "user", id: "u" },
  });
  await env.repos.jobs.update(ctx, job.id, { status: "waiting_approval" });
  const gate = await env.repos.approvals.create(ctx, {
    action: "creative.gate",
    subject: { type: "job", id: job.id },
    scopeKey: "gate:G1",
    reason: "G1: designs",
    requestedBy: { type: "system", id: "worker" },
    expiresAt: new Date(Date.now() + 3_600_000),
  });
  const reviewer = withActor(ctx, { type: "user", id: "usr_rev", role: "reviewer" });
  const agent = withActor(ctx, { type: "apiKey", id: "key_1", scopes: ["project:write", "approval:decide"] });
  return { ...env, ctx, project, job, gate, reviewer, agent };
}

/** The design, the shot showing it, its scene, and the timeline document listing the shot. */
const INVALIDATED = ["asset:hero-sheet-v1", "document", "scene:feature", "shot:feature-2"];

describe("changes requested on a creative gate", () => {
  it("a reviewer sends the gate back with targets and a note, and gets the invalidated set", async () => {
    const { studio, repos, ctx, gate, reviewer } = await setup();
    const decided = await studio.approve(reviewer, {
      approvalId: gate.id,
      decision: "changes_requested",
      targets: ["hero-sheet-v1"],
      comment: "Shoulder-length hair",
    });
    expect(decided.status).toBe("changes_requested");
    expect(decided.decidedBy).toEqual({ type: "user", id: "usr_rev" });
    expect(decided.changes).toEqual({
      targets: ["hero-sheet-v1"],
      note: "Shoulder-length hair",
      invalidated: INVALIDATED,
    });
    const audit = await repos.audit.list(ctx, { subjectId: gate.subject.id });
    expect(audit.items.map((e) => e.action)).toContain("approval.changes_requested");
  });

  it("validates targets, the note and the action", async () => {
    const { studio, repos, ctx, gate, job, reviewer } = await setup();
    const change = { approvalId: gate.id, decision: "changes_requested" as const, comment: "fix" };
    expect((await rejects(() => studio.approve(reviewer, change))).code).toBe("VALIDATION");
    expect((await rejects(() => studio.approve(reviewer, { ...change, targets: ["missing"] }))).code).toBe(
      "VALIDATION",
    );
    expect(
      (
        await rejects(() =>
          studio.approve(reviewer, { ...change, comment: undefined, targets: ["hero-sheet-v1"] }),
        )
      ).code,
    ).toBe("VALIDATION");
    expect(
      (
        await rejects(() =>
          studio.approve(reviewer, { approvalId: gate.id, decision: "approved", targets: ["x"] }),
        )
      ).code,
    ).toBe("VALIDATION");
    const publish = await repos.approvals.create(ctx, {
      action: "publish",
      subject: { type: "job", id: job.id },
      reason: "publish",
      requestedBy: { type: "system", id: "worker" },
    });
    expect(
      (
        await rejects(() =>
          studio.approve(reviewer, { ...change, approvalId: publish.id, targets: ["hero-sheet-v1"] }),
        )
      ).code,
    ).toBe("VALIDATION");
    expect((await repos.approvals.get(ctx, gate.id))?.status).toBe("pending");
  });

  it("an API key cannot decide through approve, even to request changes", async () => {
    const { studio, gate, agent } = await setup();
    const err = await rejects(() =>
      studio.approve(agent, {
        approvalId: gate.id,
        decision: "changes_requested",
        targets: ["hero-sheet-v1"],
        comment: "fix",
      }),
    );
    expect(err.code).toBe("FORBIDDEN");
  });

  it("feedback on a design while its job waits at the gate requests the change", async () => {
    const { studio, repos, ctx, project, gate, job, agent } = await setup();
    const out = await studio.submitFeedback(agent, {
      projectId: project.id,
      assetId: "hero-sheet-v1",
      comment: "Yellow bow on her left in every view",
    });
    expect(out.approval).toMatchObject({
      id: gate.id,
      status: "changes_requested",
      decidedBy: { type: "apiKey", id: "key_1" },
      changes: { targets: ["hero-sheet-v1"], note: "Yellow bow on her left in every view" },
    });
    expect(out.invalidated).toEqual(INVALIDATED);
    expect(out.next[0]).toMatchObject({ tool: "studix_get_job", arguments: { jobId: job.id } });
    // The note is kept as a comment on the version too.
    expect((await repos.reviews.get(ctx, out.feedbackId))?.targetId).toBe("asset:hero-sheet-v1");
  });

  it("feedback without a waiting gate, or on a shot, stays a comment", async () => {
    const { studio, repos, ctx, project, gate, job, agent } = await setup();
    const onShot = await studio.submitFeedback(agent, {
      projectId: project.id,
      shotId: "feature-2",
      comment: "nice",
    });
    expect(onShot.approval).toBeUndefined();
    await repos.jobs.update(ctx, job.id, { status: "running" });
    const parkedElsewhere = await studio.submitFeedback(agent, {
      projectId: project.id,
      assetId: "hero-sheet-v1",
      comment: "later",
    });
    expect(parkedElsewhere.approval).toBeUndefined();
    expect((await repos.approvals.get(ctx, gate.id))?.status).toBe("pending");
  });

  it("approve and reject are unchanged", async () => {
    const { studio, gate, reviewer } = await setup();
    const approved = await studio.approve(reviewer, {
      approvalId: gate.id,
      decision: "approved",
      comment: "ok",
    });
    expect(approved).toMatchObject({ status: "approved", comment: "ok" });
    expect(approved.changes).toBeUndefined();
    expect(
      (await rejects(() => studio.approve(reviewer, { approvalId: gate.id, decision: "rejected" }))).code,
    ).toBe("CONFLICT");
  });
});
