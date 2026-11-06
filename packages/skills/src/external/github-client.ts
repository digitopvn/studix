import { EXTERNAL_SKILL_LIMITS } from "@studix/core";
import { type Clock, StudixError } from "@studix/shared";
import type { z } from "zod";

export const GITHUB_API_BASE = "https://api.github.com";
const USER_AGENT = "studix-skill-import";
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 250;
const NOT_FOUND_MESSAGE = "GitHub repository or ref not found or not public";

export interface GitHubClientOptions {
  fetch: typeof fetch;
  token?: string;
  clock: Clock;
  sleep: (ms: number) => Promise<void>;
  apiBase: string;
}

interface GetJsonOptions {
  query?: Record<string, string>;
  allowNotFound?: boolean;
}

/** One bounded operation: shares a request budget and a deadline across every call it makes. */
export interface GitHubSession {
  getJson<T>(schema: z.ZodType<T>, segments: string[], query?: Record<string, string>): Promise<T>;
  /** Like `getJson`, but a 404 yields `undefined` (an optional resource such as the license). */
  getOptionalJson<T>(schema: z.ZodType<T>, segments: string[]): Promise<T | undefined>;
  requestsLeft(): number;
  remainingMs(): number;
}

class RetryableFailure extends Error {}

function rateLimitError(response: Response, nowMs: number): StudixError | undefined {
  const remaining = response.headers.get("x-ratelimit-remaining");
  const retryAfter = response.headers.get("retry-after");
  const reset = response.headers.get("x-ratelimit-reset");
  if (response.status !== 429 && remaining !== "0" && retryAfter === null) return undefined;
  let retryAfterSeconds = 60;
  if (retryAfter !== null && /^\d{1,7}$/.test(retryAfter)) retryAfterSeconds = Number(retryAfter);
  else if (reset !== null && /^\d{1,12}$/.test(reset)) {
    retryAfterSeconds = Math.max(0, Math.ceil(Number(reset) - nowMs / 1000));
  }
  return new StudixError("RATE_LIMITED", "GitHub API rate limit reached", {
    retryable: true,
    suggestedAction: "Retry later, or configure a GitHub token to raise the rate limit.",
    details: { retryAfterSeconds },
  });
}

/**
 * Read-only client for the GitHub REST API. Requests go only to the fixed API base, built from validated
 * segments that are each percent-encoded; redirects are refused and the token never leaves this module.
 */
export function createGitHubSession(options: GitHubClientOptions): GitHubSession {
  const base = new URL(options.apiBase);
  const deadline = options.clock.now().getTime() + EXTERNAL_SKILL_LIMITS.maxRuntimeMs;
  let requests = 0;
  const remainingMs = () => deadline - options.clock.now().getTime();
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": USER_AGENT,
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  function buildUrl(segments: string[], query: Record<string, string> | undefined): URL {
    const url = new URL(`${base.origin}/${segments.map(encodeURIComponent).join("/")}`);
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    if (url.origin !== base.origin)
      throw new StudixError("INTERNAL", "Refusing a request outside the GitHub API");
    return url;
  }

  function timeout(): StudixError {
    return new StudixError("TIMEOUT", "GitHub import exceeded its time limit", {
      suggestedAction: "Narrow the request with a path, or retry later.",
    });
  }

  async function send(url: URL, label: string): Promise<Response> {
    requests += 1;
    if (requests > EXTERNAL_SKILL_LIMITS.maxRequests) {
      throw new StudixError("VALIDATION", "GitHub import exceeded its request limit", {
        suggestedAction: "Narrow the request with a path or import fewer skills at once.",
        details: { maxRequests: EXTERNAL_SKILL_LIMITS.maxRequests },
      });
    }
    const left = remainingMs();
    if (left <= 0) throw timeout();
    try {
      return await options.fetch(url, {
        method: "GET",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(left),
      });
    } catch (err) {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) throw timeout();
      throw new RetryableFailure(`GitHub request failed (${label})`);
    }
  }

  async function attempt<T>(schema: z.ZodType<T>, url: URL, label: string, opts: GetJsonOptions) {
    const response = await send(url, label);
    if (response.status === 200) {
      const parsed = schema.safeParse(await response.json().catch(() => undefined));
      if (!parsed.success) throw new StudixError("PROVIDER_ERROR", `Unexpected GitHub response (${label})`);
      return parsed.data;
    }
    if (response.status === 404 && opts.allowNotFound) return undefined;
    if (response.status === 404 || response.status === 422) {
      throw new StudixError("NOT_FOUND", NOT_FOUND_MESSAGE, {
        suggestedAction: "Check the owner, repository and ref; only public repositories can be imported.",
      });
    }
    if (response.status === 403 || response.status === 429) {
      const limited = rateLimitError(response, options.clock.now().getTime());
      if (limited) throw limited;
    }
    if (response.status === 401) {
      throw new StudixError("UNAUTHENTICATED", "GitHub rejected the configured token", {
        suggestedAction: "Fix or remove the GitHub token in the server configuration.",
      });
    }
    if (response.status === 403) {
      throw new StudixError("FORBIDDEN", "GitHub refused access to this repository", {
        suggestedAction: "Only public repositories can be imported.",
      });
    }
    if (response.status >= 500) throw new RetryableFailure(`GitHub returned ${response.status} (${label})`);
    throw new StudixError("PROVIDER_ERROR", `GitHub returned ${response.status} (${label})`, {
      retryable: false,
    });
  }

  async function request<T>(schema: z.ZodType<T>, segments: string[], opts: GetJsonOptions) {
    const url = buildUrl(segments, opts.query);
    const label = segments.slice(0, 1).concat(segments.slice(3, 5)).join("/");
    for (let retry = 0; ; retry += 1) {
      try {
        return await attempt(schema, url, label, opts);
      } catch (err) {
        if (!(err instanceof RetryableFailure)) throw err;
        const delay = RETRY_BASE_MS * 2 ** retry;
        if (retry >= MAX_RETRIES || remainingMs() <= delay) {
          throw new StudixError("PROVIDER_ERROR", err.message, {
            suggestedAction: "GitHub is unavailable or refused the request; retry later.",
          });
        }
        await options.sleep(delay);
      }
    }
  }

  return {
    getJson: async (schema, segments, query) => {
      const value = await request(schema, segments, { query });
      if (value === undefined) throw new StudixError("NOT_FOUND", NOT_FOUND_MESSAGE);
      return value;
    },
    getOptionalJson: (schema, segments) => request(schema, segments, { allowNotFound: true }),
    requestsLeft: () => EXTERNAL_SKILL_LIMITS.maxRequests - requests,
    remainingMs,
  };
}
