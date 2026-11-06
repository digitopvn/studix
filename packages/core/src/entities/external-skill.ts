import type { ActorRef, TenantOwned } from "./common.ts";

/**
 * Skills imported from public GitHub repositories (Agent Skills: a directory with a `SKILL.md`). They are
 * stored as inert data. Studix never executes a script, installs a dependency or treats skill text as
 * instructions of its own: a host agent reads the text and decides what to apply.
 */

export const EXTERNAL_SKILL_TOOLS = {
  discover: "studix_skill_discover",
  import: "studix_skill_import",
  list: "studix_skill_list",
  get: "studix_skill_get",
  update: "studix_skill_update",
  disable: "studix_skill_disable",
} as const;

/** What a stored file of a skill is. `script` files are recorded as metadata only, never stored. */
export const EXTERNAL_SKILL_FILE_KINDS = ["skill", "reference", "asset", "script", "license"] as const;
export type ExternalSkillFileKind = (typeof EXTERNAL_SKILL_FILE_KINDS)[number];

/** Hard bounds applied by every source and by the service; none is configurable by a caller. */
export const EXTERNAL_SKILL_LIMITS = {
  maxCandidates: 100,
  maxSkillsPerImport: 25,
  maxFilesPerSkill: 100,
  maxSkillMdBytes: 128 * 1024,
  maxTextFileBytes: 256 * 1024,
  maxAssetFileBytes: 1024 * 1024,
  maxSkillBytes: 5 * 1024 * 1024,
  maxTreeEntries: 100_000,
  maxPathDepth: 12,
  maxRequests: 400,
  maxRuntimeMs: 45_000,
  /** Largest slice `studix_skill_get` returns in one call. */
  maxReadBytes: 100 * 1024,
  /** Operations that call GitHub at once per workspace (per server process). */
  maxConcurrentRemoteOperations: 2,
  defaultReadBytes: 48 * 1024,
} as const;

/** A public GitHub repository pinned to one immutable commit. */
export interface PinnedSource {
  /** `owner/repo`, lower-cased: the identity used for idempotency. */
  repository: string;
  /** Canonical `https://github.com/owner/repo`. */
  url: string;
  /** Ref the caller named (branch, tag or sha); the repository's default branch when none. */
  ref: string;
  commitSha: string;
  treeSha: string;
  defaultBranch?: string;
}

/**
 * Licensing is reported, never assumed. `uncertain` is true unless a recognised SPDX license was found,
 * so a caller can see that "public" does not mean "reusable".
 */
export interface SkillLicense {
  spdxId?: string;
  name?: string;
  /** Where it came from: the repository license, the skill frontmatter, or both. */
  source: "repository" | "frontmatter" | "none";
  /** License text from the frontmatter `license` field, when it is not an SPDX identifier. */
  declared?: string;
  uncertain: boolean;
}

export interface SkillFileEntry {
  /** Path relative to the skill directory (`SKILL.md`, `references/a.md`); `LICENSE` for the repo license. */
  path: string;
  kind: ExternalSkillFileKind;
  bytes: number;
  sha256: string;
  contentType: string;
  /** Tenant-relative storage key; absent for files that were recorded but not stored. */
  storageKey?: string;
  /** Why the file was recorded without content (script, too large, symlink, binary type, bounds). */
  skipped?: string;
}

export interface ExternalSkillManifest {
  /** Parsed frontmatter, JSON-safe and size-bounded. Metadata only: `allowed-tools` is never honored. */
  frontmatter: Record<string, unknown>;
  files: SkillFileEntry[];
  license: SkillLicense;
  /** Author/copyright lines found in the frontmatter or license file. */
  notices: string[];
  /** Heuristic flags on the text (install scripts, credential requests, instruction overrides). */
  warnings: string[];
  source: PinnedSource;
  /** Directory of the skill inside the repository (`.` for the root). */
  skillPath: string;
}

export type UpstreamStatus = "unknown" | "current" | "changed" | "missing";

export interface ExternalSkill extends TenantOwned {
  /** `owner/repo`, lower-cased. */
  repository: string;
  skillPath: string;
  /** Name and description of the active version (of the newest one until a version is active). */
  name: string;
  description: string;
  enabled: boolean;
  activeVersionId?: string;
  upstreamStatus: UpstreamStatus;
  upstreamCheckedAt?: Date;
  upstreamCommitSha?: string;
  createdBy: ActorRef;
  updatedAt: Date;
}

export interface ExternalSkillVersion extends TenantOwned {
  skillId: string;
  commitSha: string;
  /** Digest of the skill's name, description and every file hash; the idempotency key of a version. */
  contentHash: string;
  name: string;
  description: string;
  manifest: ExternalSkillManifest;
  /** Tenant-relative key of the stored `SKILL.md`. */
  skillStorageKey: string;
  createdBy: ActorRef;
}

/** A skill the source found, ready to import. No file content yet. */
export interface SkillCandidate {
  path: string;
  name: string;
  description: string;
  license: SkillLicense;
  files: Array<Pick<SkillFileEntry, "path" | "kind" | "bytes" | "skipped">>;
  warnings: string[];
}

/** A `SKILL.md` that cannot be imported, with the reason. One bad skill never fails the others. */
export interface RejectedSkill {
  path: string;
  reason: string;
}

/** `missing`: no `SKILL.md` at the path in that commit. `invalid`: it exists but cannot be imported. */
export type SkillRejectionCode = "missing" | "invalid";

export interface SkillDiscovery {
  source: PinnedSource;
  candidates: SkillCandidate[];
  rejected: RejectedSkill[];
  /** The repository tree was too large to list in one response, so the search was bounded. */
  truncated: boolean;
  notes: string[];
}

/** One skill downloaded at a pinned commit; `content` is present exactly for files that are stored. */
export interface FetchedSkillFile extends Omit<SkillFileEntry, "storageKey"> {
  content?: Uint8Array;
}

export interface FetchedSkill {
  path: string;
  name: string;
  description: string;
  frontmatter: Record<string, unknown>;
  files: FetchedSkillFile[];
  license: SkillLicense;
  notices: string[];
  warnings: string[];
}

export type FetchSkillsResult =
  | { path: string; status: "ok"; skill: FetchedSkill }
  | { path: string; status: "rejected"; code: SkillRejectionCode; reason: string };

export interface DiscoverRequest {
  repositoryUrl: string;
  /** Branch, tag or commit sha; the default branch when absent. */
  ref?: string;
  /** Restrict to one skill directory (and below). */
  path?: string;
  /** An already pinned source: list that exact commit instead of resolving the URL and ref again. */
  pinned?: PinnedSource;
}

/**
 * Read-only access to public GitHub repositories. Implementations must reach only GitHub's public API,
 * stay inside `EXTERNAL_SKILL_LIMITS`, reject symlinks and unsafe paths, and never execute fetched content.
 */
export interface ExternalSkillSource {
  discover(request: DiscoverRequest): Promise<SkillDiscovery>;
  /** Download the named skills of an already pinned source. */
  fetchSkills(source: PinnedSource, skillPaths: string[]): Promise<FetchSkillsResult[]>;
  /** Resolve a repository URL (and optional ref) to the commit it points to now, without listing skills. */
  resolve(request: Pick<DiscoverRequest, "repositoryUrl" | "ref">): Promise<PinnedSource>;
}
