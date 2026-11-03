import {
  authorizationServerMetadataPath,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
} from "@studix/auth";
import { StudixError } from "@studix/shared";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from "express";
import { z } from "zod";
import { parseBody, sessionOf } from "../api/api-context.ts";
import type { AppDeps } from "../app-deps.ts";

/** OAuth endpoints a client calls without a Studix session cookie (the code, PKCE or client auth proves it). */
export const OAUTH_REGISTRATION_PATH = "/api/auth/oauth2/register";
export const OAUTH_TOKEN_API_PATHS = [
  "/api/auth/oauth2/token",
  "/api/auth/oauth2/revoke",
  "/api/auth/oauth2/introspect",
  "/api/auth/jwks",
] as const;

/** Anyone may read these cross-origin; none of them carries credentials. */
function openCors(methods: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "WWW-Authenticate",
    });
    if (req.method === "OPTIONS") {
      res
        .set({
          "Access-Control-Allow-Methods": methods,
          "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version, dpop",
          "Access-Control-Max-Age": "600",
        })
        .status(204)
        .end();
      return;
    }
    next();
  };
}

/**
 * Discovery documents (RFC 9728 protected resource, RFC 8414 authorization server) at the host root, plus
 * the token-endpoint family reachable without a cookie. Mounted before the CORS/Origin guard of `/api`,
 * which would otherwise refuse a browser-based client's foreign Origin.
 */
export function mountMcpOAuthDiscovery(
  app: Express,
  deps: AppDeps,
  limiters: { registration: RequestHandler; token: RequestHandler },
): void {
  const oauth = deps.dashboardAuth.mcpOAuth;
  if (!oauth) return;
  const cache = (_req: Request, res: Response, next: NextFunction) => {
    res.set("Cache-Control", "public, max-age=300");
    next();
  };
  const prmPaths = ["/.well-known/oauth-protected-resource", protectedResourceMetadataPath(oauth.resource)];
  const prm = protectedResourceMetadata(oauth.resource, oauth.issuer);
  app.use(prmPaths, openCors("GET, OPTIONS"));
  app.get(prmPaths, cache, (_req, res) => {
    res.json(prm);
  });

  const asPath = authorizationServerMetadataPath(oauth.issuer);
  app.use(asPath, openCors("GET, OPTIONS"));
  app.get(asPath, cache, async (_req, res) => {
    res.json(await oauth.authorizationServerMetadata());
  });

  const forward = (req: Request, res: Response) => {
    // These calls are authenticated by the OAuth exchange itself; a browser cookie must not ride along.
    delete req.headers.cookie;
    void deps.dashboardAuth.nodeHandler(req, res);
  };
  // Registration is rare and abusable: strict per-IP bucket. Token calls come from hosted connectors that
  // share egress IPs across many users (every refresh included), so they get the generous /mcp bucket.
  app.all(OAUTH_REGISTRATION_PATH, openCors("GET, POST, OPTIONS"), limiters.registration, forward);
  app.all([...OAUTH_TOKEN_API_PATHS], openCors("GET, POST, OPTIONS"), limiters.token, forward);
}

const SelectWorkspaceBody = z.object({ workspaceId: z.string().min(1).max(100) }).strict();

/** Session-authenticated helpers of the OAuth consent screens and the "connected apps" list. */
export function mcpOAuthRoutes(deps: AppDeps): express.Router {
  const router = express.Router();
  const oauth = () => {
    const surface = deps.dashboardAuth.mcpOAuth;
    if (!surface) throw new StudixError("UNAVAILABLE", "MCP OAuth is not enabled on this server");
    return surface;
  };

  router.post("/workspace", async (req, res) => {
    const body = parseBody(SelectWorkspaceBody, req.body, "workspace selection");
    await oauth().selectWorkspace(req.headers, body.workspaceId);
    res.status(204).end();
  });

  router.get("/connections", async (_req, res) => {
    const session = sessionOf(res);
    const connections = await oauth().connections.list(session.user.id);
    const names = new Map(session.memberships.map((m) => [m.workspace.id, m]));
    res.json({
      connections: connections.map((c) => ({
        id: c.id,
        clientName: c.clientName,
        workspaceId: c.workspaceId,
        workspaceName: names.get(c.workspaceId)?.workspace.name,
        scopes: c.scopes,
        createdAt: c.createdAt,
      })),
    });
  });

  router.delete("/connections/:id", async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new StudixError("VALIDATION", "Invalid connection id");
    const revoked = await oauth().connections.revoke(sessionOf(res).user.id, id);
    if (!revoked) throw new StudixError("NOT_FOUND", "Connection not found");
    res.status(204).end();
  });

  return router;
}
