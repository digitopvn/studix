import { existsSync } from "node:fs";
import { join } from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";

/** Server-owned path prefixes the SPA fallback must never answer. */
export const RESERVED_PREFIXES = ["/mcp", "/api", "/healthz", "/readyz", "/.well-known"] as const;

function isReserved(path: string): boolean {
  return RESERVED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/** CSP for the dashboard shell: own scripts and styles; media also from object storage (signed URLs). */
export function dashboardCsp(mediaOrigins: string[]): string {
  const media = ["'self'", "blob:", ...mediaOrigins].join(" ");
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    `media-src ${media}`,
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

const UNAVAILABLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Studix</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family: system-ui, sans-serif; max-width: 40rem; margin: 4rem auto; padding: 0 1rem">
<h1>Dashboard unavailable</h1>
<p>The dashboard has not been built on this server. The MCP endpoint at <code>/mcp</code> is unaffected.</p>
</body></html>
`;

/**
 * Serves the built dashboard: hashed `/assets/*` with a long immutable cache, `index.html` with no-cache and
 * a CSP, and the SPA shell for any other browser navigation outside the reserved prefixes. When the build is
 * missing, navigations get a small 503 page instead of "Cannot GET /".
 */
export function mountDashboardStatic(
  app: Express,
  options: { dist?: string; mediaOrigins: string[] | (() => string[]) },
): void {
  const dist = options.dist;
  const indexPath = dist ? join(dist, "index.html") : undefined;
  // Storage profiles can change while the app runs, so their media origins are read per response.
  const origins = options.mediaOrigins;
  const csp = () => dashboardCsp(typeof origins === "function" ? origins() : origins);
  const hasBuild = () => indexPath !== undefined && existsSync(indexPath);
  const htmlHeaders = (res: Response) => {
    res.set({ "Cache-Control": "no-cache", "Content-Security-Policy": csp() });
  };

  const assets = dist
    ? express.static(dist, {
        index: false,
        dotfiles: "ignore",
        fallthrough: true,
        setHeaders: (res, path) => {
          const normalized = path.replace(/\\/g, "/");
          if (normalized.endsWith(".html")) htmlHeaders(res);
          else if (normalized.includes("/assets/"))
            res.set("Cache-Control", "public, max-age=31536000, immutable");
          else res.set("Cache-Control", "public, max-age=3600");
        },
      })
    : undefined;

  const isNavigable = (req: Request) =>
    (req.method === "GET" || req.method === "HEAD") && !isReserved(req.path);

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!assets || !isNavigable(req) || req.path === "/index.html" || !hasBuild()) {
      next();
      return;
    }
    assets(req, res, next);
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    if (!isNavigable(req)) {
      next();
      return;
    }
    if (req.path !== "/" && !String(req.headers.accept ?? "").includes("text/html")) {
      next();
      return;
    }
    if (!hasBuild() || !indexPath) {
      res
        .status(503)
        .set({ "Cache-Control": "no-store", "Retry-After": "300" })
        .type("html")
        .send(UNAVAILABLE_HTML);
      return;
    }
    htmlHeaders(res);
    // Rooted so the dotfiles check only sees the path below `dist`, not a dot directory above the build.
    res.sendFile("index.html", { root: dist }, (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });
}
