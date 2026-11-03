import { randomBytes } from "node:crypto";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { type AuthInfo, createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { MCP_REQUIRED_SCOPE, McpTokenError } from "@studix/auth";
import { GATEWAY_DEPTH_HEADER, parseGatewayDepth } from "@studix/mcp-gateway";
import { activeTraceIds, withSpan } from "@studix/observability";
import { StudixError, toStudixError } from "@studix/shared";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { z } from "zod";
import { type AppDeps, SERVER_NAME, SERVER_VERSION } from "../app-deps.ts";
import type { ArtifactUrlDeps } from "../artifact-urls.ts";
import { HTTP_STATUS } from "../http/http-errors.ts";
import { AGENT_HANDOFF_MCP_TOOLS } from "./agent-handoff-tools.ts";
import { META_TOOL_NAMES } from "./gateway-meta-tools.ts";
import { NATIVE_TOOLS, type NativeTool, type ToolContext } from "./native-tools.ts";
import { errorEnvelope, okEnvelope, ToolEnvelopeSchema } from "./tool-envelope.ts";

/** Upper bound for one JSON-RPC request body (a host-authored VideoIR spec fits comfortably). */
export const MCP_MAX_BODY_BYTES = 2 * 1024 * 1024;

const INSTRUCTIONS =
  "Studix produces videos. Call studix_inspect first. studix_create_video returns a jobId at once; " +
  "poll studix_get_job (respect next[].pollAfterMs) until it succeeds, then use its signed MP4 URL. Revise with studix_feedback, re-render with " +
  "studix_render; a person reviews and approves the storyboard at the returned reviewUrl.";

/** `gatewayDepth`: inbound gateway hop count, so a call relayed through another gateway cannot execute tools. */
type StudixAuthInfo = AuthInfo & { extra: { tenant: ToolContext["tenant"]; gatewayDepth: number } };

function newTraceId(): string {
  return activeTraceIds()?.traceId ?? randomBytes(16).toString("hex");
}

function authFrom(authInfo: AuthInfo | undefined): StudixAuthInfo["extra"] {
  const extra = (authInfo as StudixAuthInfo | undefined)?.extra;
  if (!extra?.tenant?.workspaceId) throw new StudixError("UNAUTHENTICATED", "Missing tenant context");
  return extra;
}

/** Register the native tools (and the gateway's meta-tools when wired) on a per-request server. */
export function buildMcpServer(deps: AppDeps, artifacts: ArtifactUrlDeps, authInfo: AuthInfo | undefined) {
  const { tenant, gatewayDepth } = authFrom(authInfo);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const requestTraceId = newTraceId();
  const tools: readonly NativeTool[] = [...NATIVE_TOOLS, ...AGENT_HANDOFF_MCP_TOOLS] as readonly NativeTool[];
  const toolNames = tools.map((t) => t.name);

  for (const def of tools) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.input as z.ZodObject,
        outputSchema: ToolEnvelopeSchema,
        annotations: {
          readOnlyHint: def.readOnly,
          destructiveHint: def.destructive ?? false,
          idempotentHint: def.readOnly,
          openWorldHint: false,
        },
      },
      async (args: unknown) =>
        withSpan(`mcp.tool ${def.name}`, { attributes: { "studix.tool": def.name } }, async () => {
          const traceId = activeTraceIds()?.traceId ?? requestTraceId;
          const ctx: ToolContext = {
            deps,
            artifacts,
            tenant,
            traceId,
            toolNames: listedToolNames(deps, toolNames),
          };
          try {
            const outcome = await def.run(ctx, args);
            if (def.audited) {
              await deps.activity?.record(tenant, {
                name: `mcp.${def.name}`,
                scope: outcome.scope,
                traceId,
                attributes: { tool: def.name, actorType: tenant.actor.type, actorId: tenant.actor.id },
              });
            }
            return okEnvelope(outcome.data, outcome.next, traceId);
          } catch (err) {
            const error = toStudixError(err);
            deps.logger[error.code === "INTERNAL" ? "error" : "warn"]("mcp tool failed", {
              tool: def.name,
              code: error.code,
              error: error.message,
              traceId,
              workspaceId: tenant.workspaceId,
            });
            return errorEnvelope(error, traceId);
          }
        }),
    );
  }

  deps.metaTools?.(server, { tenant, gatewayDepth, logger: deps.logger, traceId: requestTraceId });
  return server;
}

function listedToolNames(deps: AppDeps, native: string[]): string[] {
  return deps.metaTools ? [...native, ...META_TOOL_NAMES] : native;
}

/** RFC 6750 / RFC 9728 challenge: points OAuth clients at the protected resource metadata. */
function bearerChallenge(deps: AppDeps, failure?: { error: "invalid_token" | "insufficient_scope" }): string {
  const parts = ['realm="studix"'];
  const oauth = deps.dashboardAuth.mcpOAuth;
  if (oauth) parts.push(`resource_metadata="${oauth.resourceMetadataUrl}"`, `scope="${MCP_REQUIRED_SCOPE}"`);
  if (failure) parts.push(`error="${failure.error}"`);
  return `Bearer ${parts.join(", ")}`;
}

function sendAuthFailure(
  deps: AppDeps,
  res: Response,
  error: StudixError,
  failure: "invalid_token" | "insufficient_scope" | "missing",
): void {
  const forbidden = failure === "insufficient_scope";
  res
    .status(forbidden ? HTTP_STATUS.FORBIDDEN : HTTP_STATUS.UNAUTHENTICATED)
    .set("WWW-Authenticate", bearerChallenge(deps, failure === "missing" ? undefined : { error: failure }))
    .json({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32001,
        message: error.message,
        data: { code: error.code, retryable: false, suggestedAction: error.suggestedAction },
      },
    });
}

/**
 * Mount `/mcp`: Streamable HTTP via the SDK's `createMcpHandler`, which serves both the 2026-07-28 per-request
 * protocol and the 2025-era stateless fallback, so TS and Python SDK clients both connect. Stateless: no
 * server-side MCP sessions, every request re-authenticates its bearer key, so revocation applies at once
 * and any replica can serve any request.
 */
export function mountMcpEndpoint(
  app: Express,
  deps: AppDeps,
  artifacts: ArtifactUrlDeps,
  guards: express.RequestHandler[],
  /** Handlers that run once the bearer key is verified (e.g. per-workspace rate limiting). */
  authenticatedGuards: (workspaceKey: (req: Request) => string) => express.RequestHandler[] = () => [],
) {
  const onerror = (error: Error) => deps.logger.error("mcp transport error", { error: error.message });
  const handler = createMcpHandler(({ authInfo }) => buildMcpServer(deps, artifacts, authInfo), {
    onerror,
    maxRequestBodySize: MCP_MAX_BODY_BYTES,
  });
  const node = toNodeHandler(handler, { onerror, maxRequestBodySize: MCP_MAX_BODY_BYTES });

  const authenticate = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const oauth = deps.dashboardAuth.mcpOAuth;
      // `stx_` keys keep their own path; any other bearer is an OAuth access token. No anonymous fallback.
      const tenant = oauth?.isOAuthBearer(req.headers.authorization)
        ? await oauth.authenticate(req.headers.authorization)
        : await deps.apiKeys.authenticate(req.headers.authorization);
      const authInfo: StudixAuthInfo = {
        token: "[redacted]",
        clientId: tenant.actor.id,
        scopes:
          tenant.actor.type === "apiKey" || tenant.actor.type === "oauth" ? [...tenant.actor.scopes] : [],
        extra: { tenant, gatewayDepth: parseGatewayDepth(req.headers[GATEWAY_DEPTH_HEADER]) },
      };
      (req as Request & { auth?: AuthInfo }).auth = authInfo;
      next();
    } catch (err) {
      const error = toStudixError(err);
      if (err instanceof McpTokenError) {
        sendAuthFailure(deps, res, error, err.failure);
        return;
      }
      if (error.code === "UNAUTHENTICATED") {
        const missing = !req.headers.authorization;
        sendAuthFailure(deps, res, error, missing ? "missing" : "invalid_token");
        return;
      }
      deps.logger.error("mcp authentication failed", { code: error.code, error: error.message });
      res.status(HTTP_STATUS[error.code] ?? 500).json({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32603, message: "Authentication unavailable", data: { code: error.code } },
      });
    }
  };

  const workspaceKey = (req: Request) =>
    authFrom((req as Request & { auth?: AuthInfo }).auth).tenant.workspaceId;

  app.all(
    "/mcp",
    ...guards,
    authenticate,
    ...authenticatedGuards(workspaceKey),
    express.json({ limit: MCP_MAX_BODY_BYTES }),
    (req, res) => {
      void node(req, res, req.body);
    },
  );
}
