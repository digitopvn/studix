import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createServer } from "node:net";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { findPiModel, isRuntimeKeyProvider } from "@studix/agent-runtime";
import {
  createApiKeyService,
  createDashboardAuth,
  createModelPreferenceService,
  createProviderConnectionService,
  createSecretBox,
  type ProviderKeyTester,
} from "@studix/auth";
import {
  createAgentHandoffService,
  createDefaultApprovalPolicy,
  createExternalSkillService,
  type ProviderJobInspector,
  type Role,
  StudioService,
  type TenantContext,
} from "@studix/core";
import { createTestDatabase, insertTestUser, type TestDatabase } from "@studix/database/testing";
import { createActivityRecorder } from "@studix/observability";
import { createLogger, newId, systemClock } from "@studix/shared";
import { createGitHubSkillSource } from "@studix/skills";
import { InMemoryStorageAdapter } from "@studix/storage";
import type { AppDeps } from "../src/app-deps.ts";
import { packStageOutputValidator } from "../src/compose-integrations.ts";
import { createApp } from "../src/create-app.ts";
import type { ArtifactUrlSigner } from "../src/ports.ts";

export const TEST_SECRET = "test-dashboard-secret-0123456789-abcdef";

/** Storage signer stand-in: deterministic URLs that encode tenant, key and TTL for assertions. */
export const fakeSigner: ArtifactUrlSigner = {
  async signedUrl(ctx, key, options) {
    return `https://storage.test/${ctx.workspaceId}/${key}?ttl=${options?.expiresInSeconds ?? 0}`;
  },
};

/** Key tester stand-in: no network; a key containing "rejected" is refused like an HTTP 401. */
export const fakeKeyTester: ProviderKeyTester = {
  async test(apiKey) {
    const base = { at: new Date(), latencyMs: 1 };
    return apiKey.includes("rejected")
      ? {
          ...base,
          ok: false,
          verdict: "invalid",
          httpStatus: 401,
          error: { code: "UNAUTHENTICATED", message: "The provider rejected the API key", retryable: false },
        }
      : { ...base, ok: true, verdict: "available", httpStatus: 200 };
  },
};

/** A stand-in for `atlas status`: every `pred_*` id is a just-created upscale; anything else is unknown. */
export const FAKE_ATLAS_MODEL = "atlascloud/upscaler";
export const fakeAtlas: ProviderJobInspector = {
  async inspectJob(job) {
    if (job.provider !== "atlas" || !job.id.startsWith("pred_")) return undefined;
    return { model: FAKE_ATLAS_MODEL, createdAt: new Date().toISOString() };
  },
};

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Swappable GitHub transport so a test chooses which fake repositories the skill source sees. */
export interface GitHubTransport {
  fetch: typeof globalThis.fetch;
}

export interface TestApp {
  /** Replace `github.fetch` to serve different fake repositories to the external skill source. */
  github: GitHubTransport;
  db: TestDatabase;
  base: string;
  deps: AppDeps;
  provisionTenant(slug: string): Promise<TenantContext>;
  createKey(ctx: TenantContext, role?: Role): Promise<string>;
  connect(token: string): Promise<Client>;
  signUp(email: string): Promise<string>;
  api(
    method: string,
    path: string,
    options?: { cookie?: string; body?: unknown; origin?: string },
  ): Promise<Response>;
  close(): Promise<void>;
}

/**
 * Real HTTP app on a fresh, migrated Postgres database: Postgres repositories, StudioService, API keys and
 * Better Auth exactly as composed in production; only storage/connectors/meta-tools are injected by tests.
 */
export async function startTestApp(overrides: Partial<AppDeps> = {}): Promise<TestApp> {
  const db = await createTestDatabase();
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const logger = createLogger({ service: "studix-app-test" }, { level: "error" });
  const repos = db.repos;
  const github: GitHubTransport = {
    fetch: async () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
  };
  const providers = createProviderConnectionService({
    connections: repos.providerConnections,
    audit: repos.audit,
    tester: fakeKeyTester,
    isSupportedProvider: isRuntimeKeyProvider,
    secrets: createSecretBox(randomBytes(32)),
  });
  const deps: AppDeps = {
    logger,
    publicUrl: base,
    appUrl: base,
    allowedHosts: ["127.0.0.1", "localhost"],
    studio: new StudioService({
      ...repos,
      providerJobs: fakeAtlas,
      approvalPolicy: createDefaultApprovalPolicy({ costThresholdCents: 1000 }),
      clock: systemClock,
    }),
    repos,
    apiKeys: createApiKeyService({ directory: repos.directory, apiKeys: repos.apiKeys, env: "test" }),
    dashboardAuth: createDashboardAuth({
      db: db.db,
      directory: repos.directory,
      secret: TEST_SECRET,
      baseUrl: base,
      rateLimit: false,
      mcpOAuth: { resource: `${base}/mcp` },
    }),
    limits: {
      defaultJobBudgetCents: 500,
      defaultJobDeadlineSeconds: 1800,
      approvalCostThresholdCents: 1000,
      signedUrlTtlSeconds: 600,
    },
    storage: fakeSigner,
    rateLimitStore: repos.rateLimits,
    providers,
    modelPreferences: createModelPreferenceService({
      preferences: repos.modelPreferences,
      providers,
      audit: repos.audit,
      knownModel: (provider, modelId) => findPiModel(provider, modelId) !== undefined,
    }),
    activity: createActivityRecorder(repos.activity, { logger }),
    readiness: [{ name: "database", check: async () => void (await db.client`select 1`) }],
    agentHandoffs: createAgentHandoffService({
      handoffs: repos.agentHandoffs,
      validateOutput: packStageOutputValidator(),
    }),
    externalSkills: createExternalSkillService({
      skills: repos.externalSkills,
      source: createGitHubSkillSource({ fetch: (input, init) => github.fetch(input, init) }),
      storage: new InMemoryStorageAdapter(),
    }),
    ...overrides,
  };
  const app = createApp(deps);
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, "127.0.0.1", () => resolve(s));
  });
  const clients: Client[] = [];

  return {
    github,
    db,
    base,
    deps,
    async provisionTenant(slug) {
      const userId = newId("usr");
      await insertTestUser(db, { id: userId, email: `${slug}-${userId}@example.test` });
      const { organization, workspace } = await repos.directory.provisionWorkspace({
        organization: { name: slug, slug: `${slug}-${userId.slice(-8)}` },
        workspace: { name: "Main", slug: "main" },
        ownerUserId: userId,
      });
      return {
        organizationId: organization.id,
        workspaceId: workspace.id,
        actor: { type: "user", id: userId, role: "owner" },
      };
    },
    async createKey(ctx, role = "editor") {
      return (await deps.apiKeys.create(ctx, { name: `${role}-key`, role })).secret;
    },
    async connect(token) {
      const client = new Client({ name: "studix-test", version: "1.0.0" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
          requestInit: { headers: { Authorization: `Bearer ${token}` } },
        }),
      );
      clients.push(client);
      return client;
    },
    async signUp(email) {
      const res = await fetch(`${base}/api/auth/sign-up/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email, password: "a-long-test-password", name: email.split("@")[0] }),
      });
      if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${await res.text()}`);
      return res.headers
        .getSetCookie()
        .map((c) => c.split(";")[0]!)
        .join("; ");
    },
    api(method, path, options = {}) {
      const headers: Record<string, string> = { origin: options.origin ?? base };
      if (options.cookie) headers.cookie = options.cookie;
      if (options.body !== undefined) headers["content-type"] = "application/json";
      return fetch(`${base}${path}`, {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
      });
    },
    async close() {
      await Promise.allSettled(clients.map((c) => c.close()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await db.destroy();
    },
  };
}
