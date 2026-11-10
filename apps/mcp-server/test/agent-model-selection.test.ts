import type { ModelPreferenceService, ProviderConnectionService, ProviderConnectionView } from "@studix/auth";
import { testTenant } from "@studix/core/testing";
import { StudixError } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { resolveAgentSelection } from "../src/agent-model-selection.ts";

const view = (over: Partial<ProviderConnectionView>): ProviderConnectionView =>
  ({
    id: "pcon_go",
    provider: "openai",
    runtimes: ["pi"],
    owner: "workspace",
    status: "available",
    ...over,
  }) as ProviderConnectionView;

/** The connection service as the caller sees it: one usable key and one whose last test failed. */
const providers = {
  async list() {
    return { connections: [view({}), view({ id: "pcon_bad" })] };
  },
  async assertUsable(_ctx: unknown, connectionId: string) {
    if (connectionId === "pcon_bad") {
      throw new StudixError("UNAUTHENTICATED", "The OpenAI API key was rejected at its last test", {
        retryable: false,
      });
    }
    return view({ id: connectionId });
  },
} as unknown as ProviderConnectionService;

describe("agent selection preflight", () => {
  const ctx = testTenant();

  it("stores a usable Pi connection with a catalog model", async () => {
    await expect(
      resolveAgentSelection({ providers }, ctx, {
        runtime: "pi",
        providerConnectionId: "pcon_go",
        model: "gpt-4o-mini",
      }),
    ).resolves.toEqual({
      runtime: "pi",
      connectionId: "pcon_go",
      provider: "openai",
      modelId: "gpt-4o-mini",
    });
  });

  it("rejects an unknown or unusable connection and an unknown model before the job is queued", async () => {
    const select = (providerConnectionId: string, model?: string) =>
      resolveAgentSelection({ providers }, ctx, {
        runtime: "pi",
        providerConnectionId,
        ...(model ? { model } : {}),
      });
    await expect(select("pcon_missing")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(select("pcon_bad")).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(select("pcon_go", "no-such-model")).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses a Pi agent without a model when no default applies to the caller", async () => {
    const preferences = (stages: string[]) =>
      ({
        async preview(_ctx: unknown, input: { stage: string }) {
          return stages.includes(input.stage)
            ? { runtime: "pi", stage: input.stage, selection: { source: "workspace-default" } }
            : { runtime: "pi", stage: input.stage };
        },
      }) as unknown as ModelPreferenceService;
    const select = (modelPreferences: ModelPreferenceService) =>
      resolveAgentSelection({ providers, modelPreferences }, ctx, {
        runtime: "pi",
        providerConnectionId: "pcon_go",
      });

    await expect(select(preferences([]))).rejects.toMatchObject({
      code: "UNAVAILABLE",
      details: { reason: "no_model_selected" },
    });
    await expect(select(preferences(["default"]))).resolves.toEqual({
      runtime: "pi",
      connectionId: "pcon_go",
      provider: "openai",
    });
    // A plan-stage entry never reaches an agent stage, so it does not count.
    await expect(select(preferences(["plan"]))).rejects.toMatchObject({ code: "UNAVAILABLE" });
    // Host mode or a planner never resolves a Pi default.
    await expect(
      resolveAgentSelection(
        { providers, modelPreferences: preferences([]) },
        ctx,
        { runtime: "pi", providerConnectionId: "pcon_go" },
        false,
      ),
    ).resolves.toMatchObject({ runtime: "pi" });
  });
});
