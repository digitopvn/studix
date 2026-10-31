import { type Clock, createManualClock, newId } from "@studix/shared";
import type { ApprovalPolicy } from "../ports/approval-policy.ts";
import { createDefaultApprovalPolicy } from "../ports/approval-policy.ts";
import { StudioService } from "../studio/studio-service.ts";
import type { StudioDefaults } from "../studio/studio-types.ts";
import type { Actor, Permission, Role, TenantContext } from "../tenant.ts";
import {
  createInMemoryActivityRepository,
  createInMemoryApprovalRepository,
  createInMemoryAuditRepository,
  createInMemoryReviewRepository,
  createInMemoryUsageRepository,
} from "./in-memory-governance-repositories.ts";
import {
  createInMemoryJobStore,
  createInMemoryRenderRepository,
  createInMemoryWorkflowRunRepository,
} from "./in-memory-job-repositories.ts";
import {
  createInMemoryAssetRepository,
  createInMemoryProjectRepository,
} from "./in-memory-project-repositories.ts";
import { createInMemoryRevisionRepository } from "./in-memory-revision-repositories.ts";
import { createInMemoryStoryboardRepository } from "./in-memory-storyboard-repository.ts";
import { createInMemoryTenancy } from "./in-memory-tenancy.ts";

export * from "./in-memory-governance-repositories.ts";
export * from "./in-memory-job-repositories.ts";
export * from "./in-memory-project-repositories.ts";
export * from "./in-memory-revision-repositories.ts";
export * from "./in-memory-storyboard-repository.ts";
export * from "./in-memory-table.ts";
export * from "./in-memory-tenancy.ts";

/** Build a tenant context for tests. Defaults to a fresh org/workspace and an owner user. */
export function testTenant(
  options: {
    organizationId?: string;
    workspaceId?: string;
    actor?: Actor;
    role?: Role;
    scopes?: Permission[];
  } = {},
): TenantContext {
  const actor: Actor =
    options.actor ??
    (options.scopes
      ? { type: "apiKey", id: newId("key"), scopes: options.scopes }
      : { type: "user", id: newId("usr"), role: options.role ?? "owner" });
  return {
    organizationId: options.organizationId ?? newId("org"),
    workspaceId: options.workspaceId ?? newId("ws"),
    actor,
  };
}

/** Same tenant, different actor. */
export function withActor(ctx: TenantContext, actor: Actor): TenantContext {
  return { ...ctx, actor };
}

export interface InMemoryStudioOptions {
  clock?: Clock;
  approvalPolicy?: ApprovalPolicy;
  approvalCostThresholdCents?: number;
  defaults?: Partial<StudioDefaults>;
}

/** Complete in-memory wiring of every repository plus a StudioService over them. */
export function createInMemoryStudio(options: InMemoryStudioOptions = {}) {
  const clock = options.clock ?? createManualClock(new Date("2026-01-01T00:00:00Z"));
  const { jobs, queue } = createInMemoryJobStore(clock);
  const projects = createInMemoryProjectRepository(clock);
  const repos = {
    projects,
    revisions: createInMemoryRevisionRepository(clock, projects),
    storyboards: createInMemoryStoryboardRepository(clock, projects),
    assets: createInMemoryAssetRepository(clock),
    jobs,
    queue,
    renders: createInMemoryRenderRepository(clock),
    workflowRuns: createInMemoryWorkflowRunRepository(clock),
    approvals: createInMemoryApprovalRepository(clock),
    reviews: createInMemoryReviewRepository(clock),
    audit: createInMemoryAuditRepository(clock),
    usage: createInMemoryUsageRepository(clock),
    activity: createInMemoryActivityRepository(clock),
    ...createInMemoryTenancy(clock),
  };
  const approvalPolicy =
    options.approvalPolicy ??
    createDefaultApprovalPolicy({ costThresholdCents: options.approvalCostThresholdCents ?? 1000 });
  const studio = new StudioService({ ...repos, approvalPolicy, clock, defaults: options.defaults });
  return { clock, repos, approvalPolicy, studio };
}
