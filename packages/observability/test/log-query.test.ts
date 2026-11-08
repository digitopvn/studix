import type { ActivityEvent, AuditEvent, TenantContext } from "@studix/core";
import {
  createInMemoryActivityRepository,
  createInMemoryAuditRepository,
  testTenant,
} from "@studix/core/testing";
import { createLogger, createManualClock, StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import {
  createLogService,
  type JobProbe,
  type LogService,
  redactLogText,
  TRAILING_WINDOW_MS,
} from "../src/log-query.ts";

// Fixture credentials are assembled at runtime so no literal looks like a real secret to scanners.
const fake = (...parts: string[]) => parts.join("");
const NOW = new Date("2026-11-08T12:00:00.000Z");
const DAY = 24 * 3600 * 1000;

function setup(overrides: { environment?: "production" | "development"; auditFails?: boolean } = {}) {
  let current = NOW;
  const clock = createManualClock(NOW);
  const activity = createInMemoryActivityRepository(clock);
  const audit = createInMemoryAuditRepository(clock);
  const audited: Array<Pick<AuditEvent, "action" | "data" | "actor">> = [];
  const logger = createLogger({}, { write: () => {} });
  const service: LogService = createLogService({
    activity,
    audit: {
      append: async (ctx, input) => {
        if (overrides.auditFails) throw new Error("db down");
        audited.push(input);
        return audit.append(ctx, input);
      },
    },
    environment: overrides.environment ?? "production",
    cursorSecret: "test-secret",
    logger,
    now: () => current,
    sleep: async (ms) => {
      current = new Date(current.getTime() + ms);
    },
  });
  const seed = async (ctx: TenantContext, input: Partial<ActivityEvent> & { name: string }, at?: Date) => {
    if (at) clock.set(at);
    return activity.append(ctx, { level: "info", attributes: {}, ...input });
  };
  return { service, seed, audited, clock };
}

const owner = (workspace = "wsp_a") =>
  testTenant({ organizationId: "org_a", workspaceId: workspace, role: "owner" });

const base = { environment: "production" as const };

async function code(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof StudixError ? error.code : "OTHER";
  }
  return "none";
}

describe("studix_query_logs service", () => {
  it("returns normalized, redacted, ordered workspace events and marks other sources partial", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    await seed(
      ctx,
      { name: "job.created", jobId: "job_1", projectId: "prj_1", traceId: "t1" },
      new Date(NOW.getTime() - 60_000),
    );
    await seed(
      ctx,
      {
        name: "provider.call",
        level: "error",
        message: `failed with ${fake("Bear", "er ")}${fake("abcdefgh", "ijklmnop")}`,
        jobId: "job_1",
        stage: "render",
        provider: "fal",
      },
      new Date(NOW.getTime() - 30_000),
    );
    const result = await service.query(ctx, base);
    expect(result.events.map((e) => e.name)).toEqual(["job.created", "provider.call"]);
    expect(result.events[1]).toMatchObject({
      level: "error",
      message: "failed with Bearer [redacted]",
      environment: "production",
      source: "activity",
      jobId: "job_1",
      stage: "render",
      provider: "fal",
    });
    expect(result.events[1]).not.toHaveProperty("service");
    expect(result.coverage).toBe("partial");
    expect(result.sourceStatus.find((s) => s.source === "activity")?.status).toBe("ok");
    expect(result.sourceStatus.find((s) => s.source === "cloudflare")?.status).toBe("restricted");
    const activityOnly = await service.query(ctx, { ...base, source: "activity" });
    expect(activityOnly.coverage).toBe("complete");
  });

  it("filters by level, job, trace and search text", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    const at = (s: number) => new Date(NOW.getTime() - s * 1000);
    await seed(ctx, { name: "a", level: "debug", jobId: "job_1" }, at(50));
    await seed(
      ctx,
      { name: "b", level: "warn", jobId: "job_2", traceId: "t9", message: "Disk 100% full_now" },
      at(40),
    );
    await seed(ctx, { name: "c", level: "error", jobId: "job_1" }, at(30));
    expect((await service.query(ctx, { ...base, level: "warn" })).events.map((e) => e.name)).toEqual([
      "b",
      "c",
    ]);
    expect((await service.query(ctx, { ...base, jobId: "job_1" })).events.map((e) => e.name)).toEqual([
      "a",
      "c",
    ]);
    expect((await service.query(ctx, { ...base, traceId: "t9" })).events.map((e) => e.name)).toEqual(["b"]);
    expect((await service.query(ctx, { ...base, search: "100% full" })).events.map((e) => e.name)).toEqual([
      "b",
    ]);
  });

  it("never returns another workspace's events", async () => {
    const { service, seed } = setup();
    await seed(owner("wsp_b"), { name: "secret.other", jobId: "job_x" }, new Date(NOW.getTime() - 1000));
    const result = await service.query(owner("wsp_a"), { ...base, jobId: "job_x" });
    expect(result.events).toEqual([]);
  });

  it("pages with a signed cursor without losing or repeating events", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    for (let i = 0; i < 5; i++) await seed(ctx, { name: `e${i}` }, new Date(NOW.getTime() - (10 - i) * 1000));
    const first = await service.query(ctx, { ...base, limit: 2 });
    expect(first.hasMore).toBe(true);
    const second = await service.query(ctx, { ...base, limit: 2, cursor: first.nextCursor });
    const third = await service.query(ctx, { ...base, limit: 2, cursor: second.nextCursor });
    expect([...first.events, ...second.events, ...third.events].map((e) => e.name)).toEqual([
      "e0",
      "e1",
      "e2",
      "e3",
      "e4",
    ]);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeUndefined();
  });

  it("pages through events that share a timestamp without losing or repeating any", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    const t = new Date(NOW.getTime() - 10_000);
    for (let i = 0; i < 7; i++) await seed(ctx, { name: `same.${i}` }, t);
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const result = await service.query(ctx, { ...base, limit: 3, ...(cursor ? { cursor } : {}) });
      seen.push(...result.events.map((e) => e.name ?? ""));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(seen.sort()).toEqual(Array.from({ length: 7 }, (_, i) => `same.${i}`));
  });

  it("pages a burst denser than a cursor can remember to the end, with no repeats and no gaps", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    const start = NOW.getTime() - 60_000;
    // 500 events inside 14 s: more than the ids one cursor holds plus a page.
    for (let i = 0; i < 500; i++) {
      await seed(ctx, { name: `burst.${String(i).padStart(3, "0")}` }, new Date(start + i * 28));
    }
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const result = await service.query(ctx, { ...base, limit: 100, ...(cursor ? { cursor } : {}) });
      seen.push(...result.events.map((e) => e.name ?? ""));
      cursor = result.nextCursor;
      pages++;
    } while (cursor && pages < 30);
    expect(pages).toBeLessThan(30);
    expect(seen).toHaveLength(500);
    expect(new Set(seen).size).toBe(500);
  });

  it("rejects a cursor that is tampered with, reused for other filters, or issued to another caller", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    for (let i = 0; i < 3; i++)
      await seed(ctx, { name: `e${i}`, level: "error" }, new Date(NOW.getTime() - (10 - i) * 1000));
    const page = await service.query(ctx, { ...base, limit: 1, level: "error" });
    const cursor = page.nextCursor as string;
    expect(await code(service.query(ctx, { ...base, limit: 1, level: "error", cursor: `${cursor}x` }))).toBe(
      "VALIDATION",
    );
    const [body] = cursor.split(".");
    expect(
      await code(service.query(ctx, { ...base, limit: 1, level: "error", cursor: `${body}.AAAA` })),
    ).toBe("VALIDATION");
    expect(await code(service.query(ctx, { ...base, limit: 1, level: "warn", cursor }))).toBe("VALIDATION");
    expect(
      await code(service.query(ctx, { ...base, limit: 1, level: "error", cursor, source: "activity" })),
    ).toBe("VALIDATION");
    const otherActor = testTenant({
      organizationId: "org_a",
      workspaceId: "wsp_a",
      actor: { type: "user", id: "someone-else", role: "owner" },
    });
    expect(await code(service.query(otherActor, { ...base, limit: 1, level: "error", cursor }))).toBe(
      "VALIDATION",
    );
    expect(await code(service.query(owner("wsp_b"), { ...base, limit: 1, level: "error", cursor }))).toBe(
      "VALIDATION",
    );
  });

  it("enforces the 7-day window, ordering and bounds", async () => {
    const { service } = setup();
    const ctx = owner();
    const iso = (ms: number) => new Date(NOW.getTime() + ms).toISOString();
    expect(await code(service.query(ctx, { ...base, from: iso(-8 * DAY), to: iso(0) }))).toBe("VALIDATION");
    expect(await code(service.query(ctx, { ...base, from: iso(-DAY), to: iso(-2 * DAY) }))).toBe(
      "VALIDATION",
    );
    expect(await code(service.query(ctx, { ...base, from: "yesterday" }))).toBe("VALIDATION");
    expect(await code(service.query(ctx, { ...base, limit: 201 }))).toBe("VALIDATION");
    expect(await code(service.query(ctx, { ...base, search: "x".repeat(201) }))).toBe("VALIDATION");
    expect(await code(service.query(ctx, { ...base, from: iso(-7 * DAY + 1000), to: iso(0) }))).toBe("none");
  });

  it("denies roles without logs:read and system access to anyone but the operator", async () => {
    const { service } = setup();
    for (const role of ["admin", "editor", "reviewer", "viewer"] as const) {
      expect(await code(service.query(testTenant({ role }), base))).toBe("FORBIDDEN");
    }
    expect(await code(service.query(owner(), { ...base, source: "cloudflare" }))).toBe("FORBIDDEN");
    expect(await code(service.query(owner(), { ...base, source: "application" }))).toBe("FORBIDDEN");
    expect(await code(service.query(owner(), { ...base, services: ["infrastructure"] }))).toBe("FORBIDDEN");
    const keyWithSystemScope = testTenant({ scopes: ["logs:read", "logs:system:read"] });
    expect(await code(service.query(keyWithSystemScope, { ...base, source: "build" }))).toBe("FORBIDDEN");
    const operator = testTenant({ role: "operator" });
    const result = await service.query(operator, { ...base, source: "cloudflare" });
    expect(result.coverage).toBe("unavailable");
    expect(result.events).toEqual([]);
    expect(result.sourceStatus[0]).toMatchObject({ source: "cloudflare", status: "unavailable" });
  });

  it("tells each kind of denied caller how to get access", async () => {
    const { service } = setup();
    const hint = async (ctx: TenantContext) => {
      try {
        await service.query(ctx, base);
      } catch (error) {
        return error instanceof StudixError ? error.suggestedAction : undefined;
      }
      return undefined;
    };
    const oauth = testTenant({
      organizationId: "org_a",
      workspaceId: "wsp_a",
      actor: { type: "oauth", id: "usr_1", clientId: "cli_1", scopes: [] },
    });
    expect(await hint(oauth)).toContain("studix:logs");
    expect(await hint(testTenant({ organizationId: "org_a", workspaceId: "wsp_a", scopes: [] }))).toContain(
      "logs:read",
    );
    expect(
      await hint(testTenant({ organizationId: "org_a", workspaceId: "wsp_a", role: "admin" })),
    ).toContain("workspace owner");
  });

  it("does not present another environment's question as an empty result", async () => {
    const { service, seed } = setup({ environment: "development" });
    await seed(owner(), { name: "x" }, new Date(NOW.getTime() - 1000));
    const result = await service.query(owner(), { environment: "production", source: "activity" });
    expect(result.events).toEqual([]);
    expect(result.coverage).toBe("unavailable");
    expect(result.sourceStatus[0]?.reason).toContain("development");
  });

  it("filters by service only where the event says it", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    await seed(ctx, { name: "mcp.studix_create_video" }, new Date(NOW.getTime() - 3000));
    await seed(ctx, { name: "job.failed" }, new Date(NOW.getTime() - 2000));
    const mcp = await service.query(ctx, { ...base, services: ["mcp"], source: "activity" });
    expect(mcp.events.map((e) => e.name)).toEqual(["mcp.studix_create_video"]);
    expect(mcp.events[0]?.service).toBe("mcp");
    const worker = await service.query(ctx, { ...base, services: ["worker"], source: "activity" });
    expect(worker.events).toEqual([]);
  });

  it("audits success, denial, validation failure and upstream failure without log text", async () => {
    const { service, seed, audited } = setup();
    const ctx = owner();
    await seed(ctx, { name: "x", message: "top secret text" }, new Date(NOW.getTime() - 1000));
    await service.query(ctx, { ...base, search: "top secret" });
    await code(service.query(testTenant({ role: "viewer" }), base));
    await code(service.query(ctx, { ...base, limit: 999 }));
    expect(audited.map((a) => (a.data as { outcome: string }).outcome)).toEqual([
      "ok",
      "forbidden",
      "validation",
    ]);
    expect(audited[0]?.data).toMatchObject({ count: 1, searchChars: 10, coverage: "partial" });
    expect(JSON.stringify(audited)).not.toContain("top secret");
    expect(audited.every((a) => a.action === "logs.query")).toBe(true);
  });

  it("fails the call when the audit record cannot be written", async () => {
    const { service } = setup({ auditFails: true });
    expect(await code(service.query(owner(), base))).not.toBe("none");
  });

  it("bounds the response size", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    const big = "m".repeat(20_000);
    for (let i = 0; i < 12; i++)
      await seed(ctx, { name: `e${i}`, message: big }, new Date(NOW.getTime() - (20 - i) * 1000));
    const page = await service.query(ctx, { ...base, limit: 200 });
    expect(page.events.length).toBeLessThan(12);
    expect(page.hasMore).toBe(true);
    expect(JSON.stringify(page.events).length).toBeLessThanOrEqual(64 * 1024 + 200);
  });
});

describe("redactLogText", () => {
  it("hides secrets across lines, headers, URLs and cookies", () => {
    const text = [
      "GET https://x.test/a?token=abc123def456&ok=1",
      `Authorization: ${fake("Ba", "sic ")}${fake("dXNlcjpw", "YXNzd29yZA==")}`,
      "Cookie: session=abc; other=zzz999",
      "Set-Cookie: sid=1234; HttpOnly",
      `${fake("-----BEGIN ", "PRIVATE KEY-----")}\n${fake("MIIBVQIB", "ADANBgkq")}\nabcdef\n${fake("-----END ", "PRIVATE KEY-----")}`,
      `postgres://user:${fake("hunter2", "hunter2")}@db/x`,
      `{"api_key": "${fake("sk-", "abcdefghijklmnopqrstuv")}"}`,
    ].join("\n");
    const out = redactLogText(text);
    for (const leaked of [
      "abc123def456",
      "dXNlcjpwYXNzd29yZA",
      "zzz999",
      "sid=1234",
      "MIIBVQIBADANBgkq",
      "hunter2hunter2",
      "sk-abcdefghij",
    ]) {
      expect(out).not.toContain(leaked);
    }
  });
});

describe("studix_tail_logs service", () => {
  const running: JobProbe = async () => ({ status: "running", terminal: false });
  const input = { ...base, jobId: "job_1" };

  it("returns new events, then continues from the cursor and stops with the job", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    await seed(ctx, { name: "stage.start", jobId: "job_1" }, new Date(NOW.getTime() - 5000));
    const first = await service.tail(ctx, input, { job: running });
    expect(first.events.map((e) => e.name)).toEqual(["stage.start"]);
    expect(first.jobDone).toBe(false);
    expect(first.gapDetected).toBe(false);
    expect(first.nextCursor).toBeDefined();
    await seed(ctx, { name: "stage.end", jobId: "job_1" }, new Date(NOW.getTime() - 2000));
    await seed(ctx, { name: "other.job", jobId: "job_2" }, new Date(NOW.getTime() - 1000));
    const second = await service.tail(
      ctx,
      { ...input, cursor: first.nextCursor },
      { job: async () => ({ status: "succeeded", terminal: true }) },
    );
    expect(second.events.map((e) => e.name)).toEqual(["stage.end"]);
    expect(second.jobDone).toBe(true);
    expect(second.jobStatus).toBe("succeeded");
    expect(second.nextCursor).toBeUndefined();
  });

  it("waits a bounded time when nothing is new and then returns a cursor", async () => {
    const { service } = setup();
    let polls = 0;
    const result = await service.tail(
      owner(),
      { ...input, waitSeconds: 3 },
      {
        job: async () => {
          polls++;
          return { status: "running", terminal: false };
        },
      },
    );
    expect(result.events).toEqual([]);
    expect(result.jobDone).toBe(false);
    expect(polls).toBeGreaterThan(0);
  });

  it("rejects a job outside the workspace, bad waits and foreign cursors, and audits them", async () => {
    const { service, seed, audited } = setup();
    const ctx = owner();
    await seed(ctx, { name: "x", jobId: "job_1" }, new Date(NOW.getTime() - 1000));
    const notFound: JobProbe = async () => {
      throw new StudixError("NOT_FOUND", "Job not found");
    };
    expect(await code(service.tail(ctx, input, { job: notFound }))).toBe("NOT_FOUND");
    expect(await code(service.tail(ctx, { ...input, waitSeconds: 11 }, { job: running }))).toBe("VALIDATION");
    expect(await code(service.tail(testTenant({ role: "editor" }), input, { job: running }))).toBe(
      "FORBIDDEN",
    );
    const first = await service.tail(ctx, input, { job: running });
    expect(
      await code(service.tail(ctx, { ...input, jobId: "job_2", cursor: first.nextCursor }, { job: running })),
    ).toBe("VALIDATION");
    expect(
      audited.filter((a) => a.action === "logs.tail").map((a) => (a.data as { outcome: string }).outcome),
    ).toEqual(["forbidden", "validation", "forbidden", "ok", "validation"]);
  });

  it("does not report the job done before delivering events written as it finished", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    await seed(ctx, { name: "stage.start", jobId: "job_1" }, new Date(NOW.getTime() - 5000));
    // The job turns final only after the probe has been read once: the final event must still arrive.
    let reads = 0;
    const probe: JobProbe = async () => {
      reads++;
      if (reads === 2)
        await seed(ctx, { name: "job.failed", jobId: "job_1" }, new Date(NOW.getTime() - 1000));
      return reads >= 2 ? { status: "failed", terminal: true } : { status: "running", terminal: false };
    };
    const first = await service.tail(ctx, input, { job: probe });
    const names = first.events.map((e) => e.name);
    const second = first.jobDone
      ? first
      : await service.tail(ctx, { ...input, cursor: first.nextCursor }, { job: probe });
    expect([...names, ...(second === first ? [] : second.events.map((e) => e.name))]).toEqual([
      "stage.start",
      "job.failed",
    ]);
  });

  it("delivers an event another process committed late, once, and never repeats delivered ones", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    await seed(ctx, { name: "worker.a", jobId: "job_1" }, at(5000));
    await seed(ctx, { name: "worker.b", jobId: "job_1" }, at(3000));
    const first = await service.tail(ctx, input, { job: running });
    expect(first.events.map((e) => e.name)).toEqual(["worker.a", "worker.b"]);
    // The API process had stamped this event before worker.b, but its write only landed now.
    await seed(ctx, { name: "api.late", jobId: "job_1" }, at(4000));
    const second = await service.tail(ctx, { ...input, cursor: first.nextCursor }, { job: running });
    expect(second.events.map((e) => e.name)).toEqual(["api.late"]);
    const third = await service.tail(ctx, { ...input, cursor: second.nextCursor }, { job: running });
    expect(third.events).toEqual([]);
  });

  it("lets a tail of a busy job finish: the job turns done once every event was delivered", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    const start = NOW.getTime() - 30_000;
    for (let i = 0; i < 450; i++) {
      await seed(ctx, { name: `busy.${i}`, jobId: "job_1" }, new Date(start + i * 25));
    }
    const done: JobProbe = async () => ({ status: "succeeded", terminal: true });
    let cursor: string | undefined;
    let delivered = 0;
    let finished = false;
    for (let call = 0; call < 20 && !finished; call++) {
      const result = await service.tail(ctx, { ...input, ...(cursor ? { cursor } : {}) }, { job: done });
      delivered += result.events.length;
      cursor = result.nextCursor;
      finished = result.jobDone;
    }
    expect(finished).toBe(true);
    expect(delivered).toBe(450);
  });

  it("does not look back past the trailing window", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    const at = (ms: number) => new Date(NOW.getTime() - ms);
    await seed(ctx, { name: "newest", jobId: "job_1" }, at(1000));
    const first = await service.tail(ctx, input, { job: running });
    await seed(ctx, { name: "ancient", jobId: "job_1" }, at(1000 + TRAILING_WINDOW_MS + 1));
    const second = await service.tail(ctx, { ...input, cursor: first.nextCursor }, { job: running });
    expect(second.events).toEqual([]);
  });

  it("gives a cursor while the job runs even before any event exists", async () => {
    const { service } = setup();
    const ctx = owner();
    const first = await service.tail(ctx, input, { job: running });
    expect(first.events).toEqual([]);
    expect(first.nextCursor).toBeDefined();
    const again = await service.tail(ctx, { ...input, cursor: first.nextCursor }, { job: running });
    expect(again.jobDone).toBe(false);
  });

  it("says so when a service filter can never match, and truncates huge messages", async () => {
    const { service, seed } = setup();
    const ctx = owner();
    await seed(ctx, { name: "x", message: "m".repeat(20_000) }, new Date(NOW.getTime() - 1000));
    const worker = await service.query(ctx, { ...base, services: ["worker"], source: "activity" });
    expect(worker.coverage).toBe("unavailable");
    expect(worker.sourceStatus[0]?.status).toBe("unavailable");
    const mixed = await service.query(ctx, { ...base, services: ["worker", "mcp"], source: "activity" });
    expect(mixed.coverage).toBe("partial");
    expect(await code(service.tail(ctx, { ...input, services: ["render"] }, { job: running }))).toBe(
      "VALIDATION",
    );
    const all = await service.query(ctx, { ...base, source: "activity" });
    expect(all.events[0]?.message.length).toBeLessThan(9000);
  });

  it("limits concurrent tails per workspace", async () => {
    const { service } = setup();
    const ctx = owner();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slow: JobProbe = async () => {
      await gate;
      return { status: "running", terminal: false };
    };
    const open = Array.from({ length: 4 }, () => service.tail(ctx, input, { job: slow }));
    await new Promise((r) => setTimeout(r, 20));
    expect(await code(service.tail(ctx, input, { job: slow }))).toBe("RATE_LIMITED");
    release();
    await Promise.all(open);
    expect(await code(service.tail(ctx, input, { job: running }))).toBe("none");
  });
});
