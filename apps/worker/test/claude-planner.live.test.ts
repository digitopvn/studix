import { existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSdkTransport, preflightClaudeRuntime } from "@studix/agent-runtime";
import type { ResolvedProviderCredential } from "@studix/auth";
import type { NewProviderExecution, NewUsageEvent } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { createLogger } from "@studix/shared";
import { validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { createClaudePlanner } from "../src/planner/claude-planner.ts";
import { prepareClaudeSandboxRoot } from "../src/planner/claude-sandbox.ts";

/**
 * Paid smoke test of the Claude planner (collected only with STUDIX_LIVE=1 and ANTHROPIC_API_KEY set). One
 * short plan on the configured model, capped at STUDIX_CLAUDE_LIVE_MAX_COST_CENTS (default 100).
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.STUDIX_CLAUDE_LIVE_MODEL ?? "claude-sonnet-5-5";
const maxCostCents = Number(process.env.STUDIX_CLAUDE_LIVE_MAX_COST_CENTS ?? 100);

describe.skipIf(!apiKey)("Claude planner (live)", () => {
  it("runs on this host, plans a valid VideoIR, records its cost and removes the sandbox", async () => {
    const runtime = await preflightClaudeRuntime();
    expect(runtime, runtime.ok ? "" : runtime.reason).toMatchObject({ ok: true });

    const logger = createLogger({}, { write: () => {} });
    const sandboxRoot = prepareClaudeSandboxRoot(join(tmpdir(), "studix-claude-live"), 600_000, logger);
    const executions: NewProviderExecution[] = [];
    const usage: NewUsageEvent[] = [];
    const planner = createClaudePlanner({
      transport: createClaudeSdkTransport({ sandboxRoot, baseUrl: process.env.ANTHROPIC_BASE_URL }),
      credentials: {
        async resolveForExecution() {
          return { apiKey, markRejected: async () => {} } as unknown as ResolvedProviderCredential;
        },
      },
      model,
      maxTurns: 4,
      maxCostCents,
      timeoutMs: 240_000,
      executions: {
        async recordProviderExecution(_tenant, execution) {
          executions.push(execution);
          return { id: "pex_live" } as never;
        },
        async record(_tenant, event) {
          usage.push(event);
          return undefined as never;
        },
      },
      logger,
    });

    const result = await planner(
      {
        prompt: "A 10 second vertical teaser for Acme Coffee's new cold brew.",
        aspectRatio: "9:16",
        durationMs: 10_000,
      },
      {
        tenant: testTenant(),
        jobId: "job_live",
        projectId: "prj_live",
        attempt: 1,
        maxCostCents,
        requestedBy: { type: "user", id: "usr_live" },
        planner: { runtime: "claude", providerConnectionId: "pcn_live" },
      },
      new AbortController().signal,
    );

    expect(validateVideoIR(result.ir).ok).toBe(true);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.costCents).toBeGreaterThan(0);
    expect(result.usage[0]?.costCents).toBeLessThanOrEqual(maxCostCents);
    expect(executions).toEqual([expect.objectContaining({ provider: "anthropic", status: "succeeded" })]);
    expect(usage).toEqual([]);

    // The planner has returned, so its session is closed and the throwaway directory must be gone.
    expect(existsSync(sandboxRoot)).toBe(true);
    expect(readdirSync(sandboxRoot).filter((name) => name.startsWith("studix-claude-"))).toEqual([]);
  });
});
