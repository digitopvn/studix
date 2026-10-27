import type { AgentRuntime } from "@studix/core";
import { type Clock, StudixError } from "@studix/shared";
import { type AgentLoop, createBoundedAgentRuntime } from "./bounded-agent-runtime.ts";

export interface PiAgentRuntimeOptions {
  /**
   * The Pi agent loop. P0 ships no real loop: planning goes through the DecisionRouter, so without a
   * loop every run fails with UNAVAILABLE instead of pretending to do agent work.
   */
  loop?: AgentLoop;
  clock?: Clock;
}

export const PI_AGENT_RUNTIME_ID = "pi";

/** The Pi boundary: budget, turns, deadline and cancellation enforced around an injected loop. */
export function createPiAgentRuntime(options: PiAgentRuntimeOptions = {}): AgentRuntime {
  const loop: AgentLoop =
    options.loop ??
    (async (_ctx, task) => {
      throw new StudixError("UNAVAILABLE", `No Pi agent loop is configured (skill "${task.skill}")`, {
        retryable: false,
        suggestedAction: "Use a DecisionRouter-backed skill, or configure an agent loop for this runtime.",
      });
    });
  return createBoundedAgentRuntime({ id: PI_AGENT_RUNTIME_ID, loop, clock: options.clock });
}
