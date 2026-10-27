import type { NextFunction, Request, Response } from "express";

/**
 * Host/Origin allow-lists, CORS and baseline security headers. Every allowed value derives from the
 * configured STUDIX_*_URL values and STUDIX_ALLOWED_HOSTS, never from literals.
 */

/** Hostname (no port) of a Host-style value such as `app.example.com:443` or `[::1]:8787`. */
export function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return host.toLowerCase();
  }
}

export function uniqueHostnames(hosts: string[]): string[] {
  return [...new Set(hosts.map(hostnameOf).filter(Boolean))];
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const CORS_ALLOW_HEADERS = [
  "authorization",
  "content-type",
  "mcp-protocol-version",
  "mcp-session-id",
  "last-event-id",
  "x-studix-workspace",
].join(", ");
const CORS_EXPOSE_HEADERS = ["mcp-session-id", "mcp-protocol-version", "www-authenticate"].join(", ");

/**
 * CORS for the configured origins only (credentials allowed). Preflights from other origins get no CORS
 * headers, so browsers block them. State-changing requests carrying a foreign Origin are rejected outright
 * (CSRF defense for cookie-authenticated /api routes, rebinding defense for /mcp).
 */
export function corsAndOriginGuard(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && allowed.has(origin)) {
      res.set({
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
        "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS,
      });
      res.vary("Origin");
      if (req.method === "OPTIONS") {
        res
          .set({
            "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
            "Access-Control-Allow-Headers": CORS_ALLOW_HEADERS,
            "Access-Control-Max-Age": "600",
          })
          .status(204)
          .end();
        return;
      }
    } else if (origin && !SAFE_METHODS.has(req.method)) {
      res.status(403).json({
        error: { code: "FORBIDDEN", message: "Origin not allowed", retryable: false },
      });
      return;
    }
    next();
  };
}

/** Helmet-like baseline headers for every response (HTML pages add a CSP on top). */
export function securityHeaders(options: { https: boolean }) {
  return (_req: Request, res: Response, next: NextFunction) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
      "X-DNS-Prefetch-Control": "off",
    });
    if (options.https) res.set("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    next();
  };
}
