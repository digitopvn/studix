import type { McpOAuth } from "@studix/auth";
import {
  type Express,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
  Router,
} from "express";
import { z } from "zod";
import type { AppDeps } from "../app-deps.ts";
import { idParam, parseBody, sessionOf } from "./api-context.ts";

const SelectWorkspaceBody = z.object({ workspaceId: z.string().min(1).max(100) }).strict();

/** Endpoints a browser-based MCP client calls cross-origin without cookies. */
const PUBLIC_OAUTH_PATHS = ["/api/auth/oauth2/token", "/api/auth/oauth2/register", "/api/auth/oauth2/revoke"];

/** Discovery documents are public and read by any client origin; nothing here is credentialed. */
function publicCors(methods: string): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    res.set({
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": methods,
      "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version",
      "Access-Control-Max-Age": "600",
    });
    if (req.method === "OPTIONS") {
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Convert an Express request to a Web `Request` for the authorization server metadata handler. */
function toWebRequest(req: Request, origin: string): globalThis.Request {
  return new globalThis.Request(new URL(req.originalUrl, origin), {
    method: "GET",
    headers: { accept: "application/json" },
  });
}

async function sendWebResponse(res: Response, web: globalThis.Response): Promise<void> {
  res.status(web.status);
  web.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });
  res.send(Buffer.from(await web.arrayBuffer()));
}

/**
 * Public OAuth surface mounted ahead of the Origin guard: RFC 9728 protected resource metadata, RFC 8414
 * authorization server metadata, and the token/registration/revocation endpoints with credential-less CORS.
 */
export function mountOAuthDiscovery(
  app: Express,
  deps: AppDeps,
  oauth: McpOAuth,
  limit: RequestHandler,
): void {
  const resourcePath = new URL(oauth.resource).pathname.replace(/\/+$/, "");
  const prm: RequestHandler = (_req, res) => {
    res.set("Cache-Control", "public, max-age=300").json(oauth.protectedResourceMetadata());
  };
  const prmPaths = [
    "/.well-known/oauth-protected-resource",
    `/.well-known/oauth-protected-resource${resourcePath}`,
  ];
  app.all([...new Set(prmPaths)], publicCors("GET, OPTIONS"), limit, (req, res, next) =>
    req.method === "GET" || req.method === "HEAD"
      ? prm(req, res, next)
      : res.status(405).set("Allow", "GET, HEAD, OPTIONS").end(),
  );

  const issuerPath = new URL(oauth.issuer).pathname.replace(/\/+$/, "");
  const asPaths = [
    `/.well-known/oauth-authorization-server${issuerPath}`,
    "/.well-known/oauth-authorization-server",
    `${issuerPath}/.well-known/oauth-authorization-server`,
  ];
  app.all([...new Set(asPaths)], publicCors("GET, OPTIONS"), limit, async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).set("Allow", "GET, HEAD, OPTIONS").end();
      return;
    }
    try {
      await sendWebResponse(res, await oauth.serverMetadata(toWebRequest(req, deps.appUrl)));
    } catch (error) {
      deps.logger.error("authorization server metadata failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: "server_error" });
    }
  });

  app.all(PUBLIC_OAUTH_PATHS, publicCors("POST, OPTIONS"), limit, (req, res) => {
    void deps.dashboardAuth.nodeHandler(req, res);
  });
}

/** Session-authenticated routes the dashboard uses around the authorization flow and the connected-apps list. */
export function oauthRoutes(oauth: McpOAuth): Router {
  const router = Router();
  router.post("/select-workspace", async (req, res) => {
    const body = parseBody(SelectWorkspaceBody, req.body, "workspace selection");
    const session = sessionOf(res);
    await oauth.selectWorkspace(session.user.id, session.sessionId, body.workspaceId);
    res.json({ ok: true });
  });
  router.get("/connections", async (_req, res) => {
    res.json({ items: await oauth.listConnections(sessionOf(res).user.id) });
  });
  router.delete("/connections/:id", async (req, res) => {
    await oauth.revokeConnection(sessionOf(res).user.id, idParam(req, "id"));
    res.json({ ok: true });
  });
  return router;
}
