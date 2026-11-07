import { hostHeaderValidation } from "@modelcontextprotocol/express";
import { StudixError } from "@studix/shared";
import express, { type Express } from "express";
import { apiKeyRoutes, connectorRoutes, providerRoutes } from "./api/admin-routes.ts";
import { agentChatRoutes } from "./api/agent-chat-routes.ts";
import { requireSession } from "./api/api-context.ts";
import { mountOAuthDiscovery, oauthRoutes } from "./api/oauth-routes.ts";
import { platformRoutes, workspaceStorageRoutes } from "./api/platform-routes.ts";
import { skillRoutes } from "./api/skill-routes.ts";
import { studioRoutes } from "./api/studio-routes.ts";
import { webhookRoutes } from "./api/webhook-routes.ts";
import { webmcpRoutes } from "./api/webmcp-routes.ts";
import { type AppDeps, SERVER_VERSION } from "./app-deps.ts";
import type { ArtifactUrlDeps } from "./artifact-urls.ts";
import { mountDashboardStatic } from "./http/dashboard-static.ts";
import { mountHealthRoutes } from "./http/health-routes.ts";
import { apiErrorHandler } from "./http/http-errors.ts";
import {
  createSharedLimiter,
  createTokenBucketLimiter,
  DEFAULT_RATE_LIMITS,
  rateLimit,
  type TokenBucketOptions,
} from "./http/rate-limit.ts";
import { corsAndOriginGuard, originOf, securityHeaders, uniqueHostnames } from "./http/request-guards.ts";
import { mountMcpEndpoint } from "./mcp/mcp-endpoint.ts";

/** Dashboard JSON bodies are small; videos are never uploaded through /api in P0. */
const API_BODY_LIMIT = "256kb";

/**
 * The `STUDIX_ROLE=app` HTTP surface. Order matters:
 * 1. Host allow-list (DNS rebinding) and security headers on everything.
 * 2. Health probes (no auth, no body).
 * 3. CORS/Origin guard for /mcp and /api.
 * 4. Better Auth at /api/auth/* before any body parser (it reads its own body), and the public list of
 *    enabled SSO providers at /api/sso-providers.
 * 5. /mcp (API key) and /api (session), each rate limited. /mcp is limited per client IP before the key is
 *    checked and per workspace after; /api/auth per IP. Buckets live in Postgres when a store is wired.
 * 6. Dashboard static files with SPA fallback.
 */
export function createApp(deps: AppDeps): Express {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", deps.trustProxy ?? false);
  app.set("query parser", "simple");

  const artifacts: ArtifactUrlDeps = {
    renders: deps.repos.renders,
    storage: deps.storage,
    ttlSeconds: deps.limits.signedUrlTtlSeconds,
    logger: deps.logger,
  };
  const limits = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
  const store = deps.rateLimitStore;
  const limiterFor = (options: TokenBucketOptions) =>
    store ? createSharedLimiter(store, options, deps.logger) : createTokenBucketLimiter(options);
  const authLimiter = limiterFor(limits.auth);
  const mcpIpLimiter = limiterFor(limits.mcpIp);
  const mcpWorkspaceLimiter = limiterFor(limits.mcp);
  const apiLimiter = limiterFor(limits.api);
  const originGuard = corsAndOriginGuard([...new Set([originOf(deps.appUrl), originOf(deps.publicUrl)])]);

  app.use(hostHeaderValidation(uniqueHostnames(deps.allowedHosts)));
  app.use(securityHeaders({ https: deps.publicUrl.startsWith("https://") }));

  mountHealthRoutes(app, { version: SERVER_VERSION, checks: deps.readiness ?? [], logger: deps.logger });

  const oauth = deps.dashboardAuth.mcpOAuth;
  if (oauth) mountOAuthDiscovery(app, deps, oauth, rateLimit(apiLimiter, "api"));

  mountMcpEndpoint(app, deps, artifacts, [originGuard, rateLimit(mcpIpLimiter, "mcp")], (workspaceKey) => [
    rateLimit(mcpWorkspaceLimiter, "mcp-ws", workspaceKey),
  ]);

  app.use("/api", originGuard, (_req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });
  // Public: the sign-in page asks which SSO buttons to show before anyone has a session.
  // Uses the general /api bucket so loading the page does not spend the strict sign-in budget.
  app.get("/api/sso-providers", rateLimit(apiLimiter, "api"), (_req, res) => {
    res.json({ providers: deps.dashboardAuth.ssoProviders });
  });
  app.all("/api/auth/*splat", rateLimit(authLimiter, "auth"), (req, res) => {
    void deps.dashboardAuth.nodeHandler(req, res);
  });

  const api = express.Router();
  api.use(
    rateLimit(apiLimiter, "api"),
    express.json({ limit: API_BODY_LIMIT }),
    requireSession(deps.dashboardAuth),
  );
  if (oauth) api.use("/oauth", oauthRoutes(oauth));
  api.use("/api-keys", apiKeyRoutes(deps));
  api.use("/connectors", connectorRoutes(deps));
  api.use("/providers", providerRoutes(deps));
  api.use("/platform", platformRoutes(deps));
  api.use("/workspace-storage", workspaceStorageRoutes(deps));
  api.use("/skills", skillRoutes(deps));
  api.use("/webhook", webhookRoutes(deps));
  api.use(agentChatRoutes(deps));
  api.use(studioRoutes(deps, artifacts));
  api.use(webmcpRoutes(deps, artifacts));
  api.use(() => {
    throw new StudixError("NOT_FOUND", "Unknown API route");
  });
  api.use(apiErrorHandler(deps.logger));
  app.use("/api", api);

  mountDashboardStatic(app, { dist: deps.dashboardDist, mediaOrigins: deps.mediaOrigins ?? [] });
  return app;
}
