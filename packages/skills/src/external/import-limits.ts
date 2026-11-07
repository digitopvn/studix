/** Bounds on one discovery or import. Every one is enforced; none is a hint. */
export interface SkillImportLimits {
  /** Skills discovered per repository scan. */
  maxSkills: number;
  /** Directory depth of a SKILL.md below the repository root. */
  maxDepth: number;
  maxTreeEntries: number;
  /** Tree API requests when the recursive listing was truncated and directories are walked one by one. */
  maxTreeRequests: number;
  maxFilesPerSkill: number;
  /** Bytes of one stored file (text, script or binary). */
  maxFileBytes: number;
  /** Bytes stored for one skill. */
  maxSkillBytes: number;
  /** Bytes stored for one import call. */
  maxImportBytes: number;
  requestTimeoutMs: number;
  /** Wall-clock budget of one operation, all requests together. */
  totalTimeoutMs: number;
  maxRedirects: number;
  /** Retries of a request that failed with a network error or a 5xx. */
  maxRetries: number;
  concurrency: number;
  /** Bytes of an uploaded zip archive. */
  maxArchiveBytes: number;
  /** Entries (files and directories) of an uploaded archive. */
  maxArchiveEntries: number;
  /** Largest uncompressed/compressed ratio of one archive entry; higher looks like a zip bomb. */
  maxCompressionRatio: number;
}

export const DEFAULT_SKILL_IMPORT_LIMITS: SkillImportLimits = {
  maxSkills: 50,
  maxDepth: 10,
  maxTreeEntries: 100_000,
  maxTreeRequests: 200,
  maxFilesPerSkill: 500,
  maxFileBytes: 10 * 1024 * 1024,
  maxSkillBytes: 30 * 1024 * 1024,
  maxImportBytes: 60 * 1024 * 1024,
  requestTimeoutMs: 15_000,
  totalTimeoutMs: 90_000,
  maxRedirects: 3,
  maxRetries: 2,
  concurrency: 4,
  maxArchiveBytes: 30 * 1024 * 1024,
  maxArchiveEntries: 1000,
  maxCompressionRatio: 200,
};

/** Run `fn` over `items` with at most `limit` in flight; results keep the input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(limit, 1), items.length) }, worker));
  return results;
}
