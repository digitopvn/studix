import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createFakeClaudeTransport } from "@studix/agent-runtime";
import { createProviderConnectionService, createSecretBox, type ProviderKeyTester } from "@studix/auth";
import {
  createDefaultApprovalPolicy,
  type StorageAdapter,
  StudioService,
  type TenantContext,
} from "@studix/core";
import { insertTestUser, withTestDatabase } from "@studix/database/testing";
import { createLogger, systemClock } from "@studix/shared";
import type { Planner } from "@studix/workflow";
import { describe, expect, it } from "vitest";
import { runWorkerProcess, type WorkerPorts } from "../src/index.ts";
import { createClaudePlanner, createPlannerRouter } from "../src/planner/claude-planner.ts";

const db = withTestDatabase();
const logger = createLogger({}, { level: "error", write: () => {} });
const ir = JSON.parse(
  readFileSync(new URL("../../../packages/video-ir/fixtures/brand-intro-9x16.json", import.meta.url), "utf8"),
);
const KEY_A = "sk-ant-api03-e2eworkspaceaaaaaaaaaaaaaa-AAAA";
const KEY_B = "sk-ant-api03-e2epersonalbbbbbbbbbbbbbbbb-BBBB";
const acceptAll: ProviderKeyTester = {
  async test() {
    return { ok: true, verdict: "available", httpStatus: 200, at: new Date(), latencyMs: 1 };
  },
};

async function tenant(slug: string) {
  const ownerId = `usr_${slug.replace(/-/g, "")}`;
  await insertTestUser(db.current, { id: ownerId, email: `${slug}@example.test` });
  const { organization, workspace } = await db.current.repos.directory.provisionWorkspace({
    organization: { name: slug, slug },
    workspace: { name: "Main", slug: "main" },
    ownerUserId: ownerId,
  });
  const as = (actor: TenantContext["actor"]): TenantContext => ({
    organizationId: organization.id,
    workspaceId: workspace.id,
    actor,
  });
  return {
    owner: as({ type: "user", id: ownerId, role: "owner" }),
    alice: as({ type: "user", id: `${ownerId}_alice`, role: "editor" }),
    mcpKey: as({ type: "apiKey", id: `key_${ownerId}`, scopes: ["project:write", "workspace:read"] }),
  };
}

/**
 * MCP/dashboard -> StudioService -> durable job -> worker -> planner router -> Claude planner (fake SDK
 * transport, real credential service on Postgres) -> validated VideoIR -> render -> upload -> usage.
 */
describe("Claude planner end to end (fake transport)", () => {
  it("plans with the selected key, renders, records usage, and refuses keys the job may not use", async () => {
    const repos = db.current.repos;
    const providers = createProviderConnectionService({
      connections: repos.providerConnections,
      audit: repos.audit,
      tester: acceptAll,
      secrets: createSecretBox(randomBytes(32)),
    });
    const transport = createFakeClaudeTransport(() => [
      {
        type: "usage",
        turns: 2,
        inputTokens: 3000,
        outputTokens: 1500,
        costUsd: 0.031,
        model: "claude-test",
      },
      { type: "result", output: ir },
    ]);
    const defaultPlanner: Planner = async () => {
      throw new Error("default planner must not run for a Claude job");
    };
    const stored = new Map<string, number>();
    const ports: WorkerPorts = {
      planner: createPlannerRouter({
        default: defaultPlanner,
        claude: createClaudePlanner({
          transport,
          credentials: providers,
          executions: repos.usage,
          model: "claude-test",
          maxTurns: 4,
          maxCostCents: 100,
          timeoutMs: 30_000,
          logger,
        }),
      }),
      storage: {
        async put(_ctx: TenantContext, key: string) {
          stored.set(key, 8);
          return { key, bytes: 8, sha256: "0".repeat(64), contentType: "video/mp4" };
        },
      } as unknown as StorageAdapter,
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
    const studio = new StudioService({
      ...repos,
      approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 100_000 }),
      clock: systemClock,
    });
    const worker = await runWorkerProcess({
      env: {
        NODE_ENV: "test",
        DATABASE_URL: db.current.url,
        WORKER_HEALTH_PORT: "0",
        WORKER_HEALTH_HOST: "127.0.0.1",
        WORKER_POLL_INTERVAL_MS: "20",
        WORKER_ID: "claude-e2e",
      },
      resolvePorts: async () => ports,
      logger,
      handleSignals: false,
    });
    try {
      const a = await tenant("claude-e2e-a");
      const b = await tenant("claude-e2e-b");
      const workspaceKey = await providers.saveApiKey(a.owner, { owner: "workspace", apiKey: KEY_A });
      const personalKey = await providers.saveApiKey(a.owner, { owner: "user", apiKey: KEY_B });

      const settle = async (ctx: TenantContext, jobId: string) => {
        const until = Date.now() + 15_000;
        for (;;) {
          const job = (await repos.jobs.get(ctx, jobId))!;
          if (["succeeded", "failed", "cancelled"].includes(job.status) || Date.now() > until) return job;
          await new Promise((r) => setTimeout(r, 50));
        }
      };
      const create = (ctx: TenantContext, providerConnectionId: string) =>
        studio.createVideoProject(ctx, {
          brief: { prompt: "Brand intro for Acme Coffee" },
          planner: { runtime: "claude", providerConnectionId },
        });

      // A member plans with the workspace key; the job renders and records Anthropic usage.
      const ok = await create(a.alice, workspaceKey.id);
      const done = await settle(a.alice, ok.job.id);
      expect(done.status).toBe("succeeded");
      expect(stored.size).toBe(1);
      expect(transport.requests.map((r) => r.credential)).toEqual([KEY_A]);
      const usage = await repos.usage.list(a.alice);
      const planUsage = usage.items.filter((u) => u.jobId === ok.job.id && u.kind === "provider.decision");
      expect(planUsage).toHaveLength(1);
      expect(planUsage[0]).toMatchObject({ costCents: 3.1 });
      const executions = await repos.usage.listProviderExecutions(a.alice, { jobId: ok.job.id });
      expect(executions.items).toEqual([
        expect.objectContaining({ provider: "anthropic", status: "succeeded", costCents: 3.1 }),
      ]);
      expect(planUsage[0]?.providerExecutionId).toBe(executions.items[0]?.id);

      // Another member cannot spend the owner's personal key, and nothing else is substituted.
      const notMine = await settle(a.alice, (await create(a.alice, personalKey.id)).job.id);
      expect(notMine).toMatchObject({
        status: "failed",
        error: expect.objectContaining({ code: "FORBIDDEN" }),
      });

      // A job created through an MCP API key cannot use a personal key either.
      const viaMcp = await settle(a.mcpKey, (await create(a.mcpKey, personalKey.id)).job.id);
      expect(viaMcp.error?.code).toBe("FORBIDDEN");

      // Tenant B cannot reach tenant A's connection id at all.
      const crossTenant = await settle(b.owner, (await create(b.owner, workspaceKey.id)).job.id);
      expect(crossTenant).toMatchObject({
        status: "failed",
        error: expect.objectContaining({ code: "UNAVAILABLE" }),
      });

      // Only the first job ever reached the agent, each refused job failed once without retries.
      expect(transport.requests).toHaveLength(1);
      for (const job of [notMine, viaMcp, crossTenant]) expect(job.attempts).toBe(1);
    } finally {
      await worker.shutdown();
    }
  });
});
