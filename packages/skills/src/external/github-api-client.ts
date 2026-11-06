import { StudixError } from "@studix/shared";
import type { GithubSkillLimits } from "./github-skill-limits.ts";

export const GITHUB_API_ORIGIN = "https://api.github.com";

export const ACCEPT_JSON = "application/vnd.github+json";
export const ACCEPT_SHA = "application/vnd.github.sha";
export const ACCEPT_RAW = "application/vnd.github.raw+json";

export type GithubApiResponse =
  | { status: number; body: Uint8Array; tooLarge?: undefined }
  | { status: number; body?: undefined; tooLarge: true };

export interface GithubApiSessionOptions {
  fetch: typeof fetch;
  limits: GithubSkillLimits;
  now: () => number;
  token?: string;
}

export interface GithubRequestOptions {
  accept: string;
  maxBytes: number;
  /** Non-2xx statuses returned to the caller instead of being mapped to an error. */
  pass?: readonly number[];
}

/**
 * One bounded conversation with the GitHub REST API, scoped to a single `discover` / `fetchSkills`
 * call. It only ever talks to https://api.github.com, refuses cross-host redirects, counts every
 * request against `maxRequests`, enforces the wall-clock budget and retries only 5xx / network
 * failures (and short rate-limit waits).
 */
export class GithubApiSession {
  private requests = 0;
  private readonly deadline: number;

  constructor(private readonly options: GithubApiSessionOptions) {
    this.deadline = options.now() + options.limits.totalTimeoutMs;
  }

  async request(path: string, request: GithubRequestOptions): Promise<GithubApiResponse> {
    const { limits } = this.options;
    let url = new URL(`${GITHUB_API_ORIGIN}${path}`);
    if (url.origin !== GITHUB_API_ORIGIN) throw new StudixError("INTERNAL", "Refusing a non-GitHub API URL");
    let redirects = 0;
    let attempt = 0;
    for (;;) {
      this.reserve();
      let response: Response;
      try {
        response = await this.options.fetch(url, {
          method: "GET",
          redirect: "manual",
          headers: this.headers(request.accept),
          signal: AbortSignal.timeout(Math.max(1, Math.min(limits.requestTimeoutMs, this.remaining()))),
        });
      } catch (err) {
        if (err instanceof StudixError) throw err;
        if (attempt < limits.maxRetries) {
          await this.backoff(attempt++);
          continue;
        }
        throw this.networkError(err);
      }

      const status = response.status;
      if (response.type === "opaqueredirect" || (status >= 300 && status < 400)) {
        await discard(response);
        url = this.redirectTarget(url, response.headers.get("location"), redirects++);
        continue;
      }
      if ((status >= 200 && status < 300) || request.pass?.includes(status)) {
        try {
          const body = await readBounded(response, request.maxBytes);
          return body === undefined ? { status, tooLarge: true } : { status, body };
        } catch (err) {
          if (attempt < limits.maxRetries) {
            await this.backoff(attempt++);
            continue;
          }
          throw this.networkError(err);
        }
      }
      await discard(response);

      if (isRateLimited(response)) {
        const waitMs = rateLimitWaitMs(response, this.options.now());
        if (
          waitMs <= limits.maxRateLimitWaitMs &&
          attempt < limits.maxRetries &&
          waitMs < this.remaining()
        ) {
          attempt++;
          await sleep(waitMs);
          continue;
        }
        const resetAt = new Date(this.options.now() + waitMs).toISOString();
        throw new StudixError("RATE_LIMITED", "GitHub API rate limit reached", {
          retryable: true,
          suggestedAction: `Retry after ${resetAt}${this.options.token ? "" : ", or configure a GitHub token for a higher limit"}`,
          details: { status, resetAt },
        });
      }
      if (status >= 500 && attempt < limits.maxRetries) {
        await this.backoff(attempt++);
        continue;
      }
      throw statusError(status);
    }
  }

  /** Request and parse a JSON document; a response over `maxBytes` is an error. */
  async json(path: string, request: Omit<GithubRequestOptions, "accept">): Promise<{ status: number; data: unknown }> {
    const response = await this.request(path, { ...request, accept: ACCEPT_JSON });
    if (response.tooLarge) {
      throw new StudixError("PROVIDER_ERROR", "GitHub response exceeded the size limit", { retryable: false });
    }
    if (response.status < 200 || response.status >= 300) return { status: response.status, data: undefined };
    try {
      return { status: response.status, data: JSON.parse(new TextDecoder().decode(response.body)) };
    } catch (err) {
      throw new StudixError("PROVIDER_ERROR", "GitHub returned malformed JSON", { retryable: false, cause: err });
    }
  }

  private headers(accept: string): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: accept,
      "User-Agent": "studix-skill-importer",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    // Only ever sent to api.github.com: every request URL is checked against that origin.
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    return headers;
  }

  private reserve(): void {
    if (this.remaining() <= 0) throw this.budgetError();
    if (this.requests >= this.options.limits.maxRequests) {
      throw new StudixError(
        "BUDGET_EXCEEDED",
        `GitHub import reached its limit of ${this.options.limits.maxRequests} API requests`,
        { retryable: false, suggestedAction: "Import fewer skills at once" },
      );
    }
    this.requests++;
  }

  private remaining(): number {
    return this.deadline - this.options.now();
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = this.options.limits.retryBaseDelayMs * 2 ** attempt;
    if (delay >= this.remaining()) throw this.budgetError();
    await sleep(delay);
  }

  private budgetError(): StudixError {
    return new StudixError(
      "TIMEOUT",
      `GitHub import exceeded its runtime budget of ${this.options.limits.totalTimeoutMs} ms`,
      { retryable: true, suggestedAction: "Import fewer skills at once, or retry later" },
    );
  }

  private redirectTarget(current: URL, location: string | null, followed: number): URL {
    if (followed >= this.options.limits.maxRedirects) {
      throw new StudixError("PROVIDER_ERROR", "GitHub redirected too many times", { retryable: false });
    }
    let next: URL;
    try {
      if (!location) throw new Error("missing Location");
      next = new URL(location, current);
    } catch {
      throw new StudixError("PROVIDER_ERROR", "GitHub sent an invalid redirect", { retryable: false });
    }
    if (next.origin !== GITHUB_API_ORIGIN || next.username !== "" || next.password !== "") {
      throw new StudixError("PROVIDER_ERROR", "GitHub redirected to a host outside api.github.com; refused", {
        retryable: false,
      });
    }
    return next;
  }

  private networkError(err: unknown): StudixError {
    if (this.remaining() <= 0) return this.budgetError();
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    return timedOut
      ? new StudixError("TIMEOUT", "GitHub request timed out", { retryable: true, cause: err })
      : new StudixError("UNAVAILABLE", "GitHub could not be reached", { retryable: true, cause: err });
  }
}

function isRateLimited(response: Response): boolean {
  if (response.status === 429) return true;
  return (
    response.status === 403 &&
    (response.headers.get("x-ratelimit-remaining") === "0" || response.headers.get("retry-after") !== null)
  );
}

function rateLimitWaitMs(response: Response, now: number): number {
  const retryAfter = Number(response.headers.get("retry-after") ?? Number.NaN);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1000;
  const reset = Number(response.headers.get("x-ratelimit-reset") ?? Number.NaN);
  if (Number.isFinite(reset) && reset > 0) return Math.max(0, reset * 1000 - now);
  return 60_000;
}

function statusError(status: number): StudixError {
  switch (status) {
    case 401:
      return new StudixError("UNAUTHENTICATED", "GitHub rejected the configured token", {
        suggestedAction: "Check or remove the GitHub token",
      });
    case 403:
      return new StudixError("FORBIDDEN", "GitHub refused access to this repository");
    case 404:
      return new StudixError("NOT_FOUND", "Repository, ref or path not found on GitHub, or the repository is private", {
        suggestedAction: "Check the URL; only public repositories can be imported",
      });
    case 422:
      return new StudixError("VALIDATION", "GitHub rejected the request as invalid");
    default:
      return status >= 500
        ? new StudixError("UNAVAILABLE", `GitHub returned HTTP ${status}`, { retryable: true })
        : new StudixError("PROVIDER_ERROR", `GitHub returned HTTP ${status}`, { retryable: false });
  }
}

/** Read a response body, giving up (undefined) as soon as it exceeds `maxBytes`. */
async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await discard(response);
    return undefined;
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.byteLength > maxBytes ? undefined : bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body is unused; a failure to cancel it changes nothing.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
