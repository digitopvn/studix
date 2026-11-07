import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { StorageAdapter, TenantContext } from "@studix/core";
import { withTestDatabase } from "@studix/database/testing";
import { createLogger } from "@studix/shared";
import { unwrapValidation, validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { runWorkerProcess, type WorkerPorts } from "../src/index.ts";

const db = withTestDatabase();
const ir = unwrapValidation(
  validateVideoIR(
    JSON.parse(
      readFileSync(
        new URL("../../../packages/video-ir/fixtures/brand-intro-9x16.json", import.meta.url),
        "utf8",
      ),
    ),
  ),
  "fixture",
);

/** Test-only adapters: a planner returning the fixture IR, a file-writing renderer, memory storage. */
function fakePorts(): WorkerPorts & { stored: Map<string, number> } {
  const stored = new Map<string, number>();
  const storage = {
    async put(_ctx: TenantContext, key: string, body: { filePath: string }, opts: { contentType: string }) {
      const bytes = await readFile(body.filePath);
      stored.set(key, bytes.length);
      return {
        key,
        bytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        contentType: opts.contentType,
      };
    },
  } as unknown as StorageAdapter; // only put() is exercised by the video.create workflow without assets
  return {
    stored,
    storage,
    planner: async () => ({ ir, usage: [] }),
    renderer: {
      id: "fake",
      supports: () => ({ supported: true, reasons: [] }),
      async render(_ir, opts) {
        const filePath = join(opts.workDir, "out.mp4");
        await writeFile(filePath, "fake-mp4");
        return {
          filePath,
          mime: "video/mp4",
          probe: { durationMs: 15_000, width: 540, height: 960, fps: 30, videoCodec: "h264", bytes: 8 },
        };
      },
    },
  };
}

describe("worker process", () => {
  it("waits for the database, serves probes, processes jobs and shuts down cleanly", async () => {
    const ports = fakePorts();
    const worker = await runWorkerProcess({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: db.current.url,
        WORKER_HEALTH_PORT: "0",
        WORKER_HEALTH_HOST: "127.0.0.1",
        WORKER_CONCURRENCY: "2",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_ID: "test-worker",
      },
      resolvePorts: async () => ports,
      logger: createLogger({}, { level: "error", write: () => {} }),
      handleSignals: false,
    });
    const base = `http://127.0.0.1:${worker.healthPort}`;
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
    expect((await fetch(`${base}/readyz`)).status).toBe(200);

    const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
      organization: { name: "proc", slug: "proc" },
      workspace: { name: "Main", slug: "main" },
    });
    const ctx: TenantContext = {
      organizationId: organization.id,
      workspaceId: workspace.id,
      actor: { type: "user", id: "usr_1", role: "owner" },
    };
    const project = await db.current.repos.projects.create(ctx, {
      title: "Proc",
      status: "draft",
      brief: { prompt: "intro" },
      createdBy: { type: "user", id: "usr_1" },
    });
    const { job } = await db.current.repos.queue.enqueue(ctx, {
      kind: "video.create",
      projectId: project.id,
      payload: { projectId: project.id },
      createdBy: { type: "user", id: "usr_1" },
    });

    const until = Date.now() + 15_000;
    let status = job.status;
    while (status !== "succeeded" && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 50));
      status = (await db.current.repos.jobs.get(ctx, job.id))!.status;
    }
    expect(status).toBe("succeeded");
    expect(ports.stored.size).toBe(1);

    await worker.shutdown();
    await expect(fetch(`${base}/healthz`)).rejects.toThrow();
  });

  it("reports media presence in /readyz without gating readiness", async () => {
    let checks = 0;
    const ports = {
      ...fakePorts(),
      mediaStatus: async () => {
        checks += 1;
        return {
          executable: "configured" as const,
          state: "ready" as const,
          secretsKey: false,
          vendors: { fal: true, openrouter: false },
        };
      },
    };
    const worker = await runWorkerProcess({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: db.current.url,
        WORKER_HEALTH_PORT: "0",
        WORKER_HEALTH_HOST: "127.0.0.1",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_ID: "media-worker",
      },
      resolvePorts: async () => ports,
      logger: createLogger({}, { level: "error", write: () => {} }),
      handleSignals: false,
    });
    try {
      const base = `http://127.0.0.1:${worker.healthPort}`;
      let body: Record<string, unknown> = {};
      const until = Date.now() + 5_000;
      while (!body.media && Date.now() < until) {
        const res = await fetch(`${base}/readyz`);
        expect(res.status).toBe(200);
        body = (await res.json()) as Record<string, unknown>;
        if (!body.media) await new Promise((r) => setTimeout(r, 20));
      }
      expect(body.media).toEqual({
        executable: "configured",
        state: "ready",
        secretsKey: false,
        vendors: { fal: true, openrouter: false },
      });
      // Repeated probes reuse the cached check instead of spawning `multix check` each time.
      await fetch(`${base}/readyz`);
      expect(checks).toBe(1);
    } finally {
      await worker.shutdown();
    }
  });
});
