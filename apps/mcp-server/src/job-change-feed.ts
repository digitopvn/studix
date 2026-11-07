import { isTerminalJobStatus } from "@studix/core";
import type { JobChange, JobChangeRepository } from "@studix/database";
import type { Logger } from "@studix/shared";

const POLL_MS = 2_000;
const BATCH = 500;
/** Rows committed slightly out of order are read again inside this window; seen versions are skipped. */
const OVERLAP_MS = 5_000;

/** MCP resource URI of one job; `resources/read` returns the job, `notifications/resources/updated` names it. */
export function jobResourceUri(jobId: string): string {
  return `studix://jobs/${encodeURIComponent(jobId)}`;
}

export interface JobChangeFeed {
  /** Read once: status/stage changes since the previous poll. Exposed for tests. */
  poll(): Promise<JobChange[]>;
  stop(): void;
}

/**
 * Polls jobs whose `updated_at` moved and reports the ones whose status or stage changed (progress and lease
 * renewals alone are not events). Every API replica runs its own feed: MCP subscriptions live in the replica
 * that holds the stream, and webhook receivers dedupe on the event id.
 */
export function startJobChangeFeed(deps: {
  changes: JobChangeRepository;
  onChanges: (changes: JobChange[]) => void | Promise<void>;
  logger: Logger;
  now?: () => Date;
  pollMs?: number;
  /** false in tests: call poll() by hand. */
  autoStart?: boolean;
}): JobChangeFeed {
  const now = deps.now ?? (() => new Date());
  let since = now();
  /** Last reported `status|stage` per job; terminal jobs leave the map. */
  const last = new Map<string, string>();
  /** Versions already read (`id@updatedAt`), so the overlap window does not report a row twice. */
  let seen = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const poll = async (): Promise<JobChange[]> => {
    const rows = await deps.changes.listChangedSince(new Date(since.getTime() - OVERLAP_MS), BATCH);
    const nextSeen = new Set<string>();
    const out: JobChange[] = [];
    for (const row of rows) {
      const version = `${row.id}@${row.updatedAt.getTime()}`;
      nextSeen.add(version);
      if (row.updatedAt > since) since = row.updatedAt;
      if (seen.has(version)) continue;
      const key = `${row.status}|${row.stage ?? ""}`;
      if (last.get(row.id) === key) continue;
      if (isTerminalJobStatus(row.status)) last.delete(row.id);
      else last.set(row.id, key);
      out.push(row);
    }
    seen = nextSeen;
    if (out.length) await deps.onChanges(out);
    return out;
  };

  const loop = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      try {
        await poll();
      } catch (err) {
        deps.logger.warn("job change feed poll failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      loop();
    }, deps.pollMs ?? POLL_MS);
    timer.unref?.();
  };
  if (deps.autoStart !== false) loop();

  return {
    poll,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
