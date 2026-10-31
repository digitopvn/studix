import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSdkTransport, preflightClaudeRuntime } from "@studix/agent-runtime";
import type { ResolvedProviderCredential } from "@studix/auth";
import type { NewProviderExecution, ProviderExecution } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { createLogger } from "@studix/shared";
import { validateVideoIR } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { createClaudePlanner } from "../src/planner/claude-planner.ts";

/**
 * Paid smoke test (collected only with STUDIX_LIVE=1, and skipped without ANTHROPIC_API_KEY). One real
 * planning run through the Agent SDK on a cheap model, capped at 50 cents; the real spend is a few cents.
 * Run: STUDIX_LIVE=1 ANTHROPIC_API_KEY=sk-ant-... pnpm test:live apps/worker
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.STUDIX_CLAUDE_LIVE_MODEL ?? "claude-haiku-5-5";
const sandboxRoot = mkdtempSync(join(tmpdir(), "studix-claude-live-"));
afterAll(() => rmSync(sandboxRoot, { recursive: true, force: true }));

describe.skipIf(!apiKey)("Claude planner (live)", () => {
  it("finds the Claude runtime on this host", async () => {
    const { version } = await preflightClaudeRuntime();
    expect(version).toMatch(/\d+\.\d+\.\d+/);
  });

  it("plans a valid VideoIR, records its cost and removes the sandbox", async () => {
    const executions: NewProviderExecution[] = [];
    const planner = createClaudePlanner({
      transport: createClaudeSdkTransport({ sandboxRoot, baseUrl: process.env.ANTHROPIC_BASE_URL }),
      credentials: {
        resolveForExecution: async () => ({ apiKey: apiKey as string }) as ResolvedProviderCredential,
        reportKeyRejected: async () => {},
      },
      executions: {
        async recordProviderExecution(_ctx, input) {
          executions.push(input);
          return { ...input, id: "pex_live" } as ProviderExecution;
        },
        async record() {
          throw new Error("a successful run is billed by the plan stage, not recorded here");
        },
      },
      model,
      maxTurns: 4,
      maxCostCents: 50,
      timeoutMs: 180_000,
      logger: createLogger({}, { write: () => {} }),
    });

    const result = await planner(
      { prompt: "A 15 second vertical brand intro for Acme Coffee, warm and minimal.", aspectRatio: "9:16" },
      {
        tenant: testTenant(),
        jobId: "job_live",
        projectId: "prj_live",
        attempt: 1,
        maxCostCents: 100,
        requestedBy: { type: "user", id: "usr_live" },
        planner: { runtime: "claude", providerConnectionId: "pcon_live" },
      },
      new AbortController().signal,
    );

    expect(validateVideoIR(result.ir).ok).toBe(true);
    expect(result.ir.scenes.length).toBeGreaterThan(0);
    const [line] = result.usage;
    expect(line?.provider).toBe("anthropic");
    expect(line?.costCents).toBeGreaterThan(0);
    expect(line?.costCents).toBeLessThan(50);
    expect(executions).toEqual([
      expect.objectContaining({ status: "succeeded", provider: "anthropic", costCents: line?.costCents }),
    ]);
    expect(await planner.idle(10_000)).toBe(true);
    expect(readdirSync(sandboxRoot)).toEqual([]);
  }, 240_000);
});
