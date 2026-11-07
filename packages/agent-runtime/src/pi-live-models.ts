import type { PiCatalogModel } from "./pi-catalog.ts";

/*
 * Pi models a key can use right now. Anthropic and OpenAI list them live (`GET /v1/models`, which runs no
 * model and costs nothing). Those endpoints return ids only, so prices and limits come from the Pi catalog,
 * or, for a model newer than the catalog, from OpenRouter's public model list. OpenRouter prices are an
 * estimate for the task budget, not a bill.
 */

const LIST_TTL_MS = 10 * 60_000;
const OPENROUTER_TTL_MS = 60 * 60_000;
const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

interface LiveSource {
  url: string;
  headers: (apiKey: string) => Record<string, string>;
  /** Chat models only; the endpoint also lists embedding, audio and image models. */
  keep: (id: string) => boolean;
}

const LIVE_SOURCES: Readonly<Record<string, LiveSource>> = {
  anthropic: {
    url: "https://api.anthropic.com/v1/models?limit=1000",
    headers: (apiKey) => ({ "x-api-key": apiKey, "anthropic-version": "2023-06-01" }),
    keep: (id) => id.startsWith("claude-") && !/^claude-(2|instant|3-)/.test(id),
  },
  openai: {
    url: "https://api.openai.com/v1/models",
    headers: (apiKey) => ({ authorization: `Bearer ${apiKey}` }),
    keep: (id) =>
      /^(gpt-|o\d|chat-)/.test(id) &&
      !/(audio|realtime|transcribe|tts|image|search|embedding|instruct|moderation)/.test(id) &&
      !/^gpt-(3|4)(?!\.1|o)/.test(id),
  },
};

export function hasLivePiModels(provider: string): boolean {
  return provider in LIVE_SOURCES;
}

export interface PiLiveOptions {
  fetch?: typeof fetch;
  now?: () => number;
}

interface OpenRouterModel {
  id: string;
  name?: string;
  context_length?: number;
  pricing?: { prompt?: string; completion?: string };
  top_provider?: { max_completion_tokens?: number | null };
  supported_parameters?: string[];
}

let openRouter: { at: number; models: Map<string, OpenRouterModel> } | undefined;

async function openRouterModels(options: PiLiveOptions): Promise<Map<string, OpenRouterModel>> {
  const now = options.now?.() ?? Date.now();
  if (openRouter && now - openRouter.at < OPENROUTER_TTL_MS) return openRouter.models;
  try {
    const response = await (options.fetch ?? fetch)(OPENROUTER_MODELS_URL, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return openRouter?.models ?? new Map();
    const body = (await response.json()) as { data?: OpenRouterModel[] };
    const models = new Map((body.data ?? []).filter((m) => typeof m.id === "string").map((m) => [m.id, m]));
    openRouter = { at: now, models };
    return models;
  } catch {
    return openRouter?.models ?? new Map();
  }
}

/** OpenRouter spells versions with dots and drops date suffixes: claude-opus-5-5 → anthropic/claude-opus-5.5. */
function openRouterIds(provider: string, id: string): string[] {
  const undated = id.replace(/-\d{8}$/, "");
  const dotted = undated.replace(/-(\d+)-(\d+)$/, "-$1.$2");
  return [...new Set([id, undated, dotted])].map((v) => `${provider}/${v}`);
}

/** Estimated limits and prices from OpenRouter, for a model the Pi catalog does not know yet. */
export async function estimatePiModel(
  provider: string,
  id: string,
  options: PiLiveOptions = {},
): Promise<PiCatalogModel | undefined> {
  const models = await openRouterModels(options);
  const match = openRouterIds(provider, id)
    .map((key) => models.get(key))
    .find(Boolean);
  if (!match) return undefined;
  const perMillion = (price?: string) => Math.max(0, Number(price ?? 0) * 1_000_000) || 0;
  const contextWindow = match.context_length ?? 128_000;
  return {
    id,
    name: match.name?.replace(/^[^:]+:\s*/, "") ?? id,
    reasoning: match.supported_parameters?.includes("reasoning") ?? false,
    contextWindow,
    maxTokens: match.top_provider?.max_completion_tokens ?? Math.min(contextWindow, 32_000),
    cost: { input: perMillion(match.pricing?.prompt), output: perMillion(match.pricing?.completion) },
  };
}

const lists = new Map<string, { at: number; models: PiCatalogModel[] }>();
const known = new Map<string, PiCatalogModel>();

/** A model a live listing or an estimate already resolved in this process, if any. */
export function findLivePiModel(provider: string, id: string): PiCatalogModel | undefined {
  return known.get(`${provider}/${id}`);
}

export interface ListPiModelsLiveOptions extends PiLiveOptions {
  /** Cache key for this credential (a connection id); the key itself is never stored. */
  cacheKey: string;
  provider: string;
  apiKey: string;
  /** The Pi catalog for this provider, used for metadata and as the fallback list. */
  catalog: readonly PiCatalogModel[];
}

/**
 * Models this key can use, newest first. Any failure (network, 4xx, an unknown provider) falls back to the
 * catalog, so the picker is never empty. An id with neither catalog nor OpenRouter metadata is left out,
 * since the task budget could not price it.
 */
export async function listPiModelsLive(options: ListPiModelsLiveOptions): Promise<PiCatalogModel[]> {
  const source = LIVE_SOURCES[options.provider];
  if (!source) return [...options.catalog];
  const now = options.now?.() ?? Date.now();
  const hit = lists.get(options.cacheKey);
  if (hit && now - hit.at < LIST_TTL_MS) return hit.models;
  try {
    const response = await (options.fetch ?? fetch)(source.url, {
      headers: source.headers(options.apiKey),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return [...options.catalog];
    const body = (await response.json()) as {
      data?: Array<{ id?: unknown; created_at?: unknown; created?: unknown }>;
    };
    const created = (m: { created_at?: unknown; created?: unknown }) =>
      typeof m.created === "number" ? m.created * 1000 : Date.parse(String(m.created_at ?? "")) || 0;
    const ids = (body.data ?? [])
      .filter((m): m is { id: string; created_at?: unknown; created?: unknown } => typeof m.id === "string")
      .filter((m) => source.keep(m.id))
      .sort((a, b) => created(b) - created(a))
      .map((m) => m.id);
    const byId = new Map(options.catalog.map((m) => [m.id, m]));
    const models: PiCatalogModel[] = [];
    for (const id of ids) {
      const model = byId.get(id) ?? (await estimatePiModel(options.provider, id, options));
      if (!model) continue;
      models.push(model);
      known.set(`${options.provider}/${id}`, model);
    }
    if (models.length === 0) return [...options.catalog];
    lists.set(options.cacheKey, { at: now, models });
    return models;
  } catch {
    return [...options.catalog];
  }
}
