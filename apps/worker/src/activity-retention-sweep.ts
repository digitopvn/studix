import type { ActivityRetention } from "@studix/core";
import { LOG_RETENTION_MS } from "@studix/observability";
import type { Logger } from "@studix/shared";
import { AGENT_EVENT_ACTIVITY } from "./agent-event-sink.ts";

/**
 * Activity names the sweep never deletes: a job's chat transcript is read back from the dashboard long after
 * the log window, so it is a record of the job and not runtime noise. Audit events live in their own table.
 */
export const RETAINED_ACTIVITY_NAMES: readonly string[] = [AGENT_EVENT_ACTIVITY];

/** Deletes runtime activity older than the 7-day log window. Returns the number of rows removed. */
export async function sweepActivityEvents(
  retention: ActivityRetention,
  logger: Logger,
  now: Date = new Date(),
): Promise<number> {
  const deleted = await retention.purgeBefore(new Date(now.getTime() - LOG_RETENTION_MS), {
    keepNames: RETAINED_ACTIVITY_NAMES,
  });
  if (deleted > 0) logger.info("removed expired activity events", { count: deleted });
  return deleted;
}
