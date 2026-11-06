import type {
  ExternalSkillFileKind,
  ExternalSkillLicense,
  ExternalSkillSkippedFile,
} from "../entities/external-skill.ts";

/**
 * Read-only access to a public skill source (GitHub in phase 1). Implementations enforce every bound
 * (depth, file count, bytes, runtime, redirects, retries), only talk to public GitHub hosts and never
 * execute or install anything they fetch.
 */
export interface ExternalSkillSource {
  /** Resolve the repository to one immutable commit and list the valid and invalid skill candidates. */
  discover(input: SkillDiscoverRequest): Promise<SkillDiscovery>;
  /** Fetch the files of the selected skill folders at an already pinned commit. */
  fetchSkills(input: SkillFetchRequest): Promise<SkillFetchResult[]>;
}

export interface SkillDiscoverRequest {
  /** `https://github.com/<owner>/<repo>[/tree/<ref>/<path>]` (a `.git` suffix is accepted). */
  repositoryUrl: string;
  /** Branch, tag or commit; defaults to the repository's default branch. Overrides a ref in the URL. */
  ref?: string;
  /** Restrict discovery to this folder (also taken from a `/tree/<ref>/<path>` URL). */
  path?: string;
}

export interface SkillCandidate {
  /** Skill folder inside the repository (`""` for the root). */
  path: string;
  name: string;
  description: string;
  license: ExternalSkillLicense;
  /** Frontmatter extras (author, version, ...): short strings only. */
  metadata: Record<string, string>;
  /** Counts of the supporting files that would be stored, by kind. */
  files: Partial<Record<ExternalSkillFileKind, number>>;
  totalBytes: number;
}

export interface InvalidSkillCandidate {
  path: string;
  /** Why the SKILL.md was rejected (malformed frontmatter, missing name, too large, ...). */
  reason: string;
}

export interface SkillDiscovery {
  /** `owner/repo`, lower-cased. */
  repository: string;
  defaultBranch?: string;
  /** The ref that was resolved, as given or the default branch. */
  ref: string;
  /** Immutable 40-hex commit SHA the ref resolved to. */
  commitSha: string;
  skills: SkillCandidate[];
  invalid: InvalidSkillCandidate[];
  /** Set when the repository tree was truncated or a bound stopped the walk, so the list may be partial. */
  partial?: { reason: string };
}

export interface SkillFetchRequest {
  /** `owner/repo`. */
  repository: string;
  commitSha: string;
  /** Skill folders as returned by discovery. */
  paths: string[];
}

export interface FetchedSkillFile {
  path: string;
  kind: ExternalSkillFileKind;
  contentType: string;
  /** Present for stored files; absent for scripts (metadata only). */
  bytes?: Uint8Array;
  size: number;
  sha256: string;
  text: boolean;
}

export type SkillFetchResult =
  | {
      path: string;
      status: "ok";
      name: string;
      description: string;
      license: ExternalSkillLicense;
      metadata: Record<string, string>;
      files: FetchedSkillFile[];
      skipped: ExternalSkillSkippedFile[];
    }
  | { path: string; status: "rejected"; reason: string };
