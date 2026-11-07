import type { PiEndpoint } from "./pi-binding.ts";

/*
 * OpenCode Go retires and renames models faster than the Pi SDK republishes its catalog, and it answers a
 * retired id with "Model is unavailable" or a 429 budget error. Studix therefore pins the live list here
 * (https://opencode.ai/zen/go/v1/models): only paid models served over chat completions, at peak prices
 * so the task budget never under-counts.
 */
type OpenCodeGoModel = NonNullable<PiEndpoint["models"]>[number];

const model = (
  id: string,
  name: string,
  image: boolean,
  contextWindow: number,
  maxTokens: number,
  input: number,
  output: number,
  cacheRead: number,
): OpenCodeGoModel => ({
  id,
  name,
  reasoning: true,
  input: image ? ["text", "image"] : ["text"],
  contextWindow,
  maxTokens,
  cost: { input, output, cacheRead, cacheWrite: 0 },
});

export const OPENCODE_GO_ENDPOINT: PiEndpoint = {
  baseUrl: "https://opencode.ai/inference/go/openai/v1",
  api: "openai-completions",
  models: [
    model("deepseek-v4.1-flash", "DeepSeek V4.1 Flash", true, 1_000_000, 384_000, 0.3, 1.2, 0.006),
    model("deepseek-v4-pro", "DeepSeek V4 Pro", false, 1_000_000, 384_000, 1.32, 3.96, 0.044),
    model("glm-5.2", "GLM-5.2", false, 1_000_000, 131_072, 1.4, 4.4, 0.26),
    model("glm-5.3", "GLM-5.3", false, 1_000_000, 131_072, 1.4, 4.4, 0.26),
    model("glm-5.3-flash", "GLM-5.3-Flash", true, 1_000_000, 131_072, 0.15, 0.5, 0.03),
    model("hy3", "Hy3", false, 256_000, 128_000, 0.14, 0.58, 0.035),
    model("hy4", "Hy4", true, 1_048_576, 65_536, 0.834, 2.501, 0.042),
    model("hy4-preview", "Hy4 preview", false, 1_024_000, 64_000, 0.834, 2.501, 0.042),
    model("kimi-k2.7-code", "Kimi K2.7 Code", true, 262_144, 262_144, 0.95, 4, 0.19),
    model("kimi-k3", "Kimi K3", true, 1_048_576, 131_072, 3, 15, 0.3),
    model("kimi-k3.1-pro", "Kimi K3.1 Pro", true, 1_048_576, 131_072, 2, 10, 0.2),
    model("longcat-2.0", "LongCat-2.0", false, 1_000_000, 131_072, 0.3, 1.2, 0.006),
    model("mimo-v2.6-flash", "MiMo-V2.6-Flash", true, 1_048_576, 131_072, 0.14, 0.28, 0.0028),
    model("mimo-v2.6-pro", "MiMo-V2.6-Pro", true, 1_048_576, 131_072, 0.435, 0.87, 0.003625),
    model("minimax-m3.1-flash", "MiniMax M3.1 Flash", true, 1_000_000, 512_000, 0.15, 0.6, 0.015),
    model("step-5-preview", "Step 5 Preview", true, 1_000_000, 65_536, 1, 2.7, 0.1),
  ],
};

/** The endpoint Studix pins for a provider whose SDK catalog is stale, if any. */
export function pinnedPiEndpoint(provider: string): PiEndpoint | undefined {
  return provider === "opencode-go" ? OPENCODE_GO_ENDPOINT : undefined;
}
