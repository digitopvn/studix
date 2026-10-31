import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { isId } from "@studix/shared";

/**
 * Remove job scratch directories (`<workDir>/<jobId>`) nobody touched for `maxAgeMs`. A failed job keeps its
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
      const info = await stat(dir);
      if (!info.isDirectory() || now.getTime() - info.mtimeMs < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Vanished or unreadable: the next sweep decides again.
    }
  }
  return removed;
}
