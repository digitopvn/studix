import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  ACTIVITY_LEVELS,
  type ActivityEvent,
  type ActivityLevel,
  type ActivityRepository,
  type AuditRepository,
  assertPermission,
  can,
  type TenantContext,
} from "@studix/core";
import { type Logger, redact, StudixError } from "@studix/shared";

/** Logs are never readable beyond this age, whatever the sources still hold. */
export const LOG_RETENTION_MS = 7 * 24 * 3600 * 1000;
const DEFAULT_WINDOW_MS = 3600 * 1000;
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 200;
export const MAX_SEARCH_CHARS = 200;
/** Response size bound for one call. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
const CURSOR_TTL_MS = 15 * 60 * 1000;
const MAX_TAIL_WAIT_SECONDS = 10;
const TAIL_POLL_MS = 1000;
/**
 * Ids are ordered per writer process, and API, MCP and worker write with independent clocks, so an event can
 * commit after the tail already passed its id. Each poll therefore re-reads this long a trailing window and
 * returns any event it has not delivered yet.
 */
export const TAIL_LOOKBACK_MS = 10_000;
/** Delivered ids a tail cursor remembers, to tell late events from ones already returned. */
const MAX_SEEN_IDS = 60;
const LATE_READ_LIMIT = 1000;
/** Concurrent tail calls one workspace may hold open. */
const MAX_TAILS_PER_WORKSPACE = 4;

export const LOG_ENVIRONMENTS = ["production", "development"] as const;
export type LogEnvironment = (typeof LOG_ENVIRONMENTS)[number];
export const LOG_SERVICES = ["api", "mcp", "worker", "render", "infrastructure"] as const;
export type LogServiceName = (typeof LOG_SERVICES)[number];
export const LOG_SOURCES = ["all", "application", "build", "activity", "cloudflare"] as const;
export type LogSource = (typeof LOG_SOURCES)[number];
export type Coverage = "complete" | "partial" | "unavailable";

/** One normalized log event. Fields a source does not know are left out, never guessed. */
export interface LogEvent {
  eventId: string;
  timestamp: string;
  level: ActivityLevel;
  message: string;
  environment: LogEnvironment;
  service?: LogServiceName;
  source: Exclude<LogSource, "all">;
  /** The activity event's name (for example `job.failed`). */
  name?: string;
  deploymentId?: string;
  pod?: string;
  projectId?: string;
  jobId?: string;
  stage?: string;
  provider?: string;
  traceId?: string;
  spanId?: string;
}

export interface SourceStatus {
  source: Exclude<LogSource, "all">;
  status: "ok" | "partial" | "unavailable" | "restricted";
  reason?: string;
}

export interface LogQueryInput {
  environment: LogEnvironment;
  services?: readonly LogServiceName[] | undefined;
  source?: LogSource | undefined;
  from?: string | undefined;
  to?: string | undefined;
  level?: ActivityLevel | undefined;
  jobId?: string | undefined;
  projectId?: string | undefined;
  traceId?: string | undefined;
  search?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface LogQueryResult {
  events: LogEvent[];
  nextCursor?: string;
  hasMore: boolean;
  coverage: Coverage;
  sourceStatus: SourceStatus[];
}

export interface LogTailInput {
  environment: LogEnvironment;
  jobId: string;
  services?: readonly LogServiceName[] | undefined;
  level?: ActivityLevel | undefined;
  cursor?: string | undefined;
  waitSeconds?: number | undefined;
}

export interface LogTailResult extends LogQueryResult {
  /** The job reached a final status and every event it produced has been returned. */
  jobDone: boolean;
  jobStatus: string;
  /**
   * An event may have been missed. Writers in other processes can commit late; each poll re-reads a trailing window
   * and returns those events. This is true only when a very busy job forced that window below its 10 seconds.
   */
  gapDetected: boolean;
}

export interface LogServiceDeps {
  activity: Pick<ActivityRepository, "window">;
  audit: Pick<AuditRepository, "append">;
  /** Which deployment this server is: `environment` in a request must match, or the answer is `unavailable`. */
  environment: LogEnvironment;
  /** Key for signing cursors; derived from a server secret, never sent to clients. */
  cursorSecret: string;
  logger: Logger;
  now?: () => Date;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A job's status for tail termination; throws NOT_FOUND when the job is not in the caller's workspace. */
export type JobProbe = (ctx: TenantContext, jobId: string) => Promise<{ status: string; terminal: boolean }>;

export interface LogService {
  query(ctx: TenantContext, input: LogQueryInput): Promise<LogQueryResult>;
  tail(
    ctx: TenantContext,
    input: LogTailInput,
    options: { job: JobProbe; signal?: AbortSignal },
  ): Promise<LogTailResult>;
}

type Outcome = "ok" | "forbidden" | "validation" | "rate_limited" | "upstream";

/** Sources that read platform infrastructure; only a platform operator may ask for them. */
const SYSTEM_SOURCES: readonly Exclude<LogSource, "all">[] = ["application", "build", "cloudflare"];
const SYSTEM_SOURCE_REASON =
  "Not connected yet: it needs project-scoped log retention and access on the hosting platform.";

const LEVEL_ORDER: Record<ActivityLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

function levelsFrom(min: ActivityLevel | undefined): ActivityLevel[] | undefined {
  if (!min) return undefined;
  return ACTIVITY_LEVELS.filter((l) => LEVEL_ORDER[l] >= LEVEL_ORDER[min]);
}

const HEADER_LINE = /^(\s*(?:cookie|set-cookie|authorization|proxy-authorization|x-api-key)\s*:).*$/gim;

/** Server-side redaction of one log line: known secret shapes, plus whole auth/cookie header lines. */
export function redactLogText(text: string): string {
  return redact(text).replace(HEADER_LINE, "$1 [redacted]");
}

/** FORBIDDEN for callers without `logs:read`, with the next step for the kind of caller (an OAuth client asks for the scope). */
function assertLogsRead(ctx: TenantContext): void {
  try {
    assertPermission(ctx, "logs:read");
  } catch (error) {
    if (error instanceof StudixError && error.code === "FORBIDDEN" && ctx.actor.type === "oauth") {
      throw new StudixError("FORBIDDEN", error.message, {
        ...(error.details ? { details: error.details } : {}),
        suggestedAction:
          'Reconnect the app and grant the "studix:logs" scope. Only a workspace owner can grant it; for other roles ask an owner.',
      });
    }
    throw error;
  }
}

/** `service` is known only for events whose name says where they came from; otherwise it is left out. */
function serviceOf(name: string): LogServiceName | undefined {
  if (name.startsWith("mcp.") || name.startsWith("webmcp.")) return "mcp";
  if (name.startsWith("api.")) return "api";
  return undefined;
}

/** Services an activity event can be attributed to (by its name); worker and render events carry none yet. */
const SERVICES_WITH_EVENTS: readonly LogServiceName[] = ["api", "mcp"];
const NO_SERVICE_REASON = "activity events are not attributed to this service yet, so none can match.";
const MAX_MESSAGE_CHARS = 8 * 1024;

function truncate(text: string): string {
  return text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}… [truncated]` : text;
}

function normalize(event: ActivityEvent, environment: LogEnvironment): LogEvent {
  const service = serviceOf(event.name);
  return {
    eventId: event.id,
    timestamp: event.createdAt.toISOString(),
    level: event.level,
    message: truncate(redactLogText(event.message ?? event.name)),
    environment,
    ...(service ? { service } : {}),
    source: "activity",
    name: event.name,
    ...(event.projectId ? { projectId: event.projectId } : {}),
    ...(event.jobId ? { jobId: event.jobId } : {}),
    ...(event.stage ? { stage: event.stage } : {}),
    ...(event.provider ? { provider: event.provider } : {}),
    ...(event.traceId ? { traceId: event.traceId } : {}),
    ...(event.spanId ? { spanId: event.spanId } : {}),
  };
}

interface CursorPayload {
  v: 1;
  /** Tenant the cursor was issued to. */
  o: string;
  w: string;
  /** Actor, so a cursor cannot be handed to another caller. */
  a: string;
  /** Hash of the filters it continues. */
  h: string;
  /** Last event id returned. */
  id: string;
  /** Tail only: ids delivered inside the trailing window, newest last. */
  seen?: string[];
  /** Tail only: start of the trailing window (epoch ms). */
  floor?: number;
  /** Tail only: late events up to this id were already returned while more were waiting. */
  lu?: string;
  from: string;
  to: string;
  exp: number;
}

function filterHash(parts: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function sign(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

function encodeCursor(secret: string, payload: CursorPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

function invalidCursor(reason: string): StudixError {
  return new StudixError("VALIDATION", `Invalid cursor: ${reason}`, {
    suggestedAction: "Repeat the call without a cursor to start again.",
  });
}

function decodeCursor(secret: string, cursor: string): CursorPayload {
  const [body, mac, extra] = cursor.split(".");
  if (!body || !mac || extra !== undefined) throw invalidCursor("malformed");
  const expected = Buffer.from(sign(secret, body));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    throw invalidCursor("signature does not match");
  }
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
    if (payload.v !== 1) throw invalidCursor("unknown version");
    if (
      payload.seen !== undefined &&
      (!Array.isArray(payload.seen) ||
        payload.seen.length > MAX_SEEN_IDS ||
        payload.seen.some((id) => typeof id !== "string"))
    ) {
      throw invalidCursor("malformed");
    }
    return payload;
  } catch (error) {
    if (error instanceof StudixError) throw error;
    throw invalidCursor("malformed");
  }
}

function parseInstant(name: string, value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new StudixError("VALIDATION", `${name} must be an ISO 8601 date-time`, {
      details: { [name]: value },
    });
  }
  return date;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Unified, tenant-safe log reads. The only connected source is the workspace's activity trail; the other
 * sources are reported as unavailable (or restricted to platform operators), so an empty answer is never
 * mistaken for "no logs anywhere". Every call is audited, including refusals and failures, and the audit
 * record holds filters and counts, never log text.
 */
export function createLogService(deps: LogServiceDeps): LogService {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const tails = new Map<string, number>();

  async function audit(
    ctx: TenantContext,
    action: "logs.query" | "logs.tail",
    outcome: Outcome,
    summary: Record<string, unknown>,
  ): Promise<void> {
    await deps.audit.append(ctx, {
      actor: { type: ctx.actor.type, id: ctx.actor.id },
      action,
      subjectType: "logs",
      data: { ...summary, outcome },
    });
  }

  /** Audit, then rethrow; an audit that cannot be written fails the call rather than skipping the record. */
  async function fail(
    ctx: TenantContext,
    action: "logs.query" | "logs.tail",
    summary: Record<string, unknown>,
    error: unknown,
  ): Promise<never> {
    const code = error instanceof StudixError ? error.code : "INTERNAL";
    const outcome: Outcome =
      code === "FORBIDDEN" || code === "NOT_FOUND"
        ? "forbidden"
        : code === "VALIDATION"
          ? "validation"
          : code === "RATE_LIMITED"
            ? "rate_limited"
            : "upstream";
    try {
      await audit(ctx, action, outcome, { ...summary, code });
    } catch (auditError) {
      deps.logger.error("log query audit not written", {
        action,
        workspaceId: ctx.workspaceId,
        error: auditError instanceof Error ? auditError.message : String(auditError),
      });
    }
    throw error;
  }

  function requestedSources(
    ctx: TenantContext,
    source: LogSource,
    services: readonly LogServiceName[] | undefined,
  ) {
    const system = can(ctx.actor, "logs:system:read");
    const wantsInfra = source !== "all" && source !== "activity";
    if (wantsInfra || services?.includes("infrastructure")) {
      assertPermission(ctx, "logs:system:read");
    }
    assertLogsRead(ctx);
    const sourceStatus: SourceStatus[] = [];
    const wanted: Exclude<LogSource, "all">[] = source === "all" ? ["activity", ...SYSTEM_SOURCES] : [source];
    for (const s of wanted) {
      if (s === "activity") continue;
      sourceStatus.push(
        system
          ? { source: s, status: "unavailable", reason: SYSTEM_SOURCE_REASON }
          : {
              source: s,
              status: "restricted",
              reason: "Infrastructure logs are visible to the platform operator only.",
            },
      );
    }
    return { readsActivity: wanted.includes("activity"), sourceStatus };
  }

  /**
   * Events delivered late: written before the cursor's position in id order but committed after the tail read
   * past it. Reads the trailing window again and returns what the cursor has not seen, oldest id first.
   */
  async function lateEvents(
    ctx: TenantContext,
    q: {
      environment: LogEnvironment;
      jobId: string;
      floor: number;
      to: Date;
      afterId: string;
      seen: ReadonlySet<string>;
      lateAfter?: string | undefined;
      level?: ActivityLevel | undefined;
      services?: readonly LogServiceName[] | undefined;
    },
  ): Promise<{ late: LogEvent[]; window: Map<string, number> }> {
    const levels = levelsFrom(q.level);
    const rows = await deps.activity.window(ctx, {
      from: new Date(q.floor),
      to: q.to,
      jobId: q.jobId,
      ...(levels ? { levels } : {}),
      limit: LATE_READ_LIMIT,
    });
    const wanted: readonly LogServiceName[] | undefined = q.services?.filter((v) => v !== "infrastructure");
    const window = new Map<string, number>();
    const late: LogEvent[] = [];
    for (const row of rows) {
      window.set(row.id, row.createdAt.getTime());
      if (row.id > q.afterId || q.seen.has(row.id) || (q.lateAfter !== undefined && row.id <= q.lateAfter))
        continue;
      const event = normalize(row, q.environment);
      if (wanted && (!event.service || !wanted.includes(event.service))) continue;
      late.push(event);
    }
    return { late, window };
  }

  async function fetchActivity(
    ctx: TenantContext,
    q: {
      environment: LogEnvironment;
      from: Date;
      to: Date;
      level?: ActivityLevel | undefined;
      services?: readonly LogServiceName[] | undefined;
      jobId?: string | undefined;
      projectId?: string | undefined;
      traceId?: string | undefined;
      search?: string | undefined;
      afterId?: string | undefined;
      limit: number;
    },
  ): Promise<{ events: LogEvent[]; resumeId?: string; hasMore: boolean }> {
    const levels = levelsFrom(q.level);
    const wantedServices: readonly LogServiceName[] | undefined = q.services?.filter(
      (s) => s !== "infrastructure",
    );
    const events: LogEvent[] = [];
    let bytes = 0;
    let cursor = q.afterId;
    let hasMore = false;
    // A service filter is applied after the read, so keep reading until the page is full or rows run out.
    for (let round = 0; round < 10 && !hasMore; round++) {
      const rows = await deps.activity.window(ctx, {
        from: q.from,
        to: q.to,
        ...(levels ? { levels } : {}),
        ...(q.jobId ? { jobId: q.jobId } : {}),
        ...(q.projectId ? { projectId: q.projectId } : {}),
        ...(q.traceId ? { traceId: q.traceId } : {}),
        ...(q.search ? { search: q.search } : {}),
        ...(cursor ? { afterId: cursor } : {}),
        limit: q.limit + 1,
      });
      for (const row of rows) {
        const event = normalize(row, q.environment);
        if (wantedServices && (!event.service || !wantedServices.includes(event.service))) {
          cursor = row.id;
          continue;
        }
        const size = Buffer.byteLength(JSON.stringify(event));
        if (events.length >= q.limit || (events.length > 0 && bytes + size > MAX_RESPONSE_BYTES)) {
          hasMore = true;
          break;
        }
        events.push(event);
        bytes += size;
        cursor = row.id;
      }
      if (rows.length <= q.limit) break;
      // More rows exist after a full read that ended without filling the page: keep going (bounded).
      if (round === 9) hasMore = true;
    }
    return { events, ...(cursor ? { resumeId: cursor } : {}), hasMore };
  }

  function mismatch(environment: LogEnvironment): SourceStatus {
    return {
      source: "activity",
      status: "unavailable",
      reason: `This deployment serves ${deps.environment} logs, not ${environment}.`,
    };
  }

  return {
    async query(ctx, input) {
      const summary: Record<string, unknown> = {
        environment: input.environment,
        source: input.source ?? "all",
        ...(input.services ? { services: input.services } : {}),
        ...(input.level ? { level: input.level } : {}),
        ...(input.jobId ? { jobId: input.jobId } : {}),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        ...(input.traceId ? { traceId: input.traceId } : {}),
        ...(input.search ? { searchChars: input.search.length } : {}),
        ...(input.from ? { from: input.from } : {}),
        ...(input.to ? { to: input.to } : {}),
        limit: input.limit ?? DEFAULT_LIMIT,
        ...(input.cursor ? { resumed: true } : {}),
      };
      try {
        const source = input.source ?? "all";
        const { readsActivity, sourceStatus } = requestedSources(ctx, source, input.services);
        const current = now();
        if (input.search !== undefined && input.search.length > MAX_SEARCH_CHARS) {
          throw new StudixError("VALIDATION", `search is at most ${MAX_SEARCH_CHARS} characters`);
        }
        const limit = input.limit ?? DEFAULT_LIMIT;
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
          throw new StudixError("VALIDATION", `limit must be 1..${MAX_LIMIT}`);
        }
        const hash = filterHash({
          e: input.environment,
          s: source,
          sv: input.services ? [...input.services].sort() : null,
          l: input.level ?? null,
          j: input.jobId ?? null,
          p: input.projectId ?? null,
          t: input.traceId ?? null,
          q: input.search ?? null,
        });
        let from: Date;
        let to: Date;
        let afterId: string | undefined;
        if (input.cursor) {
          const payload = decodeCursor(deps.cursorSecret, input.cursor);
          if (
            payload.o !== ctx.organizationId ||
            payload.w !== ctx.workspaceId ||
            payload.a !== ctx.actor.id
          ) {
            throw invalidCursor("it was issued to another caller");
          }
          if (payload.h !== hash) throw invalidCursor("it belongs to a different query");
          if (payload.exp < current.getTime()) throw invalidCursor("it expired");
          if (
            (input.from !== undefined &&
              parseInstant("from", input.from).getTime() !== Date.parse(payload.from)) ||
            (input.to !== undefined && parseInstant("to", input.to).getTime() !== Date.parse(payload.to))
          ) {
            throw invalidCursor("from/to differ from the query it continues");
          }
          // A window that has slid past the retention edge since the first page is clamped, not refused.
          from = new Date(Math.max(Date.parse(payload.from), current.getTime() - LOG_RETENTION_MS));
          to = new Date(payload.to);
          afterId = payload.id || undefined;
        } else {
          to = input.to ? parseInstant("to", input.to) : current;
          from = input.from ? parseInstant("from", input.from) : new Date(to.getTime() - DEFAULT_WINDOW_MS);
        }
        const oldest = current.getTime() - LOG_RETENTION_MS;
        if (from.getTime() < oldest || to.getTime() < oldest) {
          throw new StudixError(
            "VALIDATION",
            "Logs are kept for 7 days: from and to must be within the last 7 days",
            {
              details: { oldest: new Date(oldest).toISOString() },
              suggestedAction: "Use a window inside the last 7 days.",
            },
          );
        }
        if (to.getTime() > current.getTime() + 60_000) {
          throw new StudixError("VALIDATION", "to must not be in the future");
        }
        if (from.getTime() > to.getTime())
          throw new StudixError("VALIDATION", "from must be before or equal to to");

        const statuses = [...sourceStatus];
        let events: LogEvent[] = [];
        let hasMore = false;
        let lastId: string | undefined;
        if (readsActivity) {
          const wanted = input.services?.filter((v) => v !== "infrastructure");
          const matchable = wanted?.filter((v) => SERVICES_WITH_EVENTS.includes(v));
          if (input.environment !== deps.environment) {
            statuses.unshift(mismatch(input.environment));
          } else if (wanted && wanted.length > 0 && matchable?.length === 0) {
            statuses.unshift({ source: "activity", status: "unavailable", reason: NO_SERVICE_REASON });
          } else {
            const page = await fetchActivity(ctx, {
              environment: input.environment,
              from,
              to,
              level: input.level,
              services: input.services,
              jobId: input.jobId,
              projectId: input.projectId,
              traceId: input.traceId,
              search: input.search,
              afterId,
              limit,
            });
            events = page.events;
            hasMore = page.hasMore;
            lastId = page.resumeId;
            const dropped = wanted?.filter((v) => !SERVICES_WITH_EVENTS.includes(v)) ?? [];
            statuses.unshift(
              dropped.length > 0
                ? {
                    source: "activity",
                    status: "partial",
                    reason: `${dropped.join(", ")}: ${NO_SERVICE_REASON}`,
                  }
                : { source: "activity", status: "ok" },
            );
          }
        }
        const activityOk = statuses.some(
          (s) => s.source === "activity" && (s.status === "ok" || s.status === "partial"),
        );
        const allOk = statuses.every((s) => s.status === "ok");
        const coverage: Coverage = allOk ? "complete" : activityOk ? "partial" : "unavailable";
        const nextCursor =
          hasMore && lastId
            ? encodeCursor(deps.cursorSecret, {
                v: 1,
                o: ctx.organizationId,
                w: ctx.workspaceId,
                a: ctx.actor.id,
                h: hash,
                id: lastId,
                from: from.toISOString(),
                to: to.toISOString(),
                exp: current.getTime() + CURSOR_TTL_MS,
              })
            : undefined;
        await audit(ctx, "logs.query", "ok", { ...summary, count: events.length, coverage });
        return { events, ...(nextCursor ? { nextCursor } : {}), hasMore, coverage, sourceStatus: statuses };
      } catch (error) {
        return fail(ctx, "logs.query", summary, error);
      }
    },

    async tail(ctx, input, options) {
      const summary: Record<string, unknown> = {
        environment: input.environment,
        jobId: input.jobId,
        ...(input.services ? { services: input.services } : {}),
        ...(input.level ? { level: input.level } : {}),
        waitSeconds: input.waitSeconds ?? 0,
        ...(input.cursor ? { resumed: true } : {}),
      };
      let held = false;
      try {
        const { sourceStatus } = requestedSources(ctx, "activity", input.services);
        const waitSeconds = input.waitSeconds ?? 0;
        if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > MAX_TAIL_WAIT_SECONDS) {
          throw new StudixError("VALIDATION", `waitSeconds must be 0..${MAX_TAIL_WAIT_SECONDS}`);
        }
        const current = now();
        const hash = filterHash({
          e: input.environment,
          j: input.jobId,
          sv: input.services ? [...input.services].sort() : null,
          l: input.level ?? null,
          tail: true,
        });
        let afterId: string | undefined;
        let floor: number | undefined;
        let seen = new Set<string>();
        let lateAfter: string | undefined;
        if (input.cursor) {
          const payload = decodeCursor(deps.cursorSecret, input.cursor);
          if (
            payload.o !== ctx.organizationId ||
            payload.w !== ctx.workspaceId ||
            payload.a !== ctx.actor.id
          ) {
            throw invalidCursor("it was issued to another caller");
          }
          if (payload.h !== hash) throw invalidCursor("it belongs to a different tail");
          if (payload.exp < current.getTime()) throw invalidCursor("it expired");
          afterId = payload.id || undefined;
          floor = payload.floor;
          lateAfter = payload.lu;
          seen = new Set(payload.seen ?? []);
        }
        const open = tails.get(ctx.workspaceId) ?? 0;
        if (open >= MAX_TAILS_PER_WORKSPACE) {
          throw new StudixError("RATE_LIMITED", "Too many log tails are open for this workspace", {
            retryable: true,
            suggestedAction: "Wait for a running studix_tail_logs call to return, then call again.",
          });
        }
        tails.set(ctx.workspaceId, open + 1);
        held = true;
        const tailServices = input.services?.filter((v) => v !== "infrastructure");
        if (
          tailServices &&
          tailServices.length > 0 &&
          !tailServices.some((v) => SERVICES_WITH_EVENTS.includes(v))
        ) {
          throw new StudixError("VALIDATION", `services: ${NO_SERVICE_REASON}`, {
            suggestedAction: "Omit services to tail every event of the job.",
          });
        }
        // Authorizes the job id: a job outside the caller's workspace is NOT_FOUND here.
        let job = await options.job(ctx, input.jobId);
        if (input.environment !== deps.environment) {
          throw new StudixError(
            "UNAVAILABLE",
            `This deployment serves ${deps.environment} logs, not ${input.environment}.`,
            {
              suggestedAction: `Call studix_tail_logs with environment "${deps.environment}" on this server.`,
            },
          );
        }
        const deadline = current.getTime() + waitSeconds * 1000;
        let page: Awaited<ReturnType<typeof fetchActivity>> = { events: [], hasMore: false };
        let jobDone = job.terminal;
        let delivered: LogEvent[] = [];
        let windowShortened = false;
        for (;;) {
          // Read the job before the events: a job already final here has written everything the read sees.
          job = await options.job(ctx, input.jobId);
          const at = now();
          const to = new Date(at.getTime() + 60_000);
          const trailing =
            afterId !== undefined && floor !== undefined
              ? await lateEvents(ctx, {
                  environment: input.environment,
                  jobId: input.jobId,
                  floor,
                  to,
                  afterId,
                  seen,
                  lateAfter,
                  level: input.level,
                  services: input.services,
                })
              : undefined;
          page = await fetchActivity(ctx, {
            environment: input.environment,
            from: new Date(at.getTime() - LOG_RETENTION_MS),
            to,
            level: input.level,
            services: input.services,
            jobId: input.jobId,
            afterId,
            limit: DEFAULT_LIMIT,
          });
          // Late events go first, within the same count and byte bounds as a page.
          const lateAll = trailing?.late ?? [];
          const late: LogEvent[] = [];
          let lateBytes = 0;
          for (const e of lateAll) {
            const size = Buffer.byteLength(JSON.stringify(e));
            if (
              late.length >= DEFAULT_LIMIT ||
              (late.length > 0 && lateBytes + size > MAX_RESPONSE_BYTES / 2)
            )
              break;
            late.push(e);
            lateBytes += size;
          }
          const lateCut = lateAll.length > late.length;
          // While late events are still waiting, the page is left for the next call so the cursor stays where it is.
          const pageEvents = lateCut ? [] : page.events;
          delivered = [...late, ...pageEvents];
          jobDone = job.terminal && !page.hasMore && !lateCut;
          if (!lateCut && page.resumeId) afterId = page.resumeId;
          if (lateCut) {
            // Late events come in id order, so "returned up to here" is one id, however many there are.
            lateAfter = late[late.length - 1]?.eventId;
            if (lateAfter === undefined) throw new StudixError("INTERNAL", "late events could not be paged");
            floor ??= at.getTime() - TAIL_LOOKBACK_MS;
          } else {
            lateAfter = undefined;
          }
          if (!lateCut) {
            // The window only moves forward. It keeps the ids delivered at or before the cursor, which is all a late
            // event can be confused with, newest MAX_SEEN_IDS of them.
            const known = new Map(trailing?.window ?? []);
            for (const e of delivered) known.set(e.eventId, Date.parse(e.timestamp));
            const wanted = Math.max(floor ?? 0, lateCut ? (floor ?? 0) : at.getTime() - TAIL_LOOKBACK_MS);
            let nextFloor = wanted;
            const tracked = [...known.entries()]
              .filter(([id, ms]) => ms >= nextFloor && (afterId === undefined || id <= afterId))
              .sort(([x], [y]) => (x < y ? -1 : 1));
            if (tracked.length > MAX_SEEN_IDS) {
              const keep = tracked.slice(-MAX_SEEN_IDS);
              // More ids than a cursor can carry: protection starts after the oldest dropped one, and says so.
              const cut = tracked[tracked.length - MAX_SEEN_IDS - 1];
              if (cut) {
                nextFloor = Math.max(nextFloor, cut[1] + 1);
                if (nextFloor > wanted) windowShortened = true;
              }
              seen = new Set(keep.filter(([, ms]) => ms >= nextFloor).map(([id]) => id));
            } else {
              seen = new Set(tracked.map(([id]) => id));
            }
            floor = nextFloor;
          }
          if (delivered.length > 0 || jobDone || options.signal?.aborted) break;
          const remaining = deadline - now().getTime();
          if (remaining <= 0) break;
          await sleep(Math.min(TAIL_POLL_MS, remaining), options.signal);
        }
        const cursorId = afterId ?? "";
        const nextCursor = !jobDone
          ? encodeCursor(deps.cursorSecret, {
              v: 1,
              o: ctx.organizationId,
              w: ctx.workspaceId,
              a: ctx.actor.id,
              h: hash,
              id: cursorId,
              ...(floor !== undefined ? { floor, seen: [...seen].sort() } : {}),
              ...(lateAfter !== undefined ? { lu: lateAfter } : {}),
              from: current.toISOString(),
              to: current.toISOString(),
              exp: now().getTime() + CURSOR_TTL_MS,
            })
          : undefined;
        const statuses: SourceStatus[] = [{ source: "activity", status: "ok" }, ...sourceStatus];
        await audit(ctx, "logs.tail", "ok", { ...summary, count: delivered.length, jobDone });
        return {
          events: delivered,
          ...(nextCursor ? { nextCursor } : {}),
          hasMore: page.hasMore,
          coverage: "complete",
          sourceStatus: statuses,
          jobDone,
          jobStatus: job.status,
          gapDetected: windowShortened,
        };
      } catch (error) {
        return fail(ctx, "logs.tail", summary, error);
      } finally {
        if (held) {
          const left = (tails.get(ctx.workspaceId) ?? 1) - 1;
          if (left <= 0) tails.delete(ctx.workspaceId);
          else tails.set(ctx.workspaceId, left);
        }
      }
    },
  };
}
