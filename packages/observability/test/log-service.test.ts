import type { ActivityLevel, Job, JobStatus, TenantContext } from "@studix/core";
import {
  createInMemoryActivityRepository,
  createInMemoryAuditRepository,
  testTenant,
} from "@studix/core/testing";
import { createLogger, createManualClock, StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createLogService, LOG_RETENTION_DAYS, type LogQueryInput } from "../src/index.ts";

const START = new Date("2026-11-08T12:00:00Z");
const HOUR = 3_600_000;
const quiet = createLogger({}, { write: () => undefined });

function setup(options: { environment?: "production" | "development" } = {}) {
  const clock = createManualClock(START);
  const activity = createInMemoryActivityRepository(clock);
  const audit = createInMemoryAuditRepository(clock);
  const owner = testTenant({ role: "owner" });
  const jobs = new Map<string, { workspaceId: string; status: JobStatus; endedAt?: Date }>();
  const sleeps: number[] = [];
  const service = createLogService({
    activity,
    audit,
    jobs: {
      async get(ctx: TenantContext, id: string) {
        const job = jobs.get(id);
        return job && job.workspaceId === ctx.workspaceId
          ? ({ id, status: job.status, updatedAt: job.endedAt ?? START } as Job)
          : undefined;
      },
    },
    environment: options.environment ?? "production",
    secret: "test-secret-test-secret",
    logger: quiet,
    clock,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
    },
  });
  const log = (
    ctx: TenantContext,
    over: { name?: string; level?: ActivityLevel; message?: string; jobId?: string } = {},
  ) =>
    activity.append(ctx, {
      name: over.name ?? "stage.started",
      level: over.level ?? "info",
      ...(over.message !== undefined ? { message: over.message } : {}),
      ...(over.jobId ? { jobId: over.jobId } : {}),
      attributes: {},
    });
  return { clock, activity, audit, owner, jobs, service, log, sleeps };
}

const base: LogQueryInput = { environment: "production", source: "activity" };

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof StudixError ? error.code : "other";
  }
  return "no error";
}

describe("studix_query_logs service", () => {
  it("returns the workspace's events newest first, normalized and redacted", async () => {
    const { owner, service, log, clock } = setup();
    clock.advance(1000);
    await log(owner, { message: "first" });
    clock.advance(1000);
    await log(owner, { message: "calling with Bearer abcdefghijklmnop", jobId: "job_1" });
    const result = await service.query(owner, base);
    expect(result.events.map((e) => e.message)).toEqual(["calling with Bearer [redacted]", "first"]);
    expect(result.events[0]).toMatchObject({
      level: "info",
      environment: "production",
      source: "activity",
      jobId: "job_1",
    });
    expect(result.events[0]?.timestamp).toBe("2026-11-08T12:00:02.000Z");
    expect(result.events[0]).not.toHaveProperty("service");
    expect(result.coverage).toBe("complete");
  });

  it("never claims complete coverage for sources that are not connected", async () => {
    const { owner, service, log } = setup();
    await log(owner);
    const result = await service.query(owner, { environment: "production" });
    expect(result.coverage).toBe("partial");
    expect(result.sourceStatus.activity?.status).toBe("ok");
    expect(result.sourceStatus.cloudflare?.status).toBe("unavailable");
    expect(result.sourceStatus.build?.status).toBe("unavailable");
    const build = await service.query(owner, { environment: "production", source: "build" });
    expect(build).toMatchObject({ events: [], coverage: "unavailable" });
  });

  it("answers unavailable for an environment this server does not serve", async () => {
    const { owner, service, log } = setup({ environment: "development" });
    await log(owner);
    const result = await service.query(owner, base);
    expect(result).toMatchObject({ events: [], coverage: "unavailable" });
    expect(result.sourceStatus.activity?.reason).toContain("development");
  });

  it("holds the 7-day window and rejects bad ranges", async () => {
    const { owner, service, clock } = setup();
    const day = 24 * HOUR;
    const edge = new Date(clock.now().getTime() - LOG_RETENTION_DAYS * day + 1000);
    expect((await service.query(owner, { ...base, from: edge })).events).toEqual([]);
    const eight = new Date(clock.now().getTime() - 8 * day);
    expect(await code(service.query(owner, { ...base, from: eight }))).toBe("VALIDATION");
    const now = clock.now();
    expect(await code(service.query(owner, { ...base, from: now, to: new Date(now.getTime() - 1) }))).toBe(
      "VALIDATION",
    );
    expect(await code(service.query(owner, { ...base, to: new Date(now.getTime() + 10 * 60_000) }))).toBe(
      "VALIDATION",
    );
  });

  it("filters by level and search and pages without gaps or repeats", async () => {
    const { owner, service, log, clock } = setup();
    for (let i = 0; i < 5; i++) {
      clock.advance(10);
      await log(owner, { level: i % 2 ? "error" : "info", message: `line ${i} needle` });
    }
    const errors = await service.query(owner, { ...base, level: "warn" });
    expect(errors.events.map((e) => e.message)).toEqual(["line 3 needle", "line 1 needle"]);
    expect((await service.query(owner, { ...base, search: "LINE 2" })).events).toHaveLength(1);

    const seen: string[] = [];
    let page = await service.query(owner, { ...base, limit: 2 });
    for (;;) {
      seen.push(...page.events.map((e) => e.eventId));
      if (!page.nextCursor) break;
      page = await service.query(owner, { ...base, limit: 2, cursor: page.nextCursor });
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort().reverse()).toEqual(seen);
  });

  it("keeps the first page's window when continuing with a cursor", async () => {
    const { owner, service, log, clock } = setup();
    for (let i = 0; i < 3; i++) {
      clock.advance(10);
      await log(owner);
    }
    const first = await service.query(owner, { ...base, limit: 2 });
    clock.advance(5 * 60_000);
    const second = await service.query(owner, { ...base, limit: 2, cursor: first.nextCursor });
    expect(second.events).toHaveLength(1);
    expect(second.window).toEqual(first.window);
  });

  it("refuses a cursor that is forged, expired or reused with other filters, tenants or environments", async () => {
    const { owner, service, log, clock } = setup();
    for (let i = 0; i < 3; i++) await log(owner);
    const page = await service.query(owner, { ...base, limit: 1 });
    const cursor = page.nextCursor as string;
    const tampered = `${cursor.slice(0, -2)}${cursor.endsWith("AA") ? "BB" : "AA"}`;
    expect(await code(service.query(owner, { ...base, limit: 1, cursor: tampered }))).toBe("VALIDATION");
    expect(await code(service.query(owner, { ...base, limit: 1, cursor: "x.y" }))).toBe("VALIDATION");
    expect(await code(service.query(owner, { ...base, limit: 1, level: "error", cursor }))).toBe(
      "VALIDATION",
    );
    const other = testTenant({ role: "owner" });
    expect(await code(service.query(other, { ...base, limit: 1, cursor }))).toBe("VALIDATION");
    expect(await code(service.query(owner, { ...base, environment: "development", limit: 1, cursor }))).toBe(
      "VALIDATION",
    );
    clock.advance(11 * 60_000);
    expect(await code(service.query(owner, { ...base, limit: 1, cursor }))).toBe("VALIDATION");
  });

  it("denies roles without logs:read and records the refusal", async () => {
    const { audit, service, log, owner } = setup();
    await log(owner);
    for (const role of ["admin", "editor", "reviewer", "viewer"] as const) {
      const ctx = { ...owner, actor: { type: "user", id: `usr_${role}`, role } } as TenantContext;
      expect(await code(service.query(ctx, base))).toBe("FORBIDDEN");
    }
    const ctx = testTenant({
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      scopes: ["project:read"],
    });
    expect(await code(service.tail(ctx, { jobId: "job_1", environment: "production" }))).toBe("FORBIDDEN");
    const entries = await audit.list(owner);
    expect(entries.items.filter((e) => e.data?.outcome === "forbidden")).toHaveLength(5);
  });

  it("does not let an API key or OAuth token act as the platform operator", async () => {
    const { service, owner } = setup();
    const forged = testTenant({
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      scopes: ["logs:system:read"],
    });
    expect(await code(service.query(forged, base))).toBe("FORBIDDEN");
    const granted = testTenant({
      organizationId: owner.organizationId,
      workspaceId: owner.workspaceId,
      scopes: ["logs:read"],
    });
    expect(await code(service.query(granted, base))).toBe("no error");
  });

  it("treats another workspace's job as not found", async () => {
    const { owner, service, jobs } = setup();
    jobs.set("job_foreign", { workspaceId: "wks_other", status: "running" });
    expect(await code(service.query(owner, { ...base, jobId: "job_foreign" }))).toBe("NOT_FOUND");
    expect(await code(service.tail(owner, { jobId: "job_foreign", environment: "production" }))).toBe(
      "NOT_FOUND",
    );
  });

  it("audits success, bad requests and failures without storing log text or search terms", async () => {
    const { owner, service, audit, log, clock } = setup();
    await log(owner, { message: "secret-looking text" });
    await service.query(owner, { ...base, search: "secret-looking" });
    await code(service.query(owner, { ...base, from: new Date(clock.now().getTime() - 9 * 24 * HOUR) }));
    const items = (await audit.list(owner)).items;
    expect(items.map((e) => e.data?.outcome).sort()).toEqual(["ok", "validation"]);
    const ok = items.find((e) => e.data?.outcome === "ok");
    expect(ok?.data).toMatchObject({ count: 1, request: { searchLength: 14 } });
    expect(JSON.stringify(items)).not.toContain("secret-looking");
    expect(items[0]).toMatchObject({ action: expect.stringMatching(/^logs\./), subjectType: "logs" });
  });

  it("withholds results when the audit record cannot be written", async () => {
    const clock = createManualClock(START);
    const activity = createInMemoryActivityRepository(clock);
    const owner = testTenant({ role: "owner" });
    const service = createLogService({
      activity,
      jobs: { get: async () => undefined },
      audit: { append: async () => Promise.reject(new Error("db down")), list: async () => ({ items: [] }) },
      environment: "production",
      secret: "test-secret-test-secret",
      logger: quiet,
      clock,
    });
    await activity.append(owner, { name: "x", level: "info", attributes: {} });
    expect(await code(service.query(owner, base))).toBe("UNAVAILABLE");
  });

  it("reports a failing activity store as an error, not as zero logs", async () => {
    const clock = createManualClock(START);
    const owner = testTenant({ role: "owner" });
    const audit = createInMemoryAuditRepository(clock);
    const service = createLogService({
      activity: {
        append: async () => Promise.reject(new Error("unused")),
        list: async () => Promise.reject(new Error("connection refused")),
        listAfter: async () => [],
      },
      jobs: { get: async () => undefined },
      audit,
      environment: "production",
      secret: "test-secret-test-secret",
      logger: quiet,
      clock,
    });
    const result = await service.query(owner, base);
    expect(result.events).toEqual([]);
    expect(result.coverage).toBe("unavailable");
    expect(result.sourceStatus.activity).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("connection refused");
  });
});

describe("studix_tail_logs service", () => {
  const SETTLE = 2000;

  it("streams a job's settled events oldest first, then reports done once the job has ended and settled", async () => {
    const { owner, service, log, jobs, clock } = setup();
    jobs.set("job_1", { workspaceId: owner.workspaceId, status: "running" });
    await log(owner, { jobId: "job_1", message: "a" });
    await log(owner, { jobId: "job_1", message: "b" });
    await log(owner, { jobId: "job_2", message: "other job" });
    clock.advance(SETTLE);
    const first = await service.tail(owner, { jobId: "job_1", environment: "production" });
    expect(first.events.map((e) => e.message)).toEqual(["a", "b"]);
    expect(first).toMatchObject({ done: false, gapDetected: false, jobStatus: "running" });
    expect(first.coverage).toBe("partial");

    await log(owner, { jobId: "job_1", message: "c" });
    clock.advance(SETTLE);
    jobs.set("job_1", { workspaceId: owner.workspaceId, status: "succeeded", endedAt: clock.now() });
    clock.advance(SETTLE);
    const second = await service.tail(owner, {
      jobId: "job_1",
      environment: "production",
      cursor: first.nextCursor,
    });
    expect(second.events.map((e) => e.message)).toEqual(["c"]);
    expect(second.done).toBe(false);
    const third = await service.tail(owner, {
      jobId: "job_1",
      environment: "production",
      cursor: second.nextCursor,
    });
    expect(third).toMatchObject({ events: [], done: true, jobStatus: "succeeded" });
  });

  it("holds back events newer than the settle margin so a late commit is not skipped", async () => {
    const { owner, service, log, jobs, clock } = setup();
    jobs.set("job_1", { workspaceId: owner.workspaceId, status: "running" });
    await log(owner, { jobId: "job_1", message: "old" });
    clock.advance(SETTLE + 1);
    await log(owner, { jobId: "job_1", message: "fresh" });
    const first = await service.tail(owner, { jobId: "job_1", environment: "production" });
    expect(first.events.map((e) => e.message)).toEqual(["old"]);
    clock.advance(SETTLE);
    const second = await service.tail(owner, {
      jobId: "job_1",
      environment: "production",
      cursor: first.nextCursor,
    });
    expect(second.events.map((e) => e.message)).toEqual(["fresh"]);
  });

  it("does not report done until a finished job has had time for its last events", async () => {
    const { owner, service, jobs, clock } = setup();
    jobs.set("job_1", { workspaceId: owner.workspaceId, status: "cancelled", endedAt: clock.now() });
    const early = await service.tail(owner, { jobId: "job_1", environment: "production" });
    expect(early).toMatchObject({ events: [], done: false, jobStatus: "cancelled" });
    clock.advance(SETTLE);
    const settled = await service.tail(owner, { jobId: "job_1", environment: "production" });
    expect(settled.done).toBe(true);
  });

  it("ends for a finished job when the environment is not served, instead of polling forever", async () => {
    const { owner, service, jobs } = setup({ environment: "development" });
    jobs.set("job_1", { workspaceId: owner.workspaceId, status: "succeeded" });
    const result = await service.tail(owner, { jobId: "job_1", environment: "production" });
    expect(result).toMatchObject({ coverage: "unavailable", done: true });
  });

  it("waits at most waitSeconds, polling at an interval instead of spinning", async () => {
    const { owner, service, jobs, sleeps } = setup();
    jobs.set("job_1", { workspaceId: owner.workspaceId, status: "running" });
    const result = await service.tail(owner, { jobId: "job_1", environment: "production", waitSeconds: 3 });
    expect(result).toMatchObject({ events: [], done: false });
    expect(sleeps).toEqual([1000, 1000, 1000]);
    const none = await service.tail(owner, { jobId: "job_1", environment: "production", waitSeconds: 0 });
    expect(none.events).toEqual([]);
  });

  it("returns as soon as an event settles during the wait", async () => {
    const { owner, service, jobs, log } = setup();
    jobs.set("job_1", { workspaceId: owner.workspaceId, status: "running" });
    await log(owner, { jobId: "job_1", message: "late" });
    const result = await service.tail(owner, { jobId: "job_1", environment: "production", waitSeconds: 10 });
    expect(result.events.map((e) => e.message)).toEqual(["late"]);
  });

  it("resumes from an expired cursor and flags the gap; forged cursors are refused", async () => {
    const { owner, service, jobs, log, clock } = setup();
    jobs.set("job_1", { workspaceId: owner.workspaceId, status: "running" });
    await log(owner, { jobId: "job_1", message: "a" });
    clock.advance(SETTLE);
    const first = await service.tail(owner, { jobId: "job_1", environment: "production" });
    await log(owner, { jobId: "job_1", message: "b" });
    clock.advance(11 * 60_000);
    const resumed = await service.tail(owner, {
      jobId: "job_1",
      environment: "production",
      cursor: first.nextCursor,
    });
    expect(resumed.gapDetected).toBe(true);
    expect(resumed.events.map((e) => e.message)).toEqual(["b"]);
    expect(
      await code(service.tail(owner, { jobId: "job_1", environment: "production", cursor: "nope.nope" })),
    ).toBe("VALIDATION");
  });
});

describe("what a log line says", () => {
  it("shows an allowlisted, redacted summary of attributes when an event has no message", async () => {
    const { owner, service, activity } = setup();
    await activity.append(owner, {
      name: "agent.event",
      level: "error",
      attributes: {
        type: "tool_start",
        name: "bash",
        error: "ffmpeg failed with Bearer abcdefghijklmnopqrstuvwx",
        args: { secret: "never shown" },
      },
    });
    const result = await service.query(owner, base);
    expect(result.events[0]?.message).toBe(
      "agent.event type=tool_start name=bash error=ffmpeg failed with Bearer [redacted]",
    );
    expect(JSON.stringify(result)).not.toContain("never shown");
    // The search reaches the same stored text.
    expect((await service.query(owner, { ...base, search: "ffmpeg" })).events).toHaveLength(1);
  });

  it("lets page 2 through even when the window began near the 7-day limit", async () => {
    const { owner, service, log, clock } = setup();
    for (let i = 0; i < 3; i++) await log(owner);
    const from = new Date(clock.now().getTime() - LOG_RETENTION_DAYS * 86_400_000 + 60_000);
    const first = await service.query(owner, { ...base, from, limit: 2 });
    clock.advance(5 * 60_000);
    const second = await service.query(owner, { ...base, limit: 2, cursor: first.nextCursor });
    expect(second.events).toHaveLength(1);
  });
});
