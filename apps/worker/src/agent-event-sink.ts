import type { ActivityRepository, AgentStreamEvent, TenantContext } from "@studix/core";
import { type Logger, redactDeep } from "@studix/shared";

/** Activity name of the live agent events the dashboard chat streams (`GET /api/jobs/:id/events`). */
export const AGENT_EVENT_ACTIVITY = "agent.event";

/** Events the harness adds around a runtime's own stream. */
export type HarnessAgentEvent =
  | AgentStreamEvent
  | {
      type: "status";
      status: "running" | "succeeded" | "failed";
      runtime: string;
      model?: string;
      error?: string;
    }
  | {
      type: "artifact";
      name: string;
      /** The project asset the file became. */
      assetId?: string;
      /** Set once the file is stored; usable as an input file of a later task. */
      storageKey?: string;
      /** Short-lived signed URL for previews. */
      url?: string;
      contentType?: string;
      /** A file the agent made along the way, kept for review only; the chat previews it where it is named. */
      preview?: boolean;
    };

export interface AgentEventSink {
  push(event: HarnessAgentEvent): void;
  /** Writes what is buffered; resolves once every write so far has landed. */
  flush(): Promise<void>;
}

const DELTA_FLUSH_MS = 250;
const MAX_ARGS_CHARS = 2_000;

/** Large tool arguments (a whole file being written) keep only a preview. */
function compact(event: HarnessAgentEvent): Record<string, unknown> {
  if (event.type !== "tool_start" || event.args === undefined) return { ...event };
  const text = JSON.stringify(event.args) ?? "";
  return text.length <= MAX_ARGS_CHARS
    ? { ...event }
    : { ...event, args: { preview: `${text.slice(0, MAX_ARGS_CHARS)}…` } };
}
const MAX_DELTA_CHARS = 4_000;

/**
 * Postgres refuses U+0000 in text and jsonb, and a tool that read a binary file (an image) returns it: such
 * an event would not be stored at all. Each NUL becomes U+FFFD, as other undecodable bytes already are.
 */
function withoutNul(value: unknown): unknown {
  if (typeof value === "string")
    return value.includes("\u0000") ? value.replaceAll("\u0000", "\uFFFD") : value;
  if (Array.isArray(value)) return value.map(withoutNul);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withoutNul(v)]));
  }
  return value;
}

/**
 * Stores one stage run's events with its job, in order. Text and reasoning deltas are merged for a moment so a
 * token stream becomes a few rows; any other event flushes them first. Everything is redacted before it is stored.
 */
export function createAgentEventSink(
  activity: Pick<ActivityRepository, "append">,
  ctx: TenantContext,
  scope: { jobId: string; projectId?: string; stage: string },
  logger: Logger,
): AgentEventSink {
  let chain: Promise<void> = Promise.resolve();
  let buffered: { type: "message" | "reasoning"; delta: string } | undefined;
  let timer: NodeJS.Timeout | undefined;

  const write = (event: HarnessAgentEvent) => {
    const attributes = withoutNul(redactDeep(compact(event))) as Record<string, unknown>;
    chain = chain.then(() =>
      activity
        .append(ctx, {
          name: AGENT_EVENT_ACTIVITY,
          level: event.type === "status" && event.status === "failed" ? "error" : "info",
          jobId: scope.jobId,
          ...(scope.projectId ? { projectId: scope.projectId } : {}),
          stage: scope.stage,
          attributes,
        })
        .then(
          () => undefined,
          (err: unknown) => logger.warn("agent event not stored", { jobId: scope.jobId, error: String(err) }),
        ),
    );
  };

  const drain = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (buffered) write(buffered);
    buffered = undefined;
  };

  return {
    push(event) {
      if (event.type === "message" || event.type === "reasoning") {
        if (buffered && buffered.type !== event.type) drain();
        buffered = buffered ? { ...buffered, delta: buffered.delta + event.delta } : { ...event };
        if (buffered.delta.length >= MAX_DELTA_CHARS) drain();
        else timer ??= setTimeout(drain, DELTA_FLUSH_MS);
        return;
      }
      drain();
      write(event);
    },
    flush() {
      drain();
      return chain;
    },
  };
}
