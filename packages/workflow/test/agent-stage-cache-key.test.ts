import { describe, expect, it } from "vitest";
import { agentKeyOf } from "../src/agent-stage.ts";

const claude = {
  runtime: "claude" as const,
  connectionId: "pc_1",
  provider: "anthropic",
  modelId: "claude-haiku-5-5",
};

describe("agent stage cache key", () => {
  it("changes with the agent that runs the stage", () => {
    const base = agentKeyOf({ roles: { director: claude } }, "skill-agent.director");
    const variants = [
      { roles: { director: { ...claude, modelId: "claude-sonnet-5-5" } } },
      { roles: { director: { ...claude, reasoningEffort: "high" } } },
      { roles: { director: { ...claude, connectionId: "pc_2" } } },
      { roles: { director: { ...claude, runtime: "pi" } } },
      { roles: { director: claude, qa: claude } },
      { agent: claude },
    ];
    for (const payload of variants) {
      expect(JSON.stringify(agentKeyOf(payload, "skill-agent.director"))).not.toBe(JSON.stringify(base));
    }
    expect(JSON.stringify(agentKeyOf({ roles: { director: claude } }, "skill-agent.director"))).toBe(
      JSON.stringify(base),
    );
  });
});
