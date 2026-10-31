import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeSdkTransport, preflightClaudeRuntime } from "@studix/agent-runtime";
import type { ResolvedProviderCredential } from "@studix/auth";
import type { NewProviderExecution, NewUsageEvent } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { createLogger } from "@studix/shared";
import { validateVideoIR } from "@studix/video-ir";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createClaudePlanner } from "../src/planner/claude-planner.ts";
import { prepareClaudeSandboxRoot } from "../src/planner/claude-sandbox.ts";

/**
 * Smoke tests of the Claude planner against the real Anthropic API: collected only with STUDIX_LIVE=1 and
 * skipped without ANTHROPIC_API_KEY. The plan test spends at most STUDIX_CLAUDE_LIVE_MAX_COST_CENTS
 * (default 100); the rejected-key test uses a made-up key that Anthropic refuses before running a model.
 * Run: STUDIX_LIVE=1 ANTHROPIC_API_KEY=sk-ant-... pnpm test:live apps/worker
 */
const apiKey = process.env.ANTHROPIC_API_KEY;
const model = process.env.STUDIX_CLAUDE_LIVE_MODEL ?? "claude-sonnet-5-5";
const configuredCap = Number(process.env.STUDIX_CLAUDE_LIVE_MAX_COST_CENTS ?? 100);
const maxCostCents = Number.isFinite(configuredCap) && configuredCap > 0 ? configuredCap : 100;
const logger = createLogger({}, { write: () => {} });

const brief = {
  prompt: "A 10 second vertical teaser for Acme Coffee's new cold brew.",
  aspectRatio: "9:16" as const,
  durationMs: 10_000,
};
const plannerContext = {
  tenant: testTenant(),
  jobId: "job_live",
  projectId: "prj_live",
  attempt: 1,
  maxCostCents,
  requestedBy: { type: "user", id: "usr_live" } as const,
  planner: { runtime: "claude", providerConnectionId: "pcn_live" } as const,
};

let scratch: string;
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "studix-claude-live-"));
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

function livePlanner(key: string) {
  const sandboxRoot = prepareClaudeSandboxRoot(join(scratch, "claude"), 600_000, logger);
  const executions: NewProviderExecution[] = [];
  const usage: NewUsageEvent[] = [];
  let rejected = 0;
  const planner = createClaudePlanner({
    transport: createClaudeSdkTransport({ sandboxRoot, baseUrl: process.env.ANTHROPIC_BASE_URL }),
    credentials: {
      async resolveForExecution() {
        return {
          apiKey: key,
          async markRejected() {
            rejected++;
          },
        } as unknown as ResolvedProviderCredential;
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
  return {
    planner,
    sandboxRoot,
    executions,
    usage,
    get rejected() {
      return rejected;
    },
  };
}

/** The planner has returned, so its session is closed and the throwaway directory must be gone. */
function sandboxesLeft(root: string): string[] {
  expect(existsSync(root)).toBe(true);
  return readdirSync(root).filter((name) => name.startsWith("studix-claude-"));
}

describe.skipIf(!apiKey)("Claude planner (live)", () => {
  it("runs on this host, plans a valid VideoIR, records its cost and removes the sandbox", async () => {
    const runtime = await preflightClaudeRuntime();
    expect(runtime, runtime.ok ? "" : runtime.reason).toMatchObject({ ok: true });

    const run = livePlanner(apiKey as string);
    const result = await run.planner(brief, plannerContext, new AbortController().signal);

    expect(validateVideoIR(result.ir).ok).toBe(true);
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.costCents).toBeGreaterThan(0);
    expect(result.usage[0]?.costCents).toBeLessThanOrEqual(maxCostCents);
    expect(run.executions).toEqual([expect.objectContaining({ provider: "anthropic", status: "succeeded" })]);
    expect(run.usage).toEqual([]);
    expect(run.rejected).toBe(0);
    expect(sandboxesLeft(run.sandboxRoot)).toEqual([]);
  });

  it("classifies a key Anthropic rejects as UNAUTHENTICATED, reports it and removes the sandbox", async () => {
    const run = livePlanner(`sk-ant-api03-${"x".repeat(40)}-AAAA`);
    await expect(run.planner(brief, plannerContext, new AbortController().signal)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      retryable: false,
    });
    expect(run.rejected).toBe(1);
    expect(run.executions).toEqual([expect.objectContaining({ status: "failed" })]);
    expect(sandboxesLeft(run.sandboxRoot)).toEqual([]);
  });
});
