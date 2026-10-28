// Studix marketing Worker. Static assets are served via the ASSETS binding; this script adds
// security headers, a health probe, a runtime config endpoint and injects the app URL into HTML.

interface AssetsBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  ASSETS: AssetsBinding;
  /** Public URL of the Studix app (wrangler `vars`). */
  STUDIX_APP_URL: string;
}

// Media is served from public/assets; only fonts come from Google Fonts. Style attributes are allowed
// (the page sets CSS variables inline); <style> and <script> elements still must come from this origin.
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; font-src https://fonts.gstatic.com; " +
    "style-src 'self' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; script-src 'self'; " +
    "object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
};

function withSecurityHeaders(response: Response): Response {
  const out = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) out.headers.set(name, value);
  return out;
}

function json(body: unknown, init?: ResponseInit): Response {
  return withSecurityHeaders(
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    }),
  );
}

/** Returns the configured app URL when it is a valid http(s) URL, otherwise null. */
function resolveAppUrl(env: Env): string | null {
  try {
    const url = new URL(env.STUDIX_APP_URL);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === "/healthz") return json({ status: "ok" });

    if (pathname === "/config.json") {
      const appUrl = resolveAppUrl(env);
      if (!appUrl) return json({ error: "STUDIX_APP_URL is not configured" }, { status: 500 });
      return json({ appUrl });
    }

    const response = await env.ASSETS.fetch(request);
    const isHtml = response.headers.get("Content-Type")?.includes("text/html");
    const appUrl = resolveAppUrl(env);
    if (!isHtml || !appUrl) return withSecurityHeaders(response);

    // Point every CTA marked data-app-link at the configured app URL, and the MCP config sample at its /mcp.
    const rewritten = new HTMLRewriter()
      .on("a[data-app-link]", {
        element(el) {
          el.setAttribute("href", appUrl);
        },
      })
      .on("[data-app-mcp-url]", {
        element(el) {
          el.setInnerContent(JSON.stringify(new URL("mcp", appUrl).toString()));
        },
      })
      .transform(response);
    return withSecurityHeaders(rewritten);
  },
};
