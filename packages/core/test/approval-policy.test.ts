import { describe, expect, it } from "vitest";
import { type ApprovalPolicy, createDefaultApprovalPolicy, decideFailClosed } from "../src/index.ts";
import { testTenant } from "../src/testing/index.ts";

const ctx = testTenant();
const subject = { type: "project" as const, id: "prj_1" };
const policy = createDefaultApprovalPolicy({ costThresholdCents: 1000 });

describe("default approval policy", () => {
  it("always requires approval for publish and delete", async () => {
    expect((await policy.decide(ctx, { action: "publish", subject, estimatedCostCents: 0 })).required).toBe(
      true,
    );
    expect((await policy.decide(ctx, { action: "delete", subject })).required).toBe(true);
  });

  it("gates cost-bearing actions on the threshold and unknown estimates", async () => {
    expect(
      (await policy.decide(ctx, { action: "job.start", subject, estimatedCostCents: 1000 })).required,
    ).toBe(false);
    expect(
      (await policy.decide(ctx, { action: "job.start", subject, estimatedCostCents: 1001 })).required,
    ).toBe(true);
    expect((await policy.decide(ctx, { action: "render.final", subject })).required).toBe(true);
    expect(
      (await policy.decide(ctx, { action: "provider.spend", subject, estimatedCostCents: Number.NaN }))
        .required,
    ).toBe(true);
  });

  it("requires approval for unknown actions", async () => {
    const check = { action: "launch.rocket", subject } as unknown as Parameters<ApprovalPolicy["decide"]>[1];
    expect((await policy.decide(ctx, check)).required).toBe(true);
  });

  it("rejects invalid thresholds", () => {
    expect(() => createDefaultApprovalPolicy({ costThresholdCents: -1 })).toThrow(RangeError);
  });
});

describe("decideFailClosed", () => {
  it("treats policy errors and malformed answers as approval required", async () => {
    const throwing: ApprovalPolicy = { decide: async () => Promise.reject(new Error("policy store down")) };
    const malformed = { decide: async () => ({}) } as unknown as ApprovalPolicy;
    const check = { action: "job.start" as const, subject, estimatedCostCents: 1 };
    expect(await decideFailClosed(throwing, ctx, check)).toEqual({
      required: true,
      reason: "approval policy failed: policy store down",
    });
    expect((await decideFailClosed(malformed, ctx, check)).required).toBe(true);
  });
});
