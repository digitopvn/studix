import type {
  ExternalSkill,
  ExternalSkillManifest,
  ExternalSkillVersion,
  UpstreamStatus,
} from "../entities/external-skill.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export interface ImportVersionInput {
  /** Used only when the skill does not exist yet. */
  skillId?: string;
  versionId?: string;
  repository: string;
  skillPath: string;
  commitSha: string;
  contentHash: string;
  name: string;
  description: string;
  manifest: ExternalSkillManifest;
  skillStorageKey: string;
  createdBy: ActorRef;
}

export interface ImportVersionResult {
  skill: ExternalSkill;
  version: ExternalSkillVersion;
  /** `created`: a new immutable version. `unchanged`: the same content was already stored. */
  outcome: "created" | "unchanged";
  skillCreated: boolean;
  /** True when this version became the skill's active version (the first one always does). */
  activated: boolean;
}

export interface ExternalSkillListQuery extends PageRequest {
  /** Case-insensitive match on name, description or repository. */
  query?: string;
  repository?: string;
  enabled?: boolean;
}

/** Every method is scoped to the context's workspace; a skill id of another workspace is simply not found. */
export interface ExternalSkillRepository {
  get(ctx: TenantContext, skillId: string): Promise<ExternalSkill | undefined>;
  findBySource(ctx: TenantContext, repository: string, skillPath: string): Promise<ExternalSkill | undefined>;
  list(ctx: TenantContext, query?: ExternalSkillListQuery): Promise<Page<ExternalSkill>>;
  getVersion(
    ctx: TenantContext,
    skillId: string,
    versionId: string,
  ): Promise<ExternalSkillVersion | undefined>;
  listVersions(ctx: TenantContext, skillId: string, query?: PageRequest): Promise<Page<ExternalSkillVersion>>;
  /**
   * Store a version atomically: create the skill when needed, insert the version unless the same content
   * hash exists, and make it active only when the skill had no active version. Concurrent calls with the
   * same content converge on one skill and one version.
   */
  importVersion(ctx: TenantContext, input: ImportVersionInput): Promise<ImportVersionResult>;
  /** Make an existing version the active one; refreshes the skill's name and description from it. */
  activateVersion(ctx: TenantContext, skillId: string, versionId: string): Promise<ExternalSkill | undefined>;
  setEnabled(ctx: TenantContext, skillId: string, enabled: boolean): Promise<ExternalSkill | undefined>;
  recordUpstreamCheck(
    ctx: TenantContext,
    skillId: string,
    check: { status: UpstreamStatus; checkedAt: Date; commitSha?: string },
  ): Promise<ExternalSkill | undefined>;
}
