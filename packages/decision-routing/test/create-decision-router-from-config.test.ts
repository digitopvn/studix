import { describe, expect, it } from "vitest";
import { createDecisionRouterFromConfig, RulesAdapter } from "../src/index.ts";
import {
  CONTRACT_KIND,
  CONTRACT_VALID_OUTPUT,
  contractRequest,
  createScriptedFetch,
  jsonResponse,
} from "../src/testing/index.ts";

const OPENROUTER_KEY = "or-config-test-key-0123456789abcdef";
const TYPESAFE_KEY = "ts-config-test-key-0123456789abcdef";

describe("createDecisionRouterFromConfig", () => {
  it("defaults to the rules provider only", async () => {
    const rules = new RulesAdapter({ rules: { [CONTRACT_KIND]: () => CONTRACT_VALID_OUTPUT } });
    const router = createDecisionRouterFromConfig({}, { rules });
    expect(router.providerIds()).toEqual(["rules"]);
    await expect(router.decide(contractRequest())).resolves.toMatchObject({ providerId: "rules" });
  });

  it("builds per-kind chains from DECISION_ROUTES and calls the configured provider", async () => {
    const scripted = createScriptedFetch(() =>
      jsonResponse(200, {
        model: "jev-1.13",
        answers: { route: { type: "choice", choice: "review" }, urgent: { type: "noul", noul: 0.1 } },
        usage: { input_tokens: 50, output_tokens: 2 },
      }),
    );
    const router = createDecisionRouterFromConfig(
      {
        DECISION_PROVIDERS: "openrouter,rules",
        DECISION_ROUTES: ` ${CONTRACT_KIND}=typesafe>openrouter ; video.plan=openrouter>rules`,
        OPENROUTER_API_KEY: OPENROUTER_KEY,
        OPENROUTER_DECISION_MODEL: "openai/gpt-4o-mini",
        OPENROUTER_INPUT_CENTS_PER_MTOK: "15",
        TYPESAFE_API_KEY: TYPESAFE_KEY,
        TYPESAFE_BASE_URL: "https://typesafe.example.com/v1",
        TYPESAFE_INPUT_CENTS_PER_MTOK: "10",
      },
      { fetch: scripted.fetch },
    );
    expect(router.providerIds()).toEqual(["openrouter", "typesafe", "rules"]);
    const result = await router.decide(contractRequest());
    expect(result).toMatchObject({ providerId: "typesafe", output: { route: "review", urgent: false } });
    expect(result.costCents).toBeCloseTo(0.0005, 10);
    expect(scripted.calls[0]?.url).toBe("https://typesafe.example.com/v1/systemone");
  });

  it("fails at boot when a referenced provider lacks credentials, naming variables but never values", () => {
    const attempt = () =>
      createDecisionRouterFromConfig({
        DECISION_PROVIDERS: "openrouter",
        OPENROUTER_API_KEY: OPENROUTER_KEY,
      });
    expect(attempt).toThrow(/openrouter needs an API key and a decision model/);
    try {
      attempt();
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(OPENROUTER_KEY);
      expect((error as Error).message).not.toContain(OPENROUTER_KEY);
    }
  });

  it("rejects unknown providers and malformed routes", () => {
    expect(() => createDecisionRouterFromConfig({ DECISION_PROVIDERS: "openai" })).toThrow(
      /DECISION_PROVIDERS/,
    );
    expect(() => createDecisionRouterFromConfig({ DECISION_ROUTES: "video.plan" })).toThrow(
      /DECISION_ROUTES/,
    );
    expect(() => createDecisionRouterFromConfig({ OPENROUTER_INPUT_CENTS_PER_MTOK: "-1" })).toThrow(
      /OPENROUTER_INPUT_CENTS_PER_MTOK/,
    );
  });
});
