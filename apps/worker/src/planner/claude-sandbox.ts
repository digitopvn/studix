import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Logger } from "@studix/shared";

const SANDBOX_PREFIX = "studix-claude-";

/**
 * Create the parent of the per-session Claude sandboxes (the SDK transport does not) and remove sandboxes
 * left by sessions that can no longer be running: a worker killed mid-run, or one that shut down before
 * its session closed. Workers on one host may share the directory, so only sandboxes older than the
 * longest possible session are removed.
 */
export function prepareClaudeSandboxRoot(
  root: string,
  maxSessionMs: number,
  logger: Logger,
  now: number = Date.now(),
): string {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  let removed = 0;
  for (const name of readdirSync(root)) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const path = join(root, name);
    try {
      if (now - statSync(path).mtimeMs <= maxSessionMs) continue;
      rmSync(path, { recursive: true, force: true });
      removed++;
    } catch (err) {
      logger.warn("stale Claude sandbox not removed", { path, error: String(err) });
    }
  }
  if (removed > 0) logger.info("removed stale Claude sandboxes", { root, removed });
  return root;
}
