import { describe, expect, it } from "vitest";
import { z } from "zod";
import { OpenRouterAdapter, type OpenRouterAdapterOptions } from "../src/index.ts";
import {
  CONTRACT_INVALID_OUTPUT,
  CONTRACT_VALID_OUTPUT,
  type ContractScenario,
  contractRequest,
  createScriptedFetch,
  hangUntilAborted,
  jsonResponse,
  runDecisionProviderContract,
} from "../src/testing/index.ts";

/** Loosely typed view of the recorded JSON request body (test-only, shape asserted below). */
// biome-ignore lint/suspicious/noExplicitAny: recorded wire payloads are asserted structurally.
type WireBody = Record<string, any>;
const API_KEY = "or-contract-test-key-0123456789abcdef";

/** Shape of a real OpenRouter chat completion (recorded, trimmed). */
function completion(content: string) {
  return {
    id: "gen-1761580000-AbCdEf",
    provider: "OpenAI",
    model: "openai/gpt-4o-mini",
    object: "chat.completion",
    created: 1761580000,
    choices: [
      {
        logprobs: null,
        finish_reason: "stop",
        native_finish_reason: "stop",
        index: 0,
        message: { role: "assistant", content, refusal: null, reasoning: null },
      },
    ],
    usage: {
      prompt_tokens: 182,
      completion_tokens: 12,
      total_tokens: 194,
      cost: 0.0000345,
      is_byok: false,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 0 },
    },
  };
}

function scriptFor(scenario: ContractScenario) {
  return createScriptedFetch((_call, signal) => {
    switch (scenario) {
      case "valid":
      case "costly":
        return jsonResponse(200, completion(JSON.stringify(CONTRACT_VALID_OUTPUT)));
      case "invalid":
        return jsonResponse(200, completion(JSON.stringify(CONTRACT_INVALID_OUTPUT)));
      case "slow":
        return hangUntilAborted(signal);
      case "rate_limited":
        return jsonResponse(
          429,
          { error: { message: "Rate limit exceeded", code: 429 } },
          { "retry-after": "2" },
        );
      case "unavailable":
        return jsonResponse(502, { error: { message: "Provider returned error", code: 502 } });
      case "auth_failed":
        return jsonResponse(401, { error: { message: "No auth credentials found", code: 401 } });
      case "leaky_error":
        return jsonResponse(500, {
          error: {
            message: `upstream rejected header Authorization: Bearer ${API_KEY} (key ${API_KEY})`,
            code: 500,
          },
        });
    }
  });
}

function adapter(overrides: Partial<OpenRouterAdapterOptions> = {}) {
  return new OpenRouterAdapter({ apiKey: API_KEY, model: "openai/gpt-4o-mini", ...overrides });
}

runDecisionProviderContract("OpenRouterAdapter", (scenario, { logger }) => {
  const scripted = scriptFor(scenario);
  const pricing =
    scenario === "costly" ? { inputCentsPerMillionTokens: 15, outputCentsPerMillionTokens: 60 } : undefined;
  return {
    provider: adapter({ fetch: scripted.fetch, logger, pricing }),
    upstreamCalls: () => scripted.calls.length,
    secret: API_KEY,
  };
});

describe("OpenRouterAdapter wire protocol", () => {
  it("sends an OpenAI-compatible chat completion with a JSON-schema response format", async () => {
    const scripted = scriptFor("valid");
    const provider = adapter({
      fetch: scripted.fetch,
      baseUrl: "https://gateway.example.com/api/v1/",
      modelsByKind: { "qa.route": "anthropic/claude-haiku" },
      appName: "Studix",
    });
    const result = await provider.decide(contractRequest());
    const [call] = scripted.calls;
    expect(call?.url).toBe("https://gateway.example.com/api/v1/chat/completions");
    expect(call?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    expect(call?.headers["x-title"]).toBe("Studix");
    const body = call?.body as WireBody;
    expect(body.model).toBe("anthropic/claude-haiku");
    expect(body.temperature).toBe(0);
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("qa_route");
    expect(body.response_format.json_schema.schema.properties.route.enum).toEqual([
      "render",
      "review",
      "reject",
    ]);
    expect(body.response_format.json_schema.schema.$schema).toBeUndefined();
    expect(body.messages[1].content).toContain("please hurry");
    // Cost comes from usage.cost (USD) converted to cents; the answering model is reported back.
    expect(result.costCents).toBeCloseTo(0.00345, 8);
    expect(result.model).toBe("openai/gpt-4o-mini");
    expect(result.usage).toEqual({ inputTokens: 182, outputTokens: 12 });
  });

  it("unwraps fenced JSON and maps in-body upstream errors", async () => {
    const fenced = createScriptedFetch(() =>
      jsonResponse(200, completion(`\`\`\`json\n${JSON.stringify(CONTRACT_VALID_OUTPUT)}\n\`\`\``)),
    );
    expect((await adapter({ fetch: fenced.fetch }).decide(contractRequest())).output).toEqual(
      CONTRACT_VALID_OUTPUT,
    );

    const inBody = createScriptedFetch(() =>
      jsonResponse(200, { error: { message: "overloaded", code: 503 } }),
    );
    await expect(adapter({ fetch: inBody.fetch }).decide(contractRequest())).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
  });

  it("treats null and empty-string optional fields as absent", async () => {
    const schema = z.object({ title: z.string().min(1), cta: z.string().min(1).optional() });
    const scripted = createScriptedFetch(() =>
      jsonResponse(200, completion(JSON.stringify({ title: "Sương Mai", cta: "", note: null }))),
    );
    const request = { ...contractRequest(), schema, jsonSchema: undefined };
    const result = await adapter({ fetch: scripted.fetch }).decide(request as never);
    expect(result.output).toEqual({ title: "Sương Mai" });
  });

  it("rejects a malformed configuration without echoing the key", () => {
    expect(() => adapter({ apiKey: "short" })).toThrow(/API key is missing or malformed/);
    expect(() => adapter({ baseUrl: "ftp://example.com" })).toThrow(/http\(s\)/);
    expect(() => adapter({ model: " " })).toThrow(/model/);
  });
});
