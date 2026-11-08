import { ACTIVITY_RETENTION_KEEP_NAMES, type ActivityRepository } from "@studix/core";
import { LOG_RETENTION_MS } from "@studix/observability";

const BATCH = 2_000;
/** Bounds one sweep so a huge backlog is cleared over several runs instead of holding the database. */
const MAX_BATCHES = 50;

/**
 * Deletes runtime activity older than the log retention window (the same 7 days the log tools read), in small
 * batches. Audit, usage and provider records live in other tables and are untouched, and the job chat
 * (`agent.event`) is kept. Returns how many events were removed.
 */
export async function purgeExpiredActivity(
  activity: Pick<ActivityRepository, "purgeBefore">,
  now: Date = new Date(),
): Promise<number> {
  const before = new Date(now.getTime() - LOG_RETENTION_MS);
  let total = 0;
  for (let i = 0; i < MAX_BATCHES; i++) {
    const removed = await activity.purgeBefore(before, {
      limit: BATCH,
      keepNames: ACTIVITY_RETENTION_KEEP_NAMES,
    });
    total += removed;
    if (removed < BATCH) break;
  }
  return total;
}
