interface Env {
  /** Origin of the upstream app, e.g. the TOSE default domain. */
  STUDIX_UPSTREAM_ORIGIN: string;
}

/**
 * Transparent reverse proxy: same method, path, query, headers and streamed body, sent to the
 * upstream origin. Redirects are passed back to the client untouched so Location headers built from
 * STUDIX_PUBLIC_URL keep pointing at the public hostname.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const incoming = new URL(request.url);
    const target = new URL(incoming.pathname + incoming.search, env.STUDIX_UPSTREAM_ORIGIN);
    const headers = new Headers(request.headers);
    headers.set("x-forwarded-host", incoming.host);
    headers.set("x-forwarded-proto", "https");
    return fetch(target, {
      method: request.method,
      headers,
      body: request.body,
      redirect: "manual",
    });
  },
};
