import type { ActorRef, TenantOwned } from "./common.ts";

export const EXTERNAL_SKILL_STATUSES = ["enabled", "disabled"] as const;
export type ExternalSkillStatus = (typeof EXTERNAL_SKILL_STATUSES)[number];

/**
 * What the last upstream check found for the skill's source: `unchecked` (never), `current` (the newest
 * imported version matches upstream), `changed` (upstream differs), `removed` (the path or repository is
 * gone upstream), `invalid` (upstream no longer parses as a valid skill).
 */
export const EXTERNAL_SKILL_UPSTREAM_STATUSES = [
  "unchecked",
  "current",
  "changed",
  "removed",
  "invalid",
] as const;
export type ExternalSkillUpstreamStatus = (typeof EXTERNAL_SKILL_UPSTREAM_STATUSES)[number];

/**
 * Who sees and manages a skill: `workspace` skills belong to one workspace; `platform` skills are managed by
 * platform operators and visible (read and run) in every workspace.
 */
export const EXTERNAL_SKILL_SCOPES = ["workspace", "platform"] as const;
export type ExternalSkillScope = (typeof EXTERNAL_SKILL_SCOPES)[number];

/**
 * Where a skill came from. GitHub: a public repository, a directory in it and the ref it was read at.
 * Upload: a zip archive; `owner` and `repo` are empty and `path` is the skill name (rows written before
 * uploads existed have no `kind` and are GitHub).
 */
export interface ExternalSkillSource {
  kind?: "github" | "upload";
  /** Upload only: the archive's file name as given by the uploader. */
  fileName?: string;
  owner: string;
  repo: string;
  /** Skill directory relative to the repository root; empty when SKILL.md is at the root. */
  path: string;
  /** Branch, tag or commit the import asked for; the pinned commit is on the version. */
  ref?: string;
}

export const EXTERNAL_SKILL_FILE_KINDS = [
  "skill",
  "reference",
  "asset",
  "script",
  "license",
  "other",
] as const;
export type ExternalSkillFileKind = (typeof EXTERNAL_SKILL_FILE_KINDS)[number];

/** One file of a skill directory, as recorded at import. Paths are relative to the skill directory. */
export interface ExternalSkillManifestFile {
  path: string;
  kind: ExternalSkillFileKind;
  bytes: number;
  /** sha256 of the content when it was read, otherwise the upstream git blob id (`gitSha`). */
  sha256?: string;
  gitSha?: string;
  /** True when the bytes are kept in object storage and can be read back. */
  stored: boolean;
  /** Why the content was not kept (symbolic links, submodules, size limits). */
  skipped?: string;
  /** True when the file is not UTF-8 text. */
  binary?: boolean;
  /** True when the archive marked the file executable. */
  executable?: boolean;
}

export interface ExternalSkillSecurityNote {
  kind: "install-command" | "remote-exec" | "credential-request" | "instruction-override" | "script-present";
  path: string;
  /** Short excerpt that triggered the note; never executed. */
  excerpt: string;
}

export interface ExternalSkillLicense {
  /** From the SKILL.md frontmatter `license` field. */
  declared?: string;
  /** SPDX id GitHub detected for the repository. */
  repositorySpdx?: string;
  /** License files found in the skill directory (relative) or repository root. */
  files: string[];
  status: "declared" | "repository" | "unknown";
  notice: string;
}

export const SKILL_RISK_LEVELS = ["low", "medium", "high"] as const;
export type SkillRiskLevel = (typeof SKILL_RISK_LEVELS)[number];

export const SKILL_RISK_RULES = [
  "shell-exec",
  "network-call",
  "remote-exec",
  "install-command",
  "obfuscated-code",
  "dynamic-eval",
  "prompt-injection",
  "credential-request",
  "secret-harvest",
  "binary-file",
  "symlink",
  "script-present",
] as const;
export type SkillRiskRule = (typeof SKILL_RISK_RULES)[number];

export interface SkillRiskFinding {
  rule: SkillRiskRule;
  severity: SkillRiskLevel;
  path: string;
  /** Short excerpt that triggered the finding; never executed. */
  excerpt: string;
  line?: number;
}

/** What the risk scanner found in one version. The level is the highest finding severity. */
export interface SkillRiskReport {
  level: SkillRiskLevel;
  findings: SkillRiskFinding[];
  /** Findings beyond the stored cap. */
  truncated?: number;
  scannerVersion: number;
  scannedAt: Date;
}

/** Immutable record of what an import read. Never edited after the version is written. */
export interface ExternalSkillManifest {
  /** 1: data-only imports (scripts described, not stored); 2: every regular file stored. */
  schemaVersion: 1 | 2;
  files: ExternalSkillManifestFile[];
  /** Frontmatter fields, as plain text. */
  frontmatter: Record<string, string>;
  license: ExternalSkillLicense;
  securityNotes: ExternalSkillSecurityNote[];
  /** Notices to show with the content: author, source and licensing uncertainty. */
  notices: string[];
}

export interface ExternalSkill extends TenantOwned {
  /** `github.com/<owner>/<repo>/<path or .>`, lower-cased owner and repo; unique per workspace. */
  sourceKey: string;
  source: ExternalSkillSource;
  scope: ExternalSkillScope;
  name: string;
  description: string;
  status: ExternalSkillStatus;
  /** Version readers get; undefined only while a skill has no usable version. */
  activeVersionId?: string;
  upstreamStatus: ExternalSkillUpstreamStatus;
  upstreamCheckedAt?: Date;
  createdBy: ActorRef;
  updatedAt: Date;
  disabledAt?: Date;
}

export interface ExternalSkillVersion extends TenantOwned {
  skillId: string;
  /** Immutable upstream commit the content was read at; `upload` for an uploaded archive. */
  commitSha: string;
  /** sha256 over the manifest's file list; equal content has an equal hash whatever the commit. */
  contentHash: string;
  name: string;
  description: string;
  manifest: ExternalSkillManifest;
  /** Object-storage prefix (tenant-relative) holding the stored files as `<prefix>/<sha256>`. */
  storagePrefix: string;
  /** Caller's idempotency key plus skill path; a replay returns this version. */
  importKey?: string;
  /** Risk scan of this version's files; undefined only for versions stored before the scanner existed. */
  risk?: SkillRiskReport;
  createdBy: ActorRef;
}
