import type {
  ExternalSkill,
  ExternalSkillManifest,
  ExternalSkillScope,
  ExternalSkillSource,
  ExternalSkillStatus,
  ExternalSkillUpstreamStatus,
  ExternalSkillVersion,
  SkillRiskReport,
} from "../entities/external-skill.ts";
import type { ActorRef, TenantContext } from "../tenant.ts";
import type { Page, PageRequest } from "./pagination.ts";

export interface RecordExternalSkillImport {
  sourceKey: string;
  source: ExternalSkillSource;
  skillId: string;
  versionId: string;
  name: string;
  description: string;
  commitSha: string;
  contentHash: string;
  manifest: ExternalSkillManifest;
  storagePrefix: string;
  importKey?: string;
  /** Scope of a newly created skill; an existing skill keeps its own. */
  scope: ExternalSkillScope;
  risk: SkillRiskReport;
  /** Status of a newly created skill (default enabled); a high-risk first version starts disabled. */
  initialStatus?: ExternalSkillStatus;
  /** Make this version the one readers get even when the skill already has an active one. */
  activate?: boolean;
  actor: ActorRef;
}

export type ExternalSkillImportOutcome =
  | { outcome: "created" | "new_version"; skill: ExternalSkill; version: ExternalSkillVersion }
  /** The skill already has a version with this content hash; nothing was written. */
  | { outcome: "unchanged"; skill: ExternalSkill; version: ExternalSkillVersion };

export interface ExternalSkillListQuery extends PageRequest {
  /** Default: enabled skills only. */
  status?: ExternalSkillStatus | "all";
  /** Case-insensitive substring of name, description or `owner/repo`. */
  q?: string;
  owner?: string;
  repo?: string;
  /**
   * `workspace` (default): the context's own skills. `platform`: platform skills only, whichever workspace
   * holds them. `visible`: both, as one list.
   */
  scope?: ExternalSkillScope | "visible";
}

/** Extra audit fields for a mutation, e.g. an explicit high-risk confirmation. */
export type ExternalSkillAuditData = Record<string, unknown>;

/** Every method is scoped to the context's workspace; mutations append an audit event atomically. */
export interface ExternalSkillRepository {
  get(ctx: TenantContext, id: string): Promise<ExternalSkill | undefined>;
  /** A platform-scope skill by id, whichever workspace holds it. The only cross-workspace read by id. */
  getPlatform(id: string): Promise<ExternalSkill | undefined>;
  findBySourceKey(ctx: TenantContext, sourceKey: string): Promise<ExternalSkill | undefined>;
  findByName(ctx: TenantContext, name: string): Promise<ExternalSkill[]>;
  list(ctx: TenantContext, query?: ExternalSkillListQuery): Promise<Page<ExternalSkill>>;
  getVersion(
    ctx: TenantContext,
    skillId: string,
    versionId: string,
  ): Promise<ExternalSkillVersion | undefined>;
  listVersions(ctx: TenantContext, skillId: string, query?: PageRequest): Promise<Page<ExternalSkillVersion>>;
  findVersionByContentHash(
    ctx: TenantContext,
    skillId: string,
    contentHash: string,
  ): Promise<ExternalSkillVersion | undefined>;
  findVersionByImportKey(ctx: TenantContext, importKey: string): Promise<ExternalSkillVersion | undefined>;
  /**
   * Create the skill (first import of its source) or add an immutable version to it, in one transaction.
   * The first version becomes active; later ones only with `activate`. Concurrent calls for one source
   * serialize, so identical content is written once and the rest report `unchanged`.
   */
  recordImport(ctx: TenantContext, input: RecordExternalSkillImport): Promise<ExternalSkillImportOutcome>;
  activateVersion(
    ctx: TenantContext,
    skillId: string,
    versionId: string,
    actor: ActorRef,
    audit?: ExternalSkillAuditData,
  ): Promise<ExternalSkill>;
  setStatus(
    ctx: TenantContext,
    skillId: string,
    status: ExternalSkillStatus,
    actor: ActorRef,
    audit?: ExternalSkillAuditData,
  ): Promise<ExternalSkill>;
  /** Delete the skill and all its versions; returns the storage prefixes the caller must clear. */
  delete(ctx: TenantContext, skillId: string, actor: ActorRef): Promise<{ storagePrefixes: string[] }>;
  recordUpstreamCheck(
    ctx: TenantContext,
    skillId: string,
    status: ExternalSkillUpstreamStatus,
    actor: ActorRef,
  ): Promise<ExternalSkill>;
}
