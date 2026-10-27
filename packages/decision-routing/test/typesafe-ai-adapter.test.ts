import { describe, expect, it } from "vitest";
import { z } from "zod";
import { TypeSafeAIAdapter, type TypeSafeAIAdapterOptions } from "../src/index.ts";
import {
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
const API_KEY = "ts-contract-test-key-0123456789abcdef";

/** Shape of a real System One response (per docs.typesafe.ai/api/system-one). */
function systemOne(route: string, urgentYes: number) {
  return {
    model: "jev-1.13",
    answers: {
      route: {
        type: "choice",
        choice: route,
        confidence: 0.91,
        probabilities: { render: 0.93, review: 0.05, reject: 0.02 },
      },
      urgent: { type: "noul", noul: urgentYes },
    },
    usage: { input_tokens: 210, output_tokens: 4 },
  };
}

function scriptFor(scenario: ContractScenario) {
  return createScriptedFetch((_call, signal) => {
    switch (scenario) {
      case "valid":
      case "costly":
        return jsonResponse(200, systemOne("render", 0.97));
      case "invalid":
        return jsonResponse(200, systemOne("teleport", 0.5));
      case "slow":
        return hangUntilAborted(signal);
      case "rate_limited":
        return jsonResponse(429, { detail: "Rate limit exceeded" });
      case "unavailable":
        return jsonResponse(529, { detail: "Overloaded" });
      case "auth_failed":
        return jsonResponse(401, { detail: "Invalid API key" });
      case "leaky_error":
        return jsonResponse(400, {
          detail: `Malformed header: Authorization=Bearer ${API_KEY}; key=${API_KEY}`,
        });
    }
  });
}

function adapter(overrides: Partial<TypeSafeAIAdapterOptions> = {}) {
  return new TypeSafeAIAdapter({ apiKey: API_KEY, ...overrides });
}

runDecisionProviderContract("TypeSafeAIAdapter", (scenario, { logger }) => {
  const scripted = scriptFor(scenario);
  const pricing =
    scenario === "costly" ? { inputCentsPerMillionTokens: 10, outputCentsPerMillionTokens: 0 } : undefined;
  return {
    provider: adapter({ fetch: scripted.fetch, logger, pricing }),
    upstreamCalls: () => scripted.calls.length,
    secret: API_KEY,
  };
});

describe("TypeSafeAIAdapter wire protocol", () => {
  it("asks one System One question per output field and folds the typed answers back", async () => {
    const scripted = scriptFor("valid");
    const result = await adapter({ fetch: scripted.fetch }).decide(contractRequest());
    const [call] = scripted.calls;
    expect(call?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call?.headers.authorization).toBe(`Bearer ${API_KEY}`);
    const body = call?.body as WireBody;
    expect(body.model).toBe("jev-latest");
    expect(body.state).toEqual(contractRequest().input);
    expect(body.questions.route).toMatchObject({
      type: "choice",
      criteria: { render: "render", review: "review", reject: "reject" },
    });
    expect(body.questions.route.instructions).toContain("Where the draft goes next");
    expect(body.questions.urgent.type).toBe("noul");
    expect(result.output).toEqual({ route: "render", urgent: true });
    expect(result.model).toBe("jev-1.13");
    expect(result.usage).toEqual({ inputTokens: 210, outputTokens: 4 });
  });

  it("charges input tokens only, from configured pricing", async () => {
    const scripted = scriptFor("valid");
    const provider = adapter({
      fetch: scripted.fetch,
      pricing: { inputCentsPerMillionTokens: 100, outputCentsPerMillionTokens: 0 },
    });
    expect((await provider.decide(contractRequest())).costCents).toBeCloseTo(0.021, 8);
  });

  it("refuses schemas it cannot express as questions without calling the API", async () => {
    const scripted = scriptFor("valid");
    const request = contractRequest({ schema: z.object({ title: z.string() }) as never });
    await expect(adapter({ fetch: scripted.fetch }).decide(request)).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
      retryable: false,
      details: { reason: "unsupported" },
    });
    expect(scripted.calls).toHaveLength(0);
  });

  it("uses a registered mapper for kinds that need custom questions", async () => {
    const scripted = createScriptedFetch(() =>
      jsonResponse(200, { model: "jev-1.13", answers: { ok: { type: "noul", noul: 0.2 } }, usage: {} }),
    );
    const provider = adapter({
      fetch: scripted.fetch,
      mappers: {
        "qa.route": () => ({
          state: "custom",
          questions: { ok: { type: "noul", instructions: "Is the draft ready?" } },
          toOutput: (answers) => ({
            route: (answers.ok?.noul ?? 0) >= 0.5 ? "render" : "review",
            urgent: false,
          }),
        }),
      },
    });
    expect((await provider.decide(contractRequest())).output).toEqual({ route: "review", urgent: false });
    expect(scripted.calls[0]?.body).toMatchObject({ state: "custom" });
  });
});
