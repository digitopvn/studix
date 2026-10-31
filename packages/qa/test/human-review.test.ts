import {
  type Approval,
  type ApprovalPolicy,
  type ApprovalRepository,
  createDefaultApprovalPolicy,
  type Job,
  type TenantContext,
} from "@studix/core";
import { StudixError } from "@studix/shared";
import { type ApprovalGateDeps, checkApprovalGate, type StageContext } from "@studix/workflow";
import { describe, expect, it, vi } from "vitest";
import {
  createQaApprovalPolicy,
  createQaStages,
  humanReviewVerdict,
  QA_REVIEW_ACTION,
  resolveQaToolchain,
} from "../src/index.ts";

const ctx: TenantContext = {
  organizationId: "org_1",
  workspaceId: "ws_1",
  actor: { type: "user", id: "usr_1", role: "owner" },
};
const job = { id: "job_1", organizationId: "org_1", workspaceId: "ws_1" } as unknown as Job;
const now = new Date("2026-10-31T07:00:00Z");
const subject = { type: "job" as const, id: job.id };

function approval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: "apr_1",
    organizationId: "org_1",
    workspaceId: "ws_1",
    createdAt: now,
    action: QA_REVIEW_ACTION,
    subject,
    status: "approved",
    reason: "QA human review",
    requestedBy: { type: "system", id: "worker" },
    decidedBy: { type: "user", id: "usr_reviewer" },
    decidedAt: now,
    ...overrides,
  };
}

/** checkApprovalGate with the QA policy over a baseline that would waive a free render. */
function gate(latest: Approval | undefined) {
  const base = createDefaultApprovalPolicy({ costThresholdCents: 1000 });
  const opened = approval({ id: "apr_new", status: "pending", decidedBy: undefined, decidedAt: undefined });
  const deps: ApprovalGateDeps = {
    approvalPolicy: createQaApprovalPolicy(base),
    approvals: { findLatest: vi.fn(async () => latest) } as unknown as ApprovalRepository,
    queue: { requestApproval: vi.fn(async () => ({ status: "created" as const, approval: opened })) },
    clock: { now: () => now },
    approvalTtlMs: 60_000,
  };
  return {
    deps,
    result: () =>
      checkApprovalGate(deps, ctx, job, "worker-1", { action: QA_REVIEW_ACTION, estimatedCostCents: 0 }),
  };
}

describe("QA approval policy", () => {
  it("always requires a person for the final render, even when the base policy would waive it", async () => {
    const base = createDefaultApprovalPolicy({ costThresholdCents: 1000 });
    const check = { action: QA_REVIEW_ACTION, subject, estimatedCostCents: 0 };
    expect((await base.decide(ctx, check)).required).toBe(false);
    expect((await createQaApprovalPolicy(base).decide(ctx, check)).required).toBe(true);
  });

  it("delegates other actions to the base policy and fails closed when it breaks", async () => {
    const broken: ApprovalPolicy = {
      decide: async () => {
        throw new Error("policy store down");
      },
    };
    const decision = await createQaApprovalPolicy(broken).decide(ctx, {
      action: "provider.spend",
      subject,
      estimatedCostCents: 1,
    });
    expect(decision.required).toBe(true);
    expect(decision.reason).toContain("policy store down");
    expect(() => createQaApprovalPolicy(broken, { actions: [] })).toThrow(RangeError);
  });
});

describe("QA human review: no approval, no pass", () => {
  it("parks the job and opens a request when nobody approved yet", async () => {
    const { deps, result } = gate(undefined);
    expect((await result()).status).toBe("waiting");
    expect(deps.queue.requestApproval).toHaveBeenCalledOnce();
  });

  it("does not count an approval decided by an API key (an agent client)", async () => {
    const { result } = gate(approval({ decidedBy: { type: "apiKey", id: "key_agent" } }));
    expect((await result()).status).toBe("waiting");
  });

  it("does not count an expired request", async () => {
    const { result } = gate(
      approval({ status: "pending", decidedBy: undefined, expiresAt: new Date(now.getTime() - 1) }),
    );
    expect((await result()).status).toBe("waiting");
  });

  it("fails the job on a rejection", async () => {
    const { result } = gate(approval({ status: "rejected", comment: "peak clips at 0:12" }));
    await expect(result()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("passes only on a human approval", async () => {
    const { result } = gate(approval());
    expect(await result()).toMatchObject({ status: "approved", approval: { id: "apr_1" } });
  });

  it("verdict names why an approval does not count", () => {
    const expected = { action: QA_REVIEW_ACTION, subject };
    expect(humanReviewVerdict(undefined, expected)).toEqual({ approved: false, reason: "missing" });
    expect(humanReviewVerdict(approval({ status: "pending" }), expected)).toMatchObject({
      reason: "pending",
    });
    expect(humanReviewVerdict(approval({ status: "expired" }), expected)).toMatchObject({
      reason: "expired",
    });
    expect(humanReviewVerdict(approval({ decidedBy: { type: "system", id: "x" } }), expected)).toMatchObject({
      reason: "not_human",
    });
    expect(humanReviewVerdict(approval({ action: "publish" }), expected)).toMatchObject({
      reason: "wrong_action",
    });
    expect(humanReviewVerdict(approval({ subject: { type: "job", id: "job_2" } }), expected)).toMatchObject({
      reason: "wrong_subject",
    });
    expect(humanReviewVerdict(approval(), expected).approved).toBe(true);
  });
});

describe("QA review stage", () => {
  const [, review] = createQaStages({ file: () => "/unused.mp4", run: { toolchain: resolveQaToolchain() } });
  const stage = (a?: Approval) => ({ job, approval: a }) as unknown as StageContext;

  it("is gated by the engine's approval gate for the final render", () => {
    expect(review!.name).toBe("qa_review");
    expect(review!.approval).toEqual({ action: QA_REVIEW_ACTION });
  });

  it("refuses to run without a human approval even if a permissive policy let it through", async () => {
    await expect(review!.run(stage(undefined))).rejects.toBeInstanceOf(StudixError);
    await expect(review!.run(stage(undefined))).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      review!.run(stage(approval({ decidedBy: { type: "apiKey", id: "key_agent" } }))),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("records who approved", async () => {
    expect((await review!.run(stage(approval({ comment: "ok" })))).output).toEqual({
      approvalId: "apr_1",
      approvedBy: "usr_reviewer",
      comment: "ok",
    });
  });

  it("can be left out", () => {
    const stages = createQaStages({
      file: () => "/x",
      run: { toolchain: resolveQaToolchain() },
      review: false,
    });
    expect(stages.map((s) => s.name)).toEqual(["qa_check"]);
  });
});
