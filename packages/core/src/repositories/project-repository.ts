import type { NewRecord } from "../entities/common.ts";
import type { ProjectStatus, ProjectVersion, VideoProject } from "../entities/project.ts";
import type { TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export type NewVideoProject = NewRecord<VideoProject>;
export type VideoProjectPatch = Partial<Pick<VideoProject, "title" | "status" | "currentVersionId">>;
/**
 * `version` is assigned by the repository (previous max + 1).
 * With `advanceFrom`, the repository makes the new version the project's current one in the same atomic step,
 * but only while `advanceFrom` is still current; otherwise it throws CONFLICT and stores nothing.
 * An `idempotencyKey` already used by another version of the project is also a CONFLICT.
 */
export type NewProjectVersion = Omit<NewRecord<ProjectVersion>, "version"> & { advanceFrom?: string };

export interface ProjectRepository {
  create(ctx: TenantContext, input: NewVideoProject): Promise<VideoProject>;
  get(ctx: TenantContext, id: string): Promise<VideoProject | undefined>;
  list(ctx: TenantContext, query?: PageRequest & { status?: ProjectStatus }): Promise<Page<VideoProject>>;
  /** Throws NOT_FOUND when the project is not in the tenant. */
  update(ctx: TenantContext, id: string, patch: VideoProjectPatch): Promise<VideoProject>;
  /** Hard delete with versions; returns false when nothing was deleted. */
  delete(ctx: TenantContext, id: string): Promise<boolean>;
  createVersion(ctx: TenantContext, input: NewProjectVersion): Promise<ProjectVersion>;
  getVersion(ctx: TenantContext, versionId: string): Promise<ProjectVersion | undefined>;
  /** The version of the project created with this idempotency key. */
  findVersionByIdempotencyKey(
    ctx: TenantContext,
    projectId: string,
    idempotencyKey: string,
  ): Promise<ProjectVersion | undefined>;
  /** Newest version first. */
  listVersions(ctx: TenantContext, projectId: string, query?: PageRequest): Promise<Page<ProjectVersion>>;
}
