import type { ActorRef, TenantOwned } from "./common.ts";

/** Kinds of files an Agent Skill bundle may carry besides `SKILL.md`. */
export const EXTERNAL_SKILL_FILE_KINDS = ["reference", "asset", "script"] as const;
export type ExternalSkillFileKind = (typeof EXTERNAL_SKILL_FILE_KINDS)[number];

/**
 * One file of an imported skill bundle. `stored` files have their bytes in object storage under
 * `storageKey`; everything else is metadata only (scripts are never fetched, let alone run).
 */
export interface ExternalSkillFile {
  /** Path relative to the skill directory, `/`-separated, validated against traversal. */
  path: string;
  kind: ExternalSkillFileKind;
  bytes: number;
  /** sha256 (hex) of the stored bytes; absent for metadata-only files. */
  sha256?: string;
  /** Git blob sha reported by GitHub; identifies metadata-only files. */
  gitSha?: string;
  contentType?: string;
  stored: boolean;
  storageKey?: string;
  /** Why the bytes were not stored. */
  reason?: string;
}

/** A file the importer saw in the skill directory but did not ingest, with the reason. */
export interface ExternalSkillSkippedFile {
  path: string;
  reason: string;
}

/**
 * How reusable the skill's content is. `declared`: the skill's frontmatter names a license. `repository`:
 * only the repository's license applies. `unknown`: nothing was found; do not assume the content is reusable.
 */
export type ExternalSkillLicenseStatus = "declared" | "repository" | "unknown";

/** Informational findings about instructions in untrusted skill text. Never blocks an import. */
export const EXTERNAL_SKILL_RISK_FLAGS = [
  "install-command",
  "remote-script-pipe",
  "script-execution",
  "instruction-override",
  "credential-request",
  "destructive-command",
] as const;
export type ExternalSkillRiskFlag = (typeof EXTERNAL_SKILL_RISK_FLAGS)[number];

/** Immutable description of one imported version: what was fetched, hashed and stored. */
export interface ExternalSkillManifest {
  name: string;
  description: string;
  /** Frontmatter `license` value, when present. */
  license?: string;
  licenseStatus: ExternalSkillLicenseStatus;
  /** SPDX id or name of the repository license, when GitHub reports one. */
  repositoryLicense?: string;
  licenseNotice: string;
  /** Scalar frontmatter keys (author, version, compatibility, ...), bounded. */
  frontmatter: Record<string, string>;
  skillMd: { path: string; bytes: number; sha256: string; storageKey: string };
  files: ExternalSkillFile[];
  skipped: ExternalSkillSkippedFile[];
  riskFlags: ExternalSkillRiskFlag[];
  warnings: string[];
}

export interface ExternalSkillSource {
  host: "github.com";
  owner: string;
  repo: string;
  /** Skill directory inside the repository (`""` for the root). */
  path: string;
}

/** `none`: never checked. `current`: upstream matches the active version. `changed`: a newer commit differs. `missing`: removed upstream. */
export type ExternalSkillUpstreamStatus = "unknown" | "current" | "changed" | "missing";

/** A skill imported into a workspace. Versions hold the content; this row tracks which one is in use. */
export interface ExternalSkill extends TenantOwned {
  updatedAt: Date;
  /** Lower-cased `github.com/<owner>/<repo>:<path>`; unique per workspace. */
  sourceKey: string;
  source: ExternalSkillSource;
  /** Name and description of the active version (of the latest while none is active). */
  name: string;
  description: string;
  enabled: boolean;
  activeVersionId?: string;
  latestVersionId: string;
  upstreamStatus: ExternalSkillUpstreamStatus;
  upstreamCheckedAt?: Date;
  createdBy: ActorRef;
  disabledAt?: Date;
  disabledBy?: ActorRef;
}

/** One immutable import of a skill at a pinned commit. */
export interface ExternalSkillVersion extends TenantOwned {
  skillId: string;
  /** 1, 2, ... in import order. */
  version: number;
  commitSha: string;
  /** Branch or tag the commit was resolved from, when the caller named one. */
  ref?: string;
  contentHash: string;
  name: string;
  description: string;
  manifest: ExternalSkillManifest;
  importedBy: ActorRef;
}
