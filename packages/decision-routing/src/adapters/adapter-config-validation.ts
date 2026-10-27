import { registerSecret, StudixError } from "@studix/shared";

/** Construction-time checks shared by HTTP adapters. Errors never echo the offending value. */

export function requireApiKey(apiKey: string | undefined, provider: string): string {
  if (typeof apiKey !== "string" || apiKey.trim().length < 8) {
    throw new StudixError("VALIDATION", `${provider} API key is missing or malformed`, {
      suggestedAction: `Set the ${provider} API key in the deployment environment.`,
    });
  }
  const key = apiKey.trim();
  // Registered so the shared redactor scrubs it from every log line, span and error message.
  registerSecret(key);
  return key;
}

export function requireModel(model: string | undefined, provider: string): string {
  if (typeof model !== "string" || model.trim() === "") {
    throw new StudixError("VALIDATION", `${provider} decision model is not configured`);
  }
  return model.trim();
}

/** http(s) base URL without a trailing slash, so paths can be appended safely. */
export function normalizeBaseUrl(url: string, provider: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StudixError("VALIDATION", `${provider} base URL is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new StudixError("VALIDATION", `${provider} base URL must use http(s)`);
  }
  if (parsed.username || parsed.password || parsed.search) {
    throw new StudixError("VALIDATION", `${provider} base URL must not carry credentials or a query`);
  }
  return parsed.toString().replace(/\/+$/, "");
}

export function positiveInt(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved <= 0) {
    throw new StudixError("VALIDATION", `${name} must be a positive integer`);
  }
  return resolved;
}
