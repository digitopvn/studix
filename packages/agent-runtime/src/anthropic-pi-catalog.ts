import type { PiEndpoint } from "./pi-binding.ts";

/*
 * The pinned Pi SDK (0.73.1, the last release under @mariozechner) stops at Claude 4.5, so Studix pins the
 * current Anthropic list here, newest first, at first-party list prices. Haiku 5.5 is priced at its long-
 * prompt tier so the task budget never under-counts. Cache writes are the 5-minute rate (1.25x input).
 */
type AnthropicModel = NonNullable<PiEndpoint["models"]>[number];

const model = (
  id: string,
  name: string,
  contextWindow: number,
  maxTokens: number,
  input: number,
  output: number,
  cacheRead: number,
): AnthropicModel => ({
  id,
  name,
  reasoning: true,
  input: ["text", "image"],
  contextWindow,
  maxTokens,
  cost: { input, output, cacheRead, cacheWrite: input * 1.25 },
});

export const ANTHROPIC_ENDPOINT: PiEndpoint = {
  baseUrl: "https://api.anthropic.com",
  api: "anthropic-messages",
  models: [
    model("claude-fable-5-1", "Claude Fable 5.1", 1_000_000, 128_000, 10, 50, 0.25),
    model("claude-opus-5-5", "Claude Opus 5.5", 1_000_000, 128_000, 4, 20, 0.2),
    model("claude-sonnet-5-5", "Claude Sonnet 5.5", 1_000_000, 128_000, 2, 10, 0.2),
    model("claude-haiku-5-5", "Claude Haiku 5.5", 1_000_000, 128_000, 0.5, 2.5, 0.05),
    model("claude-fable-5", "Claude Fable 5", 1_000_000, 128_000, 10, 50, 1),
    model("claude-opus-5", "Claude Opus 5", 1_000_000, 128_000, 5, 25, 0.5),
    model("claude-sonnet-5", "Claude Sonnet 5", 1_000_000, 128_000, 2, 10, 0.2),
    model("claude-opus-4-8", "Claude Opus 4.8", 1_000_000, 128_000, 5, 25, 0.5),
    model("claude-opus-4-7", "Claude Opus 4.7", 1_000_000, 128_000, 5, 25, 0.5),
    model("claude-opus-4-6", "Claude Opus 4.6", 1_000_000, 128_000, 5, 25, 0.5),
    model("claude-sonnet-4-6", "Claude Sonnet 4.6", 1_000_000, 128_000, 3, 15, 0.3),
    model("claude-haiku-4-5", "Claude Haiku 4.5", 200_000, 64_000, 1, 5, 0.1),
  ],
};
