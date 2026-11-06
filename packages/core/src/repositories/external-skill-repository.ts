import type {
  ExternalSkill,
  ExternalSkillManifest,
  ExternalSkillStatus,
  ExternalSkillUpstream,
  ExternalSkillVersion,
} from "../entities/external-skill.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export interface RecordExternalSkillVersionInput {
  repository: string;
  path: string;
  commitSha: string;
  contentHash: string;
  name: string;
  description: string;
  manifest: ExternalSkillManifest;
  importKey?: string;
  importedBy: ActorRef;
}

/**
 * - `created`: first import of this repository path; the version is active.
 * - `new_version`: the upstream changed; a new immutable version exists and the active one is unchanged.
 * - `unchanged`: the same commit and content were already imported; nothing was written.
 */
export type RecordExternalSkillVersionResult =
  | { outcome: "created" | "new_version"; skill: ExternalSkill; version: ExternalSkillVersion }
  | { outcome: "unchanged"; skill: ExternalSkill; version: ExternalSkillVersion };

export interface ExternalSkillListQuery extends PageRequest {
  /** Case-insensitive substring of name, description or repository. */
  q?: string;
  status?: ExternalSkillStatus;
  repository?: string;
}

/**
 * Durable, workspace-scoped skill store. Every method is bound to the tenant context, so a skill id from
 * another workspace is simply not found. Versions are never updated or deleted.
 */
export interface ExternalSkillRepository {
  get(ctx: TenantContext, id: string): Promise<ExternalSkill | undefined>;
  findBySource(ctx: TenantContext, repository: string, path: string): Promise<ExternalSkill | undefined>;
  /** Enabled-or-not skills whose name equals `name` (case-insensitive), for name lookups. */
  findByName(ctx: TenantContext, name: string, limit: number): Promise<ExternalSkill[]>;
  list(ctx: TenantContext, query?: ExternalSkillListQuery): Promise<Page<ExternalSkill>>;
  getVersion(ctx: TenantContext, skillId: string, versionId: string): Promise<ExternalSkillVersion | undefined>;
  listVersions(ctx: TenantContext, skillId: string, query?: PageRequest): Promise<Page<ExternalSkillVersion>>;
  /**
   * Atomically upsert the skill for (repository, path) and insert the version unless the same
   * commit and content hash exist. Safe under concurrent imports: one writer creates, the rest see
   * `unchanged`. Appends an audit event for anything written.
   */
  recordVersion(
    ctx: TenantContext,
    input: RecordExternalSkillVersionInput,
  ): Promise<RecordExternalSkillVersionResult>;
  /** Make a stored version the one readers get by default; returns undefined when either id is unknown. */
  activateVersion(
    ctx: TenantContext,
    skillId: string,
    versionId: string,
    actor: ActorRef,
  ): Promise<ExternalSkill | undefined>;
  setStatus(
    ctx: TenantContext,
    skillId: string,
    status: ExternalSkillStatus,
    actor: ActorRef,
  ): Promise<ExternalSkill | undefined>;
  /** Record whether the skill folder still exists upstream (an upstream check result). */
  markUpstream(
    ctx: TenantContext,
    skillId: string,
    upstream: ExternalSkillUpstream,
    actor: ActorRef,
  ): Promise<ExternalSkill | undefined>;
}
