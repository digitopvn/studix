import { StudixError, type StudixErrorPayload } from "@studix/shared";

export interface ProviderKeyTestResult {
  ok: boolean;
  at: Date;
  latencyMs: number;
  httpStatus?: number;
  /** `invalid`: the key is rejected; `unverified`: the provider could not confirm it right now. */
  verdict: "available" | "invalid" | "unverified";
  error?: StudixErrorPayload;
}

export interface ProviderKeyTester {
  /** `provider` is the connection's provider id; a single-provider tester may ignore it. */
  test(apiKey: string, provider: string): Promise<ProviderKeyTestResult>;
}

export interface AnthropicKeyTesterOptions {
  /** Default `https://api.anthropic.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Console keys look like `sk-ant-<kind>-<secret>`; the check rejects pasted junk before any network call. */
export const ANTHROPIC_API_KEY_PATTERN = /^sk-ant-[A-Za-z0-9_-]{20,300}$/;

/** `sk-ant-…a1b2`: enough to tell keys apart, never enough to use one. */
export function anthropicKeyHint(apiKey: string): string {
  return `sk-ant-…${apiKey.slice(-4)}`;
}

function payload(error: StudixError): StudixErrorPayload {
  return {
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    ...(error.suggestedAction ? { suggestedAction: error.suggestedAction } : {}),
  };
}

/**
 * Test a key with `GET /v1/models?limit=1`: authenticated, but it runs no model, so a test costs no
 * tokens. The key is sent only in the `x-api-key` header and never appears in results or errors.
 */
export function createAnthropicKeyTester(options: AnthropicKeyTesterOptions = {}): ProviderKeyTester {
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;
  const now = options.now ?? (() => new Date());
  return {
    async test(apiKey) {
      const started = Date.now();
      const done = (
        verdict: ProviderKeyTestResult["verdict"],
        httpStatus?: number,
        error?: StudixError,
      ): ProviderKeyTestResult => ({
        ok: verdict === "available",
        at: now(),
        latencyMs: Date.now() - started,
        verdict,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(error ? { error: payload(error) } : {}),
      });
      let response: Response;
      try {
        response = await doFetch(`${baseUrl}/v1/models?limit=1`, {
          method: "GET",
          headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: "error",
        });
      } catch {
        return done(
          "unverified",
          undefined,
          new StudixError("UNAVAILABLE", "Could not reach Anthropic to test the key", {
            suggestedAction: "Try the test again later.",
          }),
        );
      }
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      if (response.ok) return done("available", status);
      if (status === 401)
        return done(
          "invalid",
          status,
          new StudixError("UNAUTHENTICATED", "Anthropic rejected the API key", {
            retryable: false,
            suggestedAction: "Check the key in the Claude Console, then paste it again.",
          }),
        );
      if (status === 403)
        return done(
          "invalid",
          status,
          new StudixError("FORBIDDEN", "The API key is not allowed to use the Anthropic API", {
            retryable: false,
            suggestedAction: "Check the key's organization, workspace and permissions in the Claude Console.",
          }),
        );
      if (status === 429)
        return done(
          "unverified",
          status,
          new StudixError("RATE_LIMITED", "Anthropic rate limit or spend limit reached", {
            suggestedAction: "Check usage limits in the Claude Console, then test again.",
          }),
        );
      return done(
        "unverified",
        status,
        new StudixError("UNAVAILABLE", `Anthropic answered HTTP ${status}`, {
          suggestedAction: "Try the test again later.",
        }),
      );
    },
  };
}
