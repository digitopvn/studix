import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, stat } from "node:fs/promises";

/** Stream a file through sha256 (renders can be large; never buffer them whole). */
export async function sha256File(filePath: string): Promise<{ sha256: string; bytes: number }> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  const { size } = await stat(filePath);
  return { sha256: hash.digest("hex"), bytes: size };
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Deterministic record id derived from a job id (`job_<ulid>` -> `<prefix>_<ulid>`), so a re-run stage
 * finds the record it may already have written instead of inserting a duplicate.
 */
export function jobScopedId(prefix: string, jobId: string): string {
  const sep = jobId.indexOf("_");
  return `${prefix}_${sep >= 0 ? jobId.slice(sep + 1) : jobId}`;
}
