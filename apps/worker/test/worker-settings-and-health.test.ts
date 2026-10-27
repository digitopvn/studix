import { describe, expect, it } from "vitest";
import { loadWorkerSettings, startHealthServer } from "../src/index.ts";

const DB = "postgres://studix:studix@127.0.0.1:55432/studix";

describe("worker settings", () => {
  it("derives defaults from the shared config", () => {
    const s = loadWorkerSettings({ DATABASE_URL: DB, JOB_LEASE_SECONDS: "30", WORKER_CONCURRENCY: "3" });
    expect(s).toMatchObject({
      databaseUrl: DB,
      concurrency: 3,
      leaseMs: 30_000,
      heartbeatIntervalMs: 10_000,
      healthPort: 8081,
      shutdownGraceMs: 25_000,
      renderCentsPerSecond: 0,
    });
    expect(s.workerId).toMatch(/-\d+$/);
  });

  it("rejects missing DATABASE_URL and malformed worker variables without echoing values", () => {
    expect(() => loadWorkerSettings({})).toThrow(/DATABASE_URL is required/);
    expect(() => loadWorkerSettings({ DATABASE_URL: DB, WORKER_HEALTH_PORT: "99999" })).toThrow(
      /WORKER_HEALTH_PORT/,
    );
    expect(() => loadWorkerSettings({ DATABASE_URL: DB, WORKER_ID: "bad id; rm -rf" })).toThrow(/WORKER_ID/);
  });
});

describe("health server", () => {
  it("serves liveness and readiness probes", async () => {
    let ready = false;
    const server = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      live: () => ({ ok: true }),
      ready: async () => ({ ok: ready, details: { database: ready } }),
    });
    const base = `http://127.0.0.1:${server.port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const notReady = await fetch(`${base}/readyz`);
      expect(notReady.status).toBe(503);
      expect(await notReady.json()).toEqual({ status: "unavailable", database: false });
      ready = true;
      expect((await fetch(`${base}/readyz`)).status).toBe(200);
      expect((await fetch(`${base}/other`)).status).toBe(404);
      expect((await fetch(`${base}/healthz`, { method: "POST" })).status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("reports a failing readiness check as 503", async () => {
    const server = await startHealthServer({
      port: 0,
      host: "127.0.0.1",
      live: () => ({ ok: true }),
      ready: async () => {
        throw new Error("db down");
      },
    });
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/readyz`);
      expect(res.status).toBe(503);
      expect(await res.json()).toMatchObject({ error: "db down" });
    } finally {
      await server.close();
    }
  });
});
