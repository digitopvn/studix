import type { ActorRef, TenantOwned } from "./common.ts";

/**
 * Agent Skills (`SKILL.md` folders) imported from a public GitHub repository into a workspace. They are
 * stored as data only: nothing in a skill is ever executed, installed or treated as a Studix instruction.
 */

/** `enabled`: selectable and readable. `disabled`: kept (non-destructive) but not offered for use. */
export const EXTERNAL_SKILL_STATUSES = ["enabled", "disabled"] as const;
export type ExternalSkillStatus = (typeof EXTERNAL_SKILL_STATUSES)[number];

/** Whether the skill folder was still present upstream the last time Studix looked. */
export type ExternalSkillUpstream = "present" | "missing";

/** What a stored file is. `script` files are listed with metadata only; their bytes are never stored. */
export type ExternalSkillFileKind = "skill" | "reference" | "asset" | "script";

export interface ExternalSkillFile {
  /** Path relative to the skill folder, `/`-separated, e.g. `references/style.md`. */
  path: string;
  kind: ExternalSkillFileKind;
  bytes: number;
  sha256: string;
  contentType: string;
  /** Tenant-relative object key of the stored bytes. Absent for scripts and skipped files. */
  storageKey?: string;
  /** True for UTF-8 text that `studix_skill_get` can return inline. */
  text: boolean;
}

/** A file the importer saw but did not store, with the reason (reported, never silently dropped). */
export interface ExternalSkillSkippedFile {
  path: string;
  reason: string;
}

export interface ExternalSkillLicense {
  /** SPDX id or free text declared in the frontmatter or the repository license file. */
  declared?: string;
  /** Path of the license file found in the skill folder or at the repository root. */
  file?: string;
  /** "declared" when a license was found; "unknown" when none was, so reuse rights are unconfirmed. */
  status: "declared" | "unknown";
}

/** Immutable record of what one import captured. */
export interface ExternalSkillManifest {
  schema: 1;
  repository: string;
  path: string;
  commitSha: string;
  name: string;
  description: string;
  /** Frontmatter fields beyond name/description, limited to short strings (author, version, ...). */
  metadata: Record<string, string>;
  license: ExternalSkillLicense;
  files: ExternalSkillFile[];
  skipped: ExternalSkillSkippedFile[];
  /** Notices Studix attaches to every import (data only, license not verified, scripts never run). */
  notices: string[];
  importedAt: string;
}

export interface ExternalSkill extends TenantOwned {
  /** `owner/repo` on github.com, lower-cased. */
  repository: string;
  /** Skill folder inside the repository (`""` for the repository root). */
  path: string;
  name: string;
  description: string;
  status: ExternalSkillStatus;
  upstream: ExternalSkillUpstream;
  upstreamCheckedAt?: Date;
  /** The version readers get by default; changed only by an explicit activation. */
  activeVersionId?: string;
  latestVersionId?: string;
  createdBy: ActorRef;
  updatedAt: Date;
  disabledAt?: Date;
}

export interface ExternalSkillVersion extends TenantOwned {
  skillId: string;
  commitSha: string;
  /** sha256 over the canonical manifest file list (path + sha256 of every stored file). */
  contentHash: string;
  name: string;
  description: string;
  manifest: ExternalSkillManifest;
  /** The caller's idempotency key for the import that created this version, kept as provenance. */
  importKey?: string;
  importedBy: ActorRef;
}
