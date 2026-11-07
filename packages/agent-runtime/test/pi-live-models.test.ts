import { describe, expect, it } from "vitest";
import { findPiModel, listPiModelsLive } from "../src/index.ts";

const catalogModel = {
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  reasoning: true,
  contextWindow: 400_000,
  maxTokens: 128_000,
  cost: { input: 5, output: 40 },
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function fakeFetch(openai: unknown) {
  const urls: string[] = [];
  const fn = (async (input: string | URL | Request) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith("https://openrouter.ai/")) {
      return json({
        data: [
          {
            id: "openai/gpt-7-nova",
            name: "OpenAI: GPT-7 Nova",
            context_length: 1_000_000,
            pricing: { prompt: "0.000006", completion: "0.00005" },
            top_provider: { max_completion_tokens: 200_000 },
            supported_parameters: ["reasoning", "tools"],
          },
        ],
      });
    }
    return openai instanceof Response ? openai : json(openai);
  }) as typeof fetch;
  return { fn, urls };
}

describe("live Pi model listing", () => {
  it("lists the key's chat models newest first, pricing unknown ones from OpenRouter", async () => {
    const { fn } = fakeFetch({
      data: [
        { id: "gpt-6.1-sol", created: 100 },
        { id: "gpt-7-nova", created: 200 },
        { id: "text-embedding-3-large", created: 300 },
        { id: "gpt-9-unpriced", created: 400 },
      ],
    });
    const models = await listPiModelsLive({
      cacheKey: "conn-1",
      provider: "openai",
      apiKey: "sk-fake",
      catalog: [catalogModel],
      fetch: fn,
    });
    expect(models.map((m) => m.id)).toEqual(["gpt-7-nova", "gpt-6.1-sol"]);
    expect(models[0]).toMatchObject({
      name: "GPT-7 Nova",
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 200_000,
      cost: { input: 6, output: 50 },
    });
    // A run on the listed model now passes validation.
    expect(findPiModel("openai", "gpt-7-nova")?.cost.input).toBe(6);
  });

  it("falls back to the catalog when the provider rejects the key", async () => {
    const { fn } = fakeFetch(json({ error: "bad key" }, 401));
    const models = await listPiModelsLive({
      cacheKey: "conn-2",
      provider: "openai",
      apiKey: "sk-bad",
      catalog: [catalogModel],
      fetch: fn,
    });
    expect(models).toEqual([catalogModel]);
  });

  it("returns the catalog for a provider without a live listing, without calling out", async () => {
    const { fn, urls } = fakeFetch({ data: [] });
    const models = await listPiModelsLive({
      cacheKey: "conn-3",
      provider: "mistral",
      apiKey: "k",
      catalog: [catalogModel],
      fetch: fn,
    });
    expect(models).toEqual([catalogModel]);
    expect(urls).toEqual([]);
  });
});
