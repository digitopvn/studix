import { describe, expect, it } from "vitest";
import { CLAUDE_MODELS, claudeModelReasoning, listClaudeModels } from "../src/index.ts";

const KEY = "sk-ant-api03-test-key-not-real";

function fakeFetch(status: number, data: unknown[]) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const doFetch = (async (url: string, init: { headers: Record<string, string> }) => {
    calls.push({ url, headers: init.headers });
    return new Response(JSON.stringify({ data }), { status });
  }) as unknown as typeof fetch;
  return { calls, doFetch };
}

describe("claude models", () => {
  it("lists a key's models live, newest first, without retired families, and caches them", async () => {
    const { calls, doFetch } = fakeFetch(200, [
      { id: "claude-3-opus-20240229", created_at: "2024-02-29T00:00:00Z" },
      { id: "claude-opus-4-1-20250805", created_at: "2025-08-05T00:00:00Z" },
      { id: "claude-opus-5-5", created_at: "2026-09-01T00:00:00Z" },
      { id: "claude-fable-5-1", created_at: "2026-10-01T00:00:00Z" },
    ]);
    const options = {
      cacheKey: "pc_live",
      apiKey: KEY,
      baseUrl: "https://api.example.test/",
      fetch: doFetch,
    };
    const models = await listClaudeModels(options);
    expect(models).toEqual([
      { id: "claude-fable-5-1", reasoning: true },
      { id: "claude-opus-5-5", reasoning: true },
      { id: "claude-opus-4-1-20250805", reasoning: false },
    ]);
    expect(calls[0]!.url).toBe("https://api.example.test/v1/models?limit=1000");
    expect(calls[0]!.headers["x-api-key"]).toBe(KEY);
    await listClaudeModels(options);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the static current list when the key cannot list models", async () => {
    const { doFetch } = fakeFetch(401, []);
    expect(await listClaudeModels({ cacheKey: "pc_bad", apiKey: KEY, fetch: doFetch })).toEqual([
      ...CLAUDE_MODELS,
    ]);
    expect(CLAUDE_MODELS.map((m) => m.id)).toContain("claude-opus-5-5");
  });

  it("knows which models take an effort level", () => {
    expect(claudeModelReasoning("claude-opus-5-5")).toBe(true);
    expect(claudeModelReasoning("claude-sonnet-4-5")).toBe(true);
    expect(claudeModelReasoning("claude-sonnet-4-0")).toBe(false);
    expect(claudeModelReasoning("claude-3-5-haiku-latest")).toBe(false);
  });
});
