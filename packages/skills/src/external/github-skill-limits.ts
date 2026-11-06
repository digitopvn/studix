import { StudixError } from "@studix/shared";

/** Every bound the GitHub skill importer enforces. Byte values are raw (decoded) file bytes. */
export interface GithubSkillLimits {
  /** Deepest folder level (path segments) the tree walk considers. */
  maxDepth: number;
  /** Tree entries visited per tree listing before the walk stops and reports a partial result. */
  maxTreeEntries: number;
  /** SKILL.md files read during one discovery. */
  maxSkillCandidates: number;
  /** Supporting files (stored or metadata-only) one skill may carry. */
  maxFilesPerSkill: number;
  /** Largest supporting file that is downloaded. */
  maxFileBytes: number;
  /** Largest SKILL.md that is accepted. */
  maxSkillMdBytes: number;
  /** Bytes downloaded for one skill, SKILL.md included. */
  maxSkillBytes: number;
  /** Bytes downloaded across one `fetchSkills` call. */
  maxImportBytes: number;
  /** Largest JSON response (tree listings) that is read. */
  maxResponseBytes: number;
  /** Longest repository-relative path that is accepted. */
  maxPathLength: number;
  /** HTTP requests per `discover` / `fetchSkills` call, retries and redirects included. */
  maxRequests: number;
  /** Timeout of one HTTP request. */
  requestTimeoutMs: number;
  /** Wall-clock budget of one `discover` / `fetchSkills` call. */
  totalTimeoutMs: number;
  /** Retries after a 5xx or network failure. */
  maxRetries: number;
  /** First retry delay; doubles on every further retry. */
  retryBaseDelayMs: number;
  /** Longest rate-limit wait honoured in-process; longer waits fail with RATE_LIMITED. */
  maxRateLimitWaitMs: number;
  /** Same-host redirects followed; cross-host redirects are always refused. */
  maxRedirects: number;
  /** Candidate `<ref>/<path>` splits tried for an ambiguous `/tree/` URL. */
  maxRefCandidates: number;
  /** Parallel blob downloads. */
  concurrency: number;
}

const MIB = 1024 * 1024;

export const DEFAULT_GITHUB_SKILL_LIMITS: Readonly<GithubSkillLimits> = Object.freeze({
  maxDepth: 12,
  maxTreeEntries: 100_000,
  maxSkillCandidates: 100,
  maxFilesPerSkill: 200,
  maxFileBytes: MIB,
  maxSkillMdBytes: 256 * 1024,
  maxSkillBytes: 5 * MIB,
  maxImportBytes: 25 * MIB,
  maxResponseBytes: 16 * MIB,
  maxPathLength: 240,
  maxRequests: 1000,
  requestTimeoutMs: 15_000,
  totalTimeoutMs: 120_000,
  maxRetries: 2,
  retryBaseDelayMs: 500,
  maxRateLimitWaitMs: 5_000,
  maxRedirects: 2,
  maxRefCandidates: 4,
  concurrency: 4,
});

/** Merge overrides onto the defaults, rejecting anything that is not a non-negative integer. */
export function resolveGithubSkillLimits(overrides: Partial<GithubSkillLimits> = {}): GithubSkillLimits {
  const limits: GithubSkillLimits = { ...DEFAULT_GITHUB_SKILL_LIMITS };
  for (const key of Object.keys(DEFAULT_GITHUB_SKILL_LIMITS) as (keyof GithubSkillLimits)[]) {
    const value = overrides[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new StudixError("VALIDATION", `GitHub skill limit "${key}" must be a non-negative integer`);
    }
    limits[key] = value;
  }
  if (limits.concurrency < 1) limits.concurrency = 1;
  return limits;
}
