import { type Clock, systemClock } from "@studix/shared";
import type { StudixDb } from "../client.ts";
import { createAssetRepository } from "./asset-repository.ts";
import { createConnectorRepository } from "./connector-repository.ts";
import {
  createApprovalRepository,
  createAuditRepository,
  createReviewRepository,
} from "./governance-repositories.ts";
import { createJobStore } from "./job-repository.ts";
import { createProjectRepository } from "./project-repository.ts";
import {
  createModelPreferenceRepository,
  createProviderConnectionRepository,
  createSealedCredentialStore,
} from "./provider-repositories.ts";
import { createRenderRepository, createWorkflowRunRepository } from "./render-workflow-repositories.ts";
import { createActivityRepository, createUsageRepository } from "./telemetry-repositories.ts";
import {
  createApiKeyRepository,
  createTenantDirectory,
  createWorkspaceRepository,
} from "./tenancy-repositories.ts";

export * from "./asset-repository.ts";
export * from "./connector-repository.ts";
export * from "./governance-repositories.ts";
export * from "./job-repository.ts";
export * from "./project-repository.ts";
export * from "./provider-repositories.ts";
export * from "./render-workflow-repositories.ts";
export * from "./telemetry-repositories.ts";
export * from "./tenancy-repositories.ts";

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
    approvals: createApprovalRepository(db, clock),
    reviews: createReviewRepository(db, clock),
    audit: createAuditRepository(db, clock),
    usage: createUsageRepository(db, clock),
    activity: createActivityRepository(db, clock),
    connectors: createConnectorRepository(db, clock),
    providerConnections: createProviderConnectionRepository(db, clock),
    modelPreferences: createModelPreferenceRepository(db, clock),
    sealedCredentials: createSealedCredentialStore(db, clock),
  };
}

export type StudixRepositories = ReturnType<typeof createRepositories>;
