import { describe, expect, it, vi } from "vitest";
import { createGitHubSource } from "../../src/external/github-source.ts";
import { DEFAULT_SKILL_IMPORT_LIMITS } from "../../src/external/import-limits.ts";

const limits = { ...DEFAULT_SKILL_IMPORT_LIMITS, maxRetries: 2 };
const SHA = "a".repeat(40);

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function source(handler: Handler, extra: { token?: string; now?: () => number } = {}) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchFn = (async (input: URL | string, init: RequestInit = {}) => {
    const url = new URL(String(input));
    seen.push({ url: url.toString(), headers: init.headers as Record<string, string> });
    return handler(url, init);
  }) as typeof fetch;
  return {
    seen,
    gh: createGitHubSource({ limits, fetch: fetchFn, sleep: async () => {}, ...extra }),
  };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("GitHub source network safety", () => {
  it("refuses a redirect to an internal address", async () => {
    const { gh, seen } = source((url) =>
      url.hostname === "api.github.com"
        ? new Response(null, {
            status: 302,
            headers: { location: "http://169.254.169.254/latest/meta-data" },
          })
        : json({}),
    );
    await expect(gh.repository("o", "r")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(seen.map((s) => new URL(s.url).hostname)).toEqual(["api.github.com"]);
  });

  it.each([
    "https://evil.test/x",
    "https://api.github.com.evil.test/x",
    "https://localhost/x",
    "https://api.github.com:8443/x",
    "https://user@api.github.com/x",
  ])("refuses a redirect to %s", async (location) => {
    const { gh, seen } = source(() => new Response(null, { status: 301, headers: { location } }));
    await expect(gh.commit("o", "r", "main")).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(seen).toHaveLength(1);
  });

  it("follows a same-host redirect and stops after the redirect limit", async () => {
    let hops = 0;
    const { gh } = source((url) => {
      hops++;
      if (url.pathname.startsWith("/repositories/")) return json({ default_branch: "dev", private: false });
      return new Response(null, {
        status: 301,
        headers: { location: "https://api.github.com/repositories/1" },
      });
    });
    await expect(gh.repository("o", "r")).resolves.toMatchObject({ defaultBranch: "dev" });
    expect(hops).toBe(2);

    const loop = source(
      () => new Response(null, { status: 301, headers: { location: "https://api.github.com/loop" } }),
    );
    await expect(loop.gh.repository("o", "r")).rejects.toThrow("Too many redirects");
  });

  it("sends the token to the API host only", async () => {
    const { gh, seen } = source(
      (url) => (url.hostname === "api.github.com" ? json({ default_branch: "main" }) : new Response("hi")),
      { token: "ghp_secret" },
    );
    await gh.repository("o", "r");
    await gh.blob("o", "r", SHA, "SKILL.md", 100);
    expect(seen[0]?.headers.authorization).toBe("Bearer ghp_secret");
    expect(seen[1]?.url).toContain("raw.githubusercontent.com");
    expect(seen[1]?.headers.authorization).toBeUndefined();
  });

  it("treats a private or missing repository as not found", async () => {
    await expect(source(() => json({ private: true })).gh.repository("o", "r")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      source(() => new Response("", { status: 404 })).gh.repository("o", "r"),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("GitHub source limits", () => {
  it("reports the rate limit with its reset time", async () => {
    const { gh } = source(
      () =>
        new Response("{}", {
          status: 403,
          headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1893456000" },
        }),
    );
    await expect(gh.repository("o", "r")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      retryable: true,
      details: { resetAt: "2030-01-01T00:00:00.000Z" },
    });
  });

  it("retries a 5xx a bounded number of times", async () => {
    let calls = 0;
    const flaky = source(() =>
      ++calls < 3 ? new Response("", { status: 502 }) : json({ default_branch: "main" }),
    );
    await expect(flaky.gh.repository("o", "r")).resolves.toMatchObject({ defaultBranch: "main" });
    expect(calls).toBe(3);

    calls = 0;
    const down = source(() => {
      calls++;
      return new Response("", { status: 503 });
    });
    await expect(down.gh.repository("o", "r")).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: true,
    });
    expect(calls).toBe(3);
  });

  it("caps a file by declared and streamed size", async () => {
    const big = source(() => new Response("x".repeat(50), { headers: { "content-length": "50" } }));
    await expect(big.gh.blob("o", "r", SHA, "a.md", 10)).rejects.toMatchObject({ code: "VALIDATION" });
    const noLength = source(
      () =>
        new Response(
          new ReadableStream({
            start: (c) => {
              c.enqueue(new Uint8Array(50));
              c.close();
            },
          }),
        ),
    );
    await expect(noLength.gh.blob("o", "r", SHA, "a.md", 10)).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("gives up when the time budget is spent", async () => {
    let clock = 0;
    const { gh } = source(() => json({}), { now: () => clock });
    clock = limits.totalTimeoutMs + 1;
    await expect(gh.repository("o", "r")).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("rejects unsafe file references before any request", async () => {
    const fetchFn = vi.fn();
    const gh = createGitHubSource({ limits, fetch: fetchFn as unknown as typeof fetch });
    await expect(gh.blob("o", "r", SHA, "../etc/passwd", 10)).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(gh.blob("o", "r", "main", "a.md", 10)).rejects.toMatchObject({ code: "VALIDATION" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("GitHub source tree listing", () => {
  const entry = (path: string, type = "blob", mode = "100644") => ({
    path,
    type,
    mode,
    sha: "b".repeat(40),
    size: 1,
  });

  it("returns the recursive listing and drops unsafe paths", async () => {
    const { gh } = source(() =>
      json({ tree: [entry("a/SKILL.md"), entry("../evil"), entry("a//b")], truncated: false }),
    );
    const tree = await gh.tree("o", "r", SHA);
    expect(tree).toEqual({ entries: [expect.objectContaining({ path: "a/SKILL.md" })], truncated: false });
  });

  it("walks directories one by one when the recursive listing is truncated", async () => {
    const { gh, seen } = source((url) => {
      if (url.searchParams.has("recursive")) return json({ tree: [], truncated: true });
      if (url.pathname.endsWith(SHA))
        return json({ tree: [entry("skills", "tree", "040000"), entry("README.md")], truncated: false });
      return json({ tree: [entry("pdf", "tree", "040000"), entry("SKILL.md")], truncated: false });
    });
    const tree = await gh.tree("o", "r", SHA);
    expect(tree.truncated).toBe(false);
    expect(tree.entries.map((e) => e.path)).toContain("skills/SKILL.md");
    expect(seen.length).toBeGreaterThan(2);
  });

  it("reports an incomplete listing when the walk hits its request budget", async () => {
    const bounded = createGitHubSource({
      limits: { ...limits, maxTreeRequests: 2 },
      sleep: async () => {},
      fetch: (async (input: URL | string) => {
        const url = new URL(String(input));
        if (url.searchParams.has("recursive")) return json({ tree: [], truncated: true });
        return json({ tree: [entry(`d${url.pathname.length}`, "tree", "040000")], truncated: false });
      }) as typeof fetch,
    });
    expect((await bounded.tree("o", "r", SHA)).truncated).toBe(true);
  });
});
