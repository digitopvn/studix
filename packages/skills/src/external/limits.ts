/**
 * Bounds for reading a stranger's repository. Every one is a hard stop: a skill that exceeds a per-skill
 * bound is reported as such (or its extra files are listed as skipped), never partially trusted.
 */
export const EXTERNAL_SKILL_LIMITS = {
  /** `SKILL.md` itself. */
  maxSkillMdBytes: 256 * 1024,
  /** Any other stored file. */
  maxFileBytes: 128 * 1024,
  /** Stored bytes of one skill bundle, `SKILL.md` included. */
  maxBundleBytes: 2 * 1024 * 1024,
  /** Files (stored or listed) per skill bundle. */
  maxFilesPerSkill: 100,
  /** Skills examined or imported per request. */
  maxSkillsPerRepo: 50,
  /** Path segments below the repository root. */
  maxPathDepth: 10,
  maxPathLength: 300,
  /** Entries accepted from one GitHub tree response. */
  maxTreeEntries: 150_000,
  /** Non-recursive tree requests when the recursive listing is truncated. */
  maxTreeRequests: 40,
  /** JSON bytes accepted from one GitHub API response. */
  maxApiBytes: 16 * 1024 * 1024,
  /** Frontmatter block of `SKILL.md`. */
  maxFrontmatterBytes: 16 * 1024,
  requestTimeoutMs: 10_000,
  /** Wall clock for one discover or import call. */
  totalTimeoutMs: 60_000,
  maxRetries: 2,
  /** Concurrent content downloads. */
  concurrency: 4,
} as const;

export type ExternalSkillLimits = { -readonly [K in keyof typeof EXTERNAL_SKILL_LIMITS]: number };
