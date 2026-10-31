import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isId } from "@studix/shared";

/** Newest modification time of a job directory, its attempt directories and their stage directories. */
async function lastActivityMs(jobDir: string): Promise<number> {
  let newest = (await stat(jobDir)).mtimeMs;
  const visit = async (dir: string, depth: number): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      newest = Math.max(newest, (await stat(child)).mtimeMs);
      if (depth > 1) await visit(child, depth - 1);
    }
  };
  await visit(jobDir, 2);
  return newest;
}

/**
 * Remove job scratch directories (`<workDir>/<jobId>`) without writes for `maxAgeMs` (judged by the newest directory mtime two levels down, where attempts write). A failed job keeps its
 * attempt directories so a retry can reuse synced media; this bounds how long and how much disk they hold.
 * Returns the removed job ids. Entries that are not job directories (e.g. `claude`, `qa`) are never touched.
 */
export async function sweepStaleJobDirs(
  workDir: string,
  maxAgeMs: number,
  now: Date = new Date(),
): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(workDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (!isId(name, "job")) continue;
    const dir = join(workDir, name);
    try {
      if (!(await stat(dir)).isDirectory()) continue;
      if (now.getTime() - (await lastActivityMs(dir)) < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Vanished or unreadable: the next sweep decides again.
    }
  }
  return removed;
}
