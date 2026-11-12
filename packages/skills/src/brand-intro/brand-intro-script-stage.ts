import { briefForAgent, CreativeBrief } from "@studix/video-ir";
import { createAgentStage } from "@studix/workflow";
import { z } from "zod";

export const BRAND_INTRO_SCRIPT_STAGE = "brand-intro.script";

const ScriptInput = z.object({ payload: z.object({ brief: CreativeBrief }) });

/** One beat of the brand-intro script: what is on screen and what is said. */
export const BrandIntroScriptBeat = z.object({
  heading: z.string().min(1).max(120),
  voiceover: z.string().min(1).max(600),
  durationMs: z.number().int().min(500).max(15_000),
});

export const BrandIntroScript = z.object({
  script: z.object({
    title: z.string().min(1).max(120),
    beats: z.array(BrandIntroScriptBeat).min(2).max(6),
    callToAction: z.string().min(1).max(200),
  }),
});
export type BrandIntroScript = z.infer<typeof BrandIntroScript>;

/**
 * Brief -> narrated script, written by an agent: in the worker's harness or by the MCP host agent
 * (`payload.agentMode: "host"`), under the same schemas and limits.
 */
export const brandIntroScriptStage = createAgentStage({
  name: BRAND_INTRO_SCRIPT_STAGE,
  version: 1,
  inputSchema: ScriptInput,
  outputSchema: BrandIntroScript,
  instructions:
    "Write the narrated script of a 6-15 second brand introduction from the creative brief. Keep the " +
    "brief's language (Vietnamese copy keeps its diacritics), use two to six short beats whose durations " +
    "add up to the brief's duration, and end with the call to action. Return only JSON matching the output schema.",
  taskInput: (input) => ({ brief: briefForAgent(input.payload.brief) }),
  limits: { maxTurns: 4, maxTokens: 20_000, maxCostCents: 25, timeoutMs: 120_000 },
});
