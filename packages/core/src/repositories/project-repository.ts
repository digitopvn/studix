import type { NewRecord } from "../entities/common.ts";
import type { ProjectStatus, ProjectVersion, VideoProject } from "../entities/project.ts";
import type { TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export type NewVideoProject = NewRecord<VideoProject>;
export type VideoProjectPatch = Partial<Pick<VideoProject, "title" | "status" | "currentVersionId">>;
/** `version` is assigned by the repository (previous max + 1). */
export type NewProjectVersion = Omit<NewRecord<ProjectVersion>, "version"> & {
  /**
   * Compare-and-set guard: when present, the version only becomes the project's current one if the
   * project's `currentVersionId` still equals this value (checked and swapped atomically with the insert).
   * Otherwise nothing is written and a CONFLICT is thrown, so of two writers on the same base only one wins.
   */
  advanceFromVersionId?: string;
};

export interface ProjectRepository {
  create(ctx: TenantContext, input: NewVideoProject): Promise<VideoProject>;
  get(ctx: TenantContext, id: string): Promise<VideoProject | undefined>;
  list(ctx: TenantContext, query?: PageRequest & { status?: ProjectStatus }): Promise<Page<VideoProject>>;
  /** Throws NOT_FOUND when the project is not in the tenant. */
  update(ctx: TenantContext, id: string, patch: VideoProjectPatch): Promise<VideoProject>;
  /** Hard delete with versions; returns false when nothing was deleted. */
  delete(ctx: TenantContext, id: string): Promise<boolean>;
  /** Stores the version; with `advanceFromVersionId` it also makes it current atomically (see NewProjectVersion). */
  createVersion(ctx: TenantContext, input: NewProjectVersion): Promise<ProjectVersion>;
  getVersion(ctx: TenantContext, versionId: string): Promise<ProjectVersion | undefined>;
  /** Newest version first. */
  listVersions(ctx: TenantContext, projectId: string, query?: PageRequest): Promise<Page<ProjectVersion>>;
}
