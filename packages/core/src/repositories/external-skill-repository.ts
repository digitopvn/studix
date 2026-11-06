import type {
  ExternalSkill,
  ExternalSkillManifest,
  ExternalSkillSource,
  ExternalSkillUpstreamStatus,
  ExternalSkillVersion,
} from "../entities/external-skill.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export interface RecordExternalSkillVersion {
  source: ExternalSkillSource;
  sourceKey: string;
  commitSha: string;
  ref?: string;
  contentHash: string;
  name: string;
  description: string;
  manifest: ExternalSkillManifest;
  importedBy: ActorRef;
  /** Make the new version active. The first version of a skill is always activated. */
  activate: boolean;
}

/**
 * `created`: first import of this source. `new_version`: changed content, stored as the next immutable
 * version. `unchanged`: this content was imported before; nothing was written.
 */
export type RecordExternalSkillOutcome = "created" | "new_version" | "unchanged";

export interface ExternalSkillListQuery extends PageRequest {
  /** Case-insensitive substring of name or description. */
  query?: string;
  /** `owner/repo`, case-insensitive. */
  repository?: string;
  enabled?: boolean;
}

/**
 * Durable store of imported skills. Every call is tenant scoped by the repository itself; a skill of
 * another workspace is indistinguishable from a missing one.
 */
export interface ExternalSkillRepository {
  /** Idempotent and safe under concurrent callers: the same content is recorded once. */
  recordVersion(
    ctx: TenantContext,
    input: RecordExternalSkillVersion,
  ): Promise<{ skill: ExternalSkill; version: ExternalSkillVersion; outcome: RecordExternalSkillOutcome }>;
  get(ctx: TenantContext, id: string): Promise<ExternalSkill | undefined>;
  findBySourceKey(ctx: TenantContext, sourceKey: string): Promise<ExternalSkill | undefined>;
  /** Skills sharing a name (any source) other than `exceptId`, for collision reporting. */
  findByName(ctx: TenantContext, name: string, exceptId?: string): Promise<ExternalSkill[]>;
  list(ctx: TenantContext, query?: ExternalSkillListQuery): Promise<Page<ExternalSkill>>;
  getVersion(
    ctx: TenantContext,
    skillId: string,
    versionId: string,
  ): Promise<ExternalSkillVersion | undefined>;
  listVersions(ctx: TenantContext, skillId: string, query?: PageRequest): Promise<Page<ExternalSkillVersion>>;
  /** Point the skill at one of its own versions. Returns undefined when skill or version is not found. */
  activateVersion(ctx: TenantContext, skillId: string, versionId: string): Promise<ExternalSkill | undefined>;
  setEnabled(
    ctx: TenantContext,
    skillId: string,
    enabled: boolean,
    by: ActorRef,
  ): Promise<ExternalSkill | undefined>;
  setUpstreamStatus(
    ctx: TenantContext,
    skillId: string,
    status: ExternalSkillUpstreamStatus,
  ): Promise<ExternalSkill | undefined>;
}
