import {
  type ActivityEvent,
  type ActivityLevel,
  type ActivityRepository,
  type AuditRepository,
  actorRef,
  assertPermission,
  isTerminalJobStatus,
  type JobRepository,
  type ProjectRepository,
  type TenantContext,
} from "@studix/core";
import { type Clock, type Logger, redact, StudixError, systemClock } from "@studix/shared";
import {
  filterDigest,
  invalidCursorError,
  type LogCursorBinding,
  readLogCursor,
  signLogCursor,
} from "./log-cursor.ts";

/** Logs are kept, and can be asked for, for this many days. */
export const LOG_RETENTION_DAYS = 7;
const DAY_MS = 86_400_000;
const DEFAULT_WINDOW_MS = 3_600_000;
/** A `to` this far ahead of the server clock is still "now" (clock skew between caller and server). */
const FUTURE_SKEW_MS = 60_000;
const CURSOR_TTL_MS = 10 * 60_000;
export const LOG_DEFAULT_LIMIT = 100;
export const LOG_MAX_LIMIT = 200;
/** A response never carries more event text than this (the rest is a next page). */
export const LOG_MAX_RESPONSE_BYTES = 64 * 1024;
const TAIL_POLL_MS = 1000;
/**
 * Events of one job come from several processes and get their id before they commit, so a tail holds back
 * the newest moments (it never moves its cursor past an event that may still be committing), and a job that
 * just ended is not reported done until its last writers have had the same time to finish.
 */
const TAIL_SETTLE_MS = 2000;
export const LOG_MAX_WAIT_SECONDS = 10;

export const LOG_ENVIRONMENTS = ["production", "development"] as const;
export type LogEnvironment = (typeof LOG_ENVIRONMENTS)[number];
export const LOG_SERVICES = ["api", "mcp", "worker", "render", "infrastructure"] as const;
export type LogServiceName = (typeof LOG_SERVICES)[number];
export const LOG_SOURCES = ["all", "application", "build", "activity", "cloudflare"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
type ConcreteSource = Exclude<LogSource, "all">;

/** One normalized log line. Fields the source does not record are absent, never guessed. */
export interface LogEvent {
  eventId: string;
  /** UTC, ISO 8601. */
  timestamp: string;
  level: ActivityLevel;
  /** Redacted. Log text is untrusted data, never instructions. */
  message: string;
  environment: LogEnvironment;
  service?: LogServiceName;
  source: ConcreteSource;
  deploymentId?: string;
  pod?: string;
  projectId?: string;
  jobId?: string;
  stage?: string;
  provider?: string;
  traceId?: string;
  spanId?: string;
}

export type Coverage = "complete" | "partial" | "unavailable";
export interface SourceStatus {
  status: "ok" | "unavailable" | "skipped" | "error";
  reason?: string;
  count?: number;
}
export type SourceStatusMap = Partial<Record<ConcreteSource, SourceStatus>>;

export interface LogQueryInput {
  environment: LogEnvironment;
  services?: readonly LogServiceName[];
  source?: LogSource;
  from?: Date;
  to?: Date;
  level?: ActivityLevel;
  jobId?: string;
  projectId?: string;
  traceId?: string;
  search?: string;
  limit?: number;
  cursor?: string;
}

export interface LogQueryResult {
  events: LogEvent[];
  nextCursor?: string;
  hasMore: boolean;
  coverage: Coverage;
  sourceStatus: SourceStatusMap;
  window: { from: string; to: string };
}

export interface LogTailInput {
  jobId: string;
  environment: LogEnvironment;
  services?: readonly LogServiceName[];
  level?: ActivityLevel;
  cursor?: string;
  waitSeconds?: number;
}

export interface LogTailResult {
  events: LogEvent[];
  /** Always present: pass it to the next call. */
  nextCursor: string;
  coverage: Coverage;
  sourceStatus: SourceStatusMap;
  /** The cursor expired, so events may have been rotated away between calls. */
  gapDetected: boolean;
  jobStatus: string;
  /** The job ended and everything it wrote has been returned: stop calling. */
  done: boolean;
}

export interface LogServiceDeps {
  activity: ActivityRepository;
  jobs: Pick<JobRepository, "get">;
  projects?: Pick<ProjectRepository, "get">;
  audit: AuditRepository;
  /** The environment this deployment serves; other environments are reported unavailable. */
  environment: LogEnvironment;
  /** Signs cursors; any stable server secret. */
  secret: string;
  logger: Logger;
  clock?: Clock;
  /** Pause between tail polls; injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/**
 * Reads of a workspace's own runtime logs. Today the only connected source is the workspace's activity
 * events (database); build, application and Cloudflare logs report `unavailable` until their upstream
 * access exists, so coverage is never claimed beyond what was read.
 */
export interface LogService {
  query(ctx: TenantContext, input: LogQueryInput): Promise<LogQueryResult>;
  tail(ctx: TenantContext, input: LogTailInput, signal?: AbortSignal): Promise<LogTailResult>;
}

const UNCONNECTED: Record<Exclude<ConcreteSource, "activity">, string> = {
  application: "Application runtime logs are not connected to this server yet.",
  build: "Build logs are not connected to this server yet.",
  cloudflare: "Cloudflare logs are not connected to this server yet.",
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function validation(message: string, suggestedAction: string): StudixError {
  return new StudixError("VALIDATION", message, { suggestedAction });
}

const SUMMARY_KEYS = [
  "type",
  "status",
  "name",
  "tool",
  "error",
  "reason",
  "message",
  "delta",
  "text",
] as const;
const SUMMARY_VALUE_CHARS = 200;

/**
 * Most activity events carry no message, only attributes (an agent event is `agent.event` plus its type,
 * tool, text or failure reason). The line is the event name followed by a short, allowlisted view of those
 * attributes, so a log reader sees what happened rather than a bare name.
 */
function lineOf(event: ActivityEvent): string {
  if (event.message) return event.message;
  const parts: string[] = [];
  for (const key of SUMMARY_KEYS) {
    const value = event.attributes[key];
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      const text = String(value).replace(/\s+/g, " ").trim();
      if (text) {
        parts.push(
          `${key}=${text.length > SUMMARY_VALUE_CHARS ? `${text.slice(0, SUMMARY_VALUE_CHARS)}…` : text}`,
        );
      }
    }
  }
  return parts.length > 0 ? `${event.name} ${parts.join(" ")}` : event.name;
}

function toLogEvent(event: ActivityEvent, environment: LogEnvironment): LogEvent {
  return {
    eventId: event.id,
    timestamp: event.createdAt.toISOString(),
    level: event.level,
    message: redact(lineOf(event)),
    environment,
    source: "activity",
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.jobId ? { jobId: event.jobId } : {}),
    ...(event.stage ? { stage: event.stage } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.spanId ? { spanId: event.spanId } : {}),
  };
}

function byteSize(event: LogEvent): number {
  return Buffer.byteLength(JSON.stringify(event));
}

function coverageOf(status: SourceStatusMap): Coverage {
  const all = Object.values(status);
  if (all.length > 0 && all.every((s) => s.status === "ok")) return "complete";
  return all.some((s) => s.status === "ok") ? "partial" : "unavailable";
}

type Outcome = "ok" | "forbidden" | "validation" | "not_found" | "upstream_failure" | "error";

function outcomeOf(error: unknown): Outcome {
  if (!(error instanceof StudixError)) return "error";
  switch (error.code) {
    case "FORBIDDEN":
    case "UNAUTHENTICATED":
      return "forbidden";
    case "VALIDATION":
      return "validation";
    case "NOT_FOUND":
      return "not_found";
    case "UNAVAILABLE":
    case "TIMEOUT":
      return "upstream_failure";
    default:
      return "error";
  }
}

export function createLogService(deps: LogServiceDeps): LogService {
  const clock = deps.clock ?? systemClock;
  const sleep = deps.sleep ?? defaultSleep;

  /**
   * Every access is audited: success, refusal, bad request and upstream failure alike, with a summary of the
   * request and the result size but never log text. A success whose audit record cannot be written is
   * withheld, so an audit outage can never turn into unrecorded reads.
   */
  async function audited<T extends { events: LogEvent[]; coverage: Coverage }>(
    tool: "studix_query_logs" | "studix_tail_logs",
    ctx: TenantContext,
    request: Record<string, unknown>,
    run: () => Promise<T>,
  ): Promise<T> {
    const write = (outcome: Outcome, extra: Record<string, unknown>) =>
      deps.audit.append(ctx, {
        actor: actorRef(ctx.actor),
        action: `logs.${tool === "studix_query_logs" ? "query" : "tail"}`,
        subjectType: "logs",
        data: { tool, outcome, request, ...extra },
      });
    let result: T;
    try {
      result = await run();
    } catch (error) {
      await write(outcomeOf(error), {
        errorCode: error instanceof StudixError ? error.code : "INTERNAL",
      }).catch((auditError: unknown) =>
        deps.logger.error("log access audit not written", {
          tool,
          workspaceId: ctx.workspaceId,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        }),
      );
      throw error;
    }
    try {
      await write("ok", { count: result.events.length, coverage: result.coverage });
    } catch (auditError) {
      deps.logger.error("log access audit not written", {
        tool,
        workspaceId: ctx.workspaceId,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
      throw new StudixError("UNAVAILABLE", "Log access could not be recorded, so nothing was returned", {
        retryable: true,
        suggestedAction: "Try again shortly.",
      });
    }
    return result;
  }

  function binding(ctx: TenantContext, environment: LogEnvironment, filters: Record<string, unknown>) {
    return {
      organizationId: ctx.organizationId,
      workspaceId: ctx.workspaceId,
      environment,
      filters: filterDigest(filters),
    } satisfies LogCursorBinding;
  }

  /** The job/project a filter names must be in the caller's workspace; another tenant's id is NOT_FOUND. */
  async function assertScopeVisible(ctx: TenantContext, scope: { jobId?: string; projectId?: string }) {
    if (scope.jobId && !(await deps.jobs.get(ctx, scope.jobId))) {
      throw new StudixError("NOT_FOUND", "Job not found", {
        suggestedAction: "Check the job id with studix_list_jobs.",
      });
    }
    if (scope.projectId && deps.projects && !(await deps.projects.get(ctx, scope.projectId))) {
      throw new StudixError("NOT_FOUND", "Project not found", {
        suggestedAction: "Check the project id with studix_list_projects.",
      });
    }
  }

  /** Statuses for the sources a request names, other than activity. */
  function unconnected(source: LogSource, services: readonly LogServiceName[] | undefined): SourceStatusMap {
    const status: SourceStatusMap = {};
    const wanted = (s: Exclude<ConcreteSource, "activity">) => source === "all" || source === s;
    for (const s of ["application", "build", "cloudflare"] as const) {
      if (wanted(s)) status[s] = { status: "unavailable", reason: UNCONNECTED[s] };
    }
    if (services?.includes("infrastructure") && !status.cloudflare) {
      status.cloudflare = { status: "unavailable", reason: UNCONNECTED.cloudflare };
    }
    return status;
  }

  function usesActivity(source: LogSource, services: readonly LogServiceName[] | undefined): boolean {
    if (source !== "all" && source !== "activity") return false;
    // Activity events belong to the application, not to infrastructure.
    return !services || services.length === 0 || services.some((s) => s !== "infrastructure");
  }

  function activityNote(services: readonly LogServiceName[] | undefined): string | undefined {
    return services?.some((s) => s !== "infrastructure")
      ? "Activity events do not record the service, so the services filter was not applied to them."
      : undefined;
  }

  async function runQuery(ctx: TenantContext, input: LogQueryInput): Promise<LogQueryResult> {
    assertPermission(ctx, "logs:read");
    const now = clock.now();
    const source = input.source ?? "all";
    const filters = {
      source,
      services: input.services ? [...input.services].sort() : undefined,
      level: input.level,
      jobId: input.jobId,
      projectId: input.projectId,
      traceId: input.traceId,
      search: input.search,
    };
    const bind = binding(ctx, input.environment, filters);

    let window: { from: number; to: number } | undefined;
    let pinnedWindow = false;
    let after: string | undefined;
    if (input.cursor) {
      const read = readLogCursor(deps.secret, input.cursor, bind, now);
      if (!read.ok) {
        if (read.reason === "expired") {
          throw validation(
            "The cursor has expired",
            "Repeat the request without a cursor; pages are valid for 10 minutes.",
          );
        }
        throw invalidCursorError();
      }
      after = read.position.after;
      if (read.position.from !== undefined && read.position.to !== undefined) {
        const pinned = { from: read.position.from, to: read.position.to };
        if (
          (input.from && input.from.getTime() !== pinned.from) ||
          (input.to && input.to.getTime() !== pinned.to)
        ) {
          throw validation(
            "from/to differ from the window of this cursor",
            "Omit from/to when continuing with a cursor.",
          );
        }
        window = pinned;
        pinnedWindow = true;
      }
    }
    if (!window) {
      const to = input.to ?? now;
      const from = input.from ?? new Date(to.getTime() - DEFAULT_WINDOW_MS);
      window = { from: from.getTime(), to: to.getTime() };
    }
    if (window.from > window.to) {
      throw validation("from must not be after to", "Swap the two timestamps.");
    }
    // Later pages keep the first page's window, which was valid when the query began.
    if (!pinnedWindow && window.from < now.getTime() - LOG_RETENTION_DAYS * DAY_MS) {
      throw validation(
        `Logs are available for the last ${LOG_RETENTION_DAYS} days only`,
        `Use a from no earlier than ${new Date(now.getTime() - LOG_RETENTION_DAYS * DAY_MS).toISOString()}.`,
      );
    }
    if (window.to > now.getTime() + FUTURE_SKEW_MS) {
      throw validation("to is in the future", "Use a to no later than now.");
    }
    const limit = Math.min(Math.max(input.limit ?? LOG_DEFAULT_LIMIT, 1), LOG_MAX_LIMIT);
    await assertScopeVisible(ctx, input);

    const sourceStatus = unconnected(source, input.services);
    const windowOut = { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() };
    if (input.environment !== deps.environment) {
      for (const key of Object.keys(sourceStatus) as ConcreteSource[]) {
        sourceStatus[key] = {
          status: "unavailable",
          reason: `This server serves ${deps.environment}, not ${input.environment}.`,
        };
      }
      if (usesActivity(source, input.services)) {
        sourceStatus.activity = {
          status: "unavailable",
          reason: `This server serves ${deps.environment}, not ${input.environment}.`,
        };
      }
      return { events: [], hasMore: false, coverage: "unavailable", sourceStatus, window: windowOut };
    }

    const events: LogEvent[] = [];
    let hasMore = false;
    if (usesActivity(source, input.services)) {
      try {
        const page = await deps.activity.list(ctx, {
          limit,
          ...(after ? { cursor: after } : {}),
          since: new Date(window.from),
          until: new Date(window.to),
          ...(input.level ? { minLevel: input.level } : {}),
          ...(input.jobId ? { jobId: input.jobId } : {}),
          ...(input.projectId ? { projectId: input.projectId } : {}),
          ...(input.traceId ? { traceId: input.traceId } : {}),
          ...(input.search ? { search: input.search } : {}),
        });
        let bytes = 0;
        for (const item of page.items) {
          const event = toLogEvent(item, input.environment);
          bytes += byteSize(event);
          if (events.length > 0 && bytes > LOG_MAX_RESPONSE_BYTES) {
            hasMore = true;
            break;
          }
          events.push(event);
        }
        hasMore = hasMore || page.nextCursor !== undefined;
        const note = activityNote(input.services);
        sourceStatus.activity = {
          status: "ok",
          count: events.length,
          ...(note ? { reason: note } : {}),
        };
      } catch (error) {
        deps.logger.error("activity log source failed", {
          workspaceId: ctx.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        sourceStatus.activity = { status: "error", reason: "The activity store did not answer." };
      }
    } else if (source === "all" || source === "activity") {
      sourceStatus.activity = { status: "skipped", reason: "Only infrastructure services were requested." };
    }

    const last = events.at(-1);
    const nextCursor =
      hasMore && last
        ? signLogCursor(
            deps.secret,
            bind,
            { after: last.eventId, from: window.from, to: window.to },
            new Date(now.getTime() + CURSOR_TTL_MS),
          )
        : undefined;
    const coverage = coverageOf(sourceStatus);
    return {
      events,
      ...(nextCursor ? { nextCursor } : {}),
      hasMore,
      // Activity events that carry no service cannot honour a services filter: say so instead of "complete".
      coverage: activityNote(input.services) && coverage === "complete" ? "partial" : coverage,
      sourceStatus,
      window: windowOut,
    };
  }

  async function runTail(
    ctx: TenantContext,
    input: LogTailInput,
    signal?: AbortSignal,
  ): Promise<LogTailResult> {
    assertPermission(ctx, "logs:read");
    const now = clock.now();
    const filters = {
      jobId: input.jobId,
      level: input.level,
      services: input.services ? [...input.services].sort() : undefined,
    };
    const bind = binding(ctx, input.environment, filters);
    const job = await deps.jobs.get(ctx, input.jobId);
    if (!job) {
      throw new StudixError("NOT_FOUND", "Job not found", {
        suggestedAction: "Check the job id with studix_list_jobs.",
      });
    }

    let after = "";
    let gapDetected = false;
    if (input.cursor) {
      const read = readLogCursor(deps.secret, input.cursor, bind, now);
      if (!read.ok && read.reason === "invalid") throw invalidCursorError();
      // An expired cursor still names a position: resume there, and say that events may have been lost.
      after = read.ok || read.reason === "expired" ? read.position.after : "";
      gapDetected = !read.ok;
    }
    const wait = Math.min(Math.max(Math.trunc(input.waitSeconds ?? 0), 0), LOG_MAX_WAIT_SECONDS);

    const sourceStatus: SourceStatusMap = {
      ...unconnected("all", input.services),
      application: {
        status: "unavailable",
        reason:
          "Live application logs are not connected to this server yet; only the job's activity events are tailed.",
      },
    };
    const next = (position: string) =>
      signLogCursor(deps.secret, bind, { after: position }, new Date(now.getTime() + CURSOR_TTL_MS));

    if (input.environment !== deps.environment) {
      const reason = `This server serves ${deps.environment}, not ${input.environment}.`;
      for (const key of Object.keys(sourceStatus) as ConcreteSource[]) {
        sourceStatus[key] = { status: "unavailable", reason };
      }
      sourceStatus.activity = { status: "unavailable", reason };
      return {
        events: [],
        nextCursor: next(after),
        coverage: "unavailable",
        sourceStatus,
        gapDetected,
        jobStatus: job.status,
        // Nothing here will ever arrive, so a finished job ends the loop instead of polling forever.
        done: isTerminalJobStatus(job.status),
      };
    }
    if (!usesActivity("all", input.services)) {
      sourceStatus.activity = { status: "skipped", reason: "Only infrastructure services were requested." };
      return {
        events: [],
        nextCursor: next(after),
        coverage: coverageOf(sourceStatus),
        sourceStatus,
        gapDetected,
        jobStatus: job.status,
        done: isTerminalJobStatus(job.status),
      };
    }

    const deadline = clock.now().getTime() + wait * 1000;
    for (;;) {
      const current = (await deps.jobs.get(ctx, input.jobId)) ?? job;
      const nowMs = clock.now().getTime();
      // A job that ended is "settled" once its last writers (which can log after the status changes) are done.
      const endedAt = (current.finishedAt ?? current.updatedAt)?.getTime() ?? 0;
      const settled = isTerminalJobStatus(current.status) && nowMs - endedAt >= TAIL_SETTLE_MS;
      let events: LogEvent[] = [];
      try {
        const page = await deps.activity.list(ctx, {
          jobId: input.jobId,
          order: "asc",
          limit: LOG_MAX_LIMIT,
          ...(after ? { cursor: after } : {}),
          since: new Date(now.getTime() - LOG_RETENTION_DAYS * DAY_MS),
          // Hold back the newest moments so the cursor never passes an event that is still committing.
          ...(settled ? {} : { until: new Date(nowMs - TAIL_SETTLE_MS) }),
          ...(input.level ? { minLevel: input.level } : {}),
        });
        let bytes = 0;
        for (const item of page.items) {
          const event = toLogEvent(item, input.environment);
          bytes += byteSize(event);
          if (events.length > 0 && bytes > LOG_MAX_RESPONSE_BYTES) break;
          events.push(event);
        }
        const note = activityNote(input.services);
        sourceStatus.activity = {
          status: "ok",
          count: events.length,
          ...(note ? { reason: note } : {}),
        };
      } catch (error) {
        deps.logger.error("activity log source failed", {
          workspaceId: ctx.workspaceId,
          error: error instanceof Error ? error.message : String(error),
        });
        sourceStatus.activity = { status: "error", reason: "The activity store did not answer." };
        events = [];
      }
      const last = events.at(-1);
      const timedOut = clock.now().getTime() >= deadline || signal?.aborted === true;
      const errored = sourceStatus.activity?.status === "error";
      if (last || settled || timedOut || errored) {
        return {
          events,
          nextCursor: next(last?.eventId ?? after),
          coverage: coverageOf(sourceStatus),
          sourceStatus,
          gapDetected,
          jobStatus: current.status,
          done: settled && events.length === 0 && !errored,
        };
      }
      await sleep(Math.min(TAIL_POLL_MS, Math.max(deadline - clock.now().getTime(), 0)), signal);
    }
  }

  const requestSummary = (input: LogQueryInput | LogTailInput): Record<string, unknown> => ({
    environment: input.environment,
    ...("source" in input && input.source ? { source: input.source } : {}),
    ...(input.services ? { services: input.services } : {}),
    ...(input.level ? { level: input.level } : {}),
    ...("jobId" in input && input.jobId ? { jobId: input.jobId } : {}),
    ...("projectId" in input && input.projectId ? { projectId: input.projectId } : {}),
    ...("traceId" in input && input.traceId ? { traceId: input.traceId } : {}),
    // Only the size of a search term: the term itself could be a pasted secret.
    ...("search" in input && input.search ? { searchLength: input.search.length } : {}),
    ...("from" in input && input.from ? { from: input.from.toISOString() } : {}),
    ...("to" in input && input.to ? { to: input.to.toISOString() } : {}),
    ...(input.cursor ? { cursor: true } : {}),
  });

  return {
    query: (ctx, input) =>
      audited("studix_query_logs", ctx, requestSummary(input), () => runQuery(ctx, input)),
    tail: (ctx, input, signal) =>
      audited("studix_tail_logs", ctx, requestSummary(input), () => runTail(ctx, input, signal)),
  };
}
