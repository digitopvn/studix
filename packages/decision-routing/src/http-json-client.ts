import { redact } from "@studix/shared";
import { decisionError } from "./decision-errors.ts";

/** Minimal fetch signature so tests can inject a recorded-response fetch. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PostJsonOptions {
  /** Human-readable provider label used in error messages. */
  provider: string;
  url: string;
  apiKey: string;
  body: unknown;
  headers?: Record<string, string>;
  signal: AbortSignal;
  fetch: FetchLike;
}

const MAX_ERROR_SNIPPET = 300;

/** Pull a readable message out of a provider error body without echoing the whole payload. */
function errorSnippet(text: string): string {
  let message = text;
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: unknown };
    const candidate =
      typeof body.error === "string"
        ? body.error
        : typeof body.error?.message === "string"
          ? body.error.message
          : body.detail !== undefined
            ? JSON.stringify(body.detail)
            : undefined;
    if (candidate) message = candidate;
  } catch {
    // Not JSON: keep the raw text (truncated and redacted below).
  }
  const trimmed = message.trim().slice(0, MAX_ERROR_SNIPPET);
  return redact(trimmed || "(empty body)");
}

function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/** Map a non-2xx provider response onto the decision error taxonomy. */
export function httpStatusError(provider: string, response: Response, bodyText: string) {
  const status = response.status;
  const message = `${provider} responded ${status}: ${errorSnippet(bodyText)}`;
  const details = { status };
  if (status === 401 || status === 403) {
    return decisionError("PROVIDER_ERROR", "auth", message, {
      retryable: false,
      details,
      suggestedAction: `Check the ${provider} API key configured for this deployment.`,
    });
  }
  if (status === 402) {
    return decisionError("PROVIDER_ERROR", "provider_error", message, {
      retryable: false,
      details,
      suggestedAction: `Top up the ${provider} account or route this decision to another provider.`,
    });
  }
  if (status === 408) return decisionError("TIMEOUT", "timeout", message, { details });
  if (status === 429) {
    const wait = retryAfterMs(response);
    return decisionError("RATE_LIMITED", "rate_limited", message, {
      details: wait === undefined ? details : { ...details, retryAfterMs: wait },
    });
  }
  if (status >= 500) return decisionError("UNAVAILABLE", "unavailable", message, { details });
  if ([400, 404, 413, 415, 422].includes(status)) {
    return decisionError("PROVIDER_ERROR", "bad_request", message, { retryable: false, details });
  }
  return decisionError("PROVIDER_ERROR", "provider_error", message, { retryable: false, details });
}

/** POST a JSON body with bearer auth and return the parsed JSON response, mapping failures. */
export async function postJson(options: PostJsonOptions): Promise<unknown> {
  let response: Response;
  try {
    response = await options.fetch(options.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json",
        accept: "application/json",
        ...options.headers,
      },
      body: JSON.stringify(options.body),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal.aborted) throw error;
    throw decisionError("UNAVAILABLE", "unavailable", `Could not reach ${options.provider}`, {
      details: { cause: error instanceof Error ? redact(error.message) : "network error" },
    });
  }
  const text = await response.text();
  if (!response.ok) throw httpStatusError(options.provider, response, text);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw decisionError("PROVIDER_ERROR", "provider_error", `${options.provider} returned a non-JSON body`, {
      details: { status: response.status },
    });
  }
}
