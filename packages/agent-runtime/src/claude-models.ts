/*
 * The Claude models a connection can run. An API key lists them live from Anthropic (`GET /v1/models`,
 * which runs no model and costs nothing); a subscription token cannot call that endpoint, so it gets the
 * static list below. Keep the static list on the current family, newest first.
 */

export interface ClaudeModel {
  id: string;
  /** True when the model takes a Claude Code effort level (low … xhigh). */
  reasoning: boolean;
}

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

export const CLAUDE_MODELS: readonly ClaudeModel[] = [
  { id: "claude-fable-5-1", reasoning: true },
  { id: "claude-opus-5-5", reasoning: true },
  { id: "claude-sonnet-5-5", reasoning: true },
  { id: "claude-haiku-5-5", reasoning: true },
];

/** Families before 4.5 take no effort level; Anthropic still lists some of them. */
const NO_EFFORT =
  /^claude-(3|instant|2)|^claude-(opus|sonnet|haiku)-4-(0|1)\b|^claude-(opus|sonnet)-4(-\d{8})?$/;

/** Retired families Anthropic may still list for old keys; they are not offered for new jobs. */
const RETIRED = /^claude-(2|instant|3-)/;

export function claudeModelReasoning(id: string): boolean {
  return !NO_EFFORT.test(id);
}

const TTL_MS = 10 * 60_000;
const cache = new Map<string, { at: number; models: ClaudeModel[] }>();

export interface ListClaudeModelsOptions {
  /** Cache key for this credential (a connection id); the key itself is never stored. */
  cacheKey: string;
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Models this key can use, newest first, retired families dropped. Any failure (network, 4xx, a gateway
 * without the endpoint) falls back to the static list, so the picker is never empty.
 */
export async function listClaudeModels(options: ListClaudeModelsOptions): Promise<ClaudeModel[]> {
  const now = options.now?.() ?? Date.now();
  const hit = cache.get(options.cacheKey);
  if (hit && now - hit.at < TTL_MS) return hit.models;
  const baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const doFetch = options.fetch ?? fetch;
  try {
    const response = await doFetch(`${baseUrl}/v1/models?limit=1000`, {
      headers: { "x-api-key": options.apiKey, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [...CLAUDE_MODELS];
    const body = (await response.json()) as { data?: Array<{ id?: unknown; created_at?: unknown }> };
    const models = (body.data ?? [])
      .filter((m): m is { id: string; created_at?: unknown } => typeof m.id === "string")
      .filter((m) => m.id.startsWith("claude-") && !RETIRED.test(m.id))
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .map((m) => ({ id: m.id, reasoning: claudeModelReasoning(m.id) }));
    if (models.length === 0) return [...CLAUDE_MODELS];
    cache.set(options.cacheKey, { at: now, models });
    return models;
  } catch {
    return [...CLAUDE_MODELS];
  }
}
