import type { Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/create-app.ts";
import { freePort, startTestApp, type TestApp } from "./app-test-harness.ts";

/** Two app instances over one database stand in for two replicas behind a load balancer. */
describe("rate limits shared across replicas", () => {
  let a: TestApp;
  let replicaB: Server;
  let baseB: string;

  beforeAll(async () => {
    a = await startTestApp({
      trustProxy: 1,
      rateLimits: {
        mcpIp: { capacity: 3, refillPerSecond: 0.001 },
        mcp: { capacity: 3, refillPerSecond: 0.001 },
      },
    });
    const port = await freePort();
    baseB = `http://127.0.0.1:${port}`;
    replicaB = await new Promise((resolve) => {
      const s = createApp({ ...a.deps }).listen(port, "127.0.0.1", () => resolve(s));
    });
  });

  afterAll(async () => {
    replicaB.closeAllConnections();
    await new Promise<void>((resolve) => replicaB.close(() => resolve()));
    await a.close();
  });

  const call = (base: string, ip: string, token?: string) =>
    fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "x-forwarded-for": ip,
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: "{}",
    });

  it("counts one client IP against a single bucket on both replicas", async () => {
    const statuses = [
      (await call(a.base, "203.0.113.7")).status,
      (await call(baseB, "203.0.113.7")).status,
      (await call(a.base, "203.0.113.7")).status,
      (await call(baseB, "203.0.113.7")).status,
      (await call(a.base, "203.0.113.7")).status,
    ];
    expect(statuses).toEqual([401, 401, 401, 429, 429]);
    expect((await call(baseB, "203.0.113.8")).status).toBe(401);
  });

  it("limits /mcp per workspace regardless of IP, and keeps workspaces independent", async () => {
    const busy = await a.createKey(await a.provisionTenant("busy"));
    const quiet = await a.createKey(await a.provisionTenant("quiet"));
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      statuses.push((await call(i % 2 ? baseB : a.base, `198.51.100.${i + 1}`, busy)).status);
    }
    expect(statuses.slice(0, 3).every((s) => s !== 429)).toBe(true);
    expect(statuses.slice(3)).toEqual([429, 429]);
    expect((await call(baseB, "198.51.100.99", quiet)).status).not.toBe(429);
  });

  it("answers 429 with Retry-After and the error envelope", async () => {
    for (let i = 0; i < 3; i++) await call(a.base, "192.0.2.50");
    const res = await call(baseB, "192.0.2.50");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
  });
});
