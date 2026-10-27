import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApp, type TestApp } from "./app-test-harness.ts";

const BURST = 4;

describe("shared rate limits (Postgres buckets)", () => {
  let app: TestApp;
  beforeAll(async () => {
    app = await startTestApp({
      sharedRateLimits: true,
      rateLimits: {
        mcp: { capacity: BURST, refillPerSecond: 0.001 },
        auth: { capacity: 2, refillPerSecond: 0.001 },
      },
    });
  });
  afterAll(() => app.close());

  it("limits /mcp per workspace and persists the buckets in Postgres", async () => {
    const ctx = await app.provisionTenant("rl-mcp");
    const key = await app.createKey(ctx);
    const call = () =>
      fetch(`${app.base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
      });
    const statuses: number[] = [];
    for (let i = 0; i < BURST + 2; i++) statuses.push((await call()).status);
    expect(statuses.slice(0, BURST).every((s) => s !== 429)).toBe(true);
    const refused = await call();
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect((await refused.json()).error.code).toBe("RATE_LIMITED");

    const rows = await app.db.client`select key from rate_limit_buckets where key like 'mcp:%'`;
    expect(rows.map((r) => r.key)).toContain(`mcp:${ctx.workspaceId}`);
  });

  it("limits /api/auth per client IP", async () => {
    const hit = () => fetch(`${app.base}/api/auth/get-session`);
    expect((await hit()).status).not.toBe(429);
    expect((await hit()).status).not.toBe(429);
    expect((await hit()).status).toBe(429);
    const rows = await app.db.client`select key from rate_limit_buckets where key like 'auth:%'`;
    expect(rows).toHaveLength(1);
  });
});
