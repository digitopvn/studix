import { type Clock, systemClock } from "@studix/shared";
import type { StudixDb } from "../client.ts";
import { createAgentHandoffRepository } from "./agent-handoff-repository.ts";
import { createAssetRepository } from "./asset-repository.ts";
import { createConnectorRepository } from "./connector-repository.ts";
import { createExternalSkillRepository } from "./external-skill-repository.ts";
import {
  createApprovalRepository,
  createAuditRepository,
  createReviewRepository,
} from "./governance-repositories.ts";
import { createJobStore } from "./job-repository.ts";
import {
  createModelPreferenceRepository,
  createModelSnapshotRepository,
} from "./model-preference-repository.ts";
import { createProjectRepository } from "./project-repository.ts";
import { createProviderConnectionRepository } from "./provider-connection-repository.ts";
import { createRateLimitRepository } from "./rate-limit-repository.ts";
import { createRenderRepository, createWorkflowRunRepository } from "./render-workflow-repositories.ts";
import { createRevisionRepository, createStageCacheRepository } from "./revision-repositories.ts";
import { createStoryboardRepository } from "./storyboard-repository.ts";
import { createActivityRepository, createUsageRepository } from "./telemetry-repositories.ts";
import {
  createApiKeyRepository,
  createTenantDirectory,
  createWorkspaceRepository,
} from "./tenancy-repositories.ts";
import { createWorkspaceSettingsRepository } from "./workspace-settings-repository.ts";

export * from "./agent-handoff-repository.ts";
export * from "./asset-repository.ts";
export * from "./connector-repository.ts";
export * from "./external-skill-repository.ts";
export * from "./governance-repositories.ts";
export * from "./job-repository.ts";
export * from "./model-preference-repository.ts";
export * from "./project-repository.ts";
export * from "./provider-connection-repository.ts";
export * from "./rate-limit-repository.ts";
export * from "./render-workflow-repositories.ts";
export * from "./revision-repositories.ts";
export * from "./storyboard-repository.ts";
export * from "./telemetry-repositories.ts";
export * from "./tenancy-repositories.ts";
export * from "./workspace-settings-repository.ts";

/** Every Postgres repository (plus the producer-side job queue) over one database handle. */
export function createRepositories(db: StudixDb, options: { clock?: Clock } = {}) {
  const clock = options.clock ?? systemClock;
  const { jobs, queue } = createJobStore(db, clock);
  return {
    directory: createTenantDirectory(db, clock),
    workspaces: createWorkspaceRepository(db, clock),
    apiKeys: createApiKeyRepository(db, clock),
    projects: createProjectRepository(db, clock),
    assets: createAssetRepository(db, clock),
    jobs,
    queue,
    renders: createRenderRepository(db, clock),
    workflowRuns: createWorkflowRunRepository(db, clock),
    revisions: createRevisionRepository(db, clock),
    stageCache: createStageCacheRepository(db, clock),
    storyboards: createStoryboardRepository(db, clock),
    agentHandoffs: createAgentHandoffRepository(db, clock),
    approvals: createApprovalRepository(db, clock),
    reviews: createReviewRepository(db, clock),
    audit: createAuditRepository(db, clock),
    usage: createUsageRepository(db, clock),
    activity: createActivityRepository(db, clock),
    connectors: createConnectorRepository(db, clock),
    externalSkills: createExternalSkillRepository(db, clock),
    providerConnections: createProviderConnectionRepository(db, clock),
    modelPreferences: createModelPreferenceRepository(db, clock),
    modelSnapshots: createModelSnapshotRepository(db, clock),
    rateLimits: createRateLimitRepository(db),
    workspaceSettings: createWorkspaceSettingsRepository(db),
  };
}

export type StudixRepositories = ReturnType<typeof createRepositories>;
