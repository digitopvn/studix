import type { AgentTask } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { describe, expect, it } from "vitest";
import {
  type ClaudeAgentEvent,
  type ClaudeAgentSession,
  type ClaudeSessionRequest,
  createClaudeAgentRuntime,
  mapClaudeError,
} from "../src/index.ts";

const task = (overrides: Partial<AgentTask> = {}): AgentTask => ({
  skill: "brand-intro",
  instructions: "Plan",
  input: {},
  tools: [{ name: "read_asset", description: "read", inputSchema: {} }],
  maxCostCents: 50,
  maxTurns: 4,
  ...overrides,
});

interface FakeProcess {
  session: ClaudeAgentSession;
  push(event: ClaudeAgentEvent): void;
  end(): void;
  state: { interrupts: number; kills: number; closed: boolean };
}

/** In-memory agent process. `exitOn` decides whether it stops on interrupt, kill, or never. */
function fakeProcess(exitOn: "interrupt" | "kill" | "never" = "interrupt"): FakeProcess {
  const queue: ClaudeAgentEvent[] = [];
  let wake: (() => void) | undefined;
  let finished = false;
  const state = { interrupts: 0, kills: 0, closed: false };
  let markClosed!: () => void;
  const closed = new Promise<void>((r) => {
    markClosed = () => {
      state.closed = true;
      r();
    };
  });
  const end = () => {
    finished = true;
    wake?.();
    markClosed();
  };
  const session: ClaudeAgentSession = {
    events: {
      async *[Symbol.asyncIterator]() {
        while (true) {
          if (queue.length) yield queue.shift()!;
          else if (finished) return;
          else await new Promise<void>((r) => (wake = r));
        }
      },
    },
    interrupt() {
      state.interrupts++;
      if (exitOn === "interrupt") end();
    },
    kill() {
      state.kills++;
      if (exitOn !== "never") end();
    },
    closed,
  };
  return {
    session,
    state,
    push(e) {
      queue.push(e);
      wake?.();
    },
    end,
  };
}

function setup(proc: FakeProcess, extra: Partial<Parameters<typeof createClaudeAgentRuntime>[0]> = {}) {
  const requests: ClaudeSessionRequest[] = [];
  const runtime = createClaudeAgentRuntime({
    model: "claude-test",
    killAfterMs: 20,
    closeTimeoutMs: 20,
    credentials: { resolve: async () => "sk-ant-secret" },
    transport: {
      start(req) {
        requests.push(req);
        return proc.session;
      },
    },
    ...extra,
  });
  return { runtime, requests };
}

const started = async (requests: unknown[]) => {
  while (requests.length === 0) await new Promise((r) => setTimeout(r, 1));
};

describe("claude agent runtime", () => {
  it("returns validated output with usage and passes only the task's tools and caps", async () => {
    const proc = fakeProcess();
    const { runtime, requests } = setup(proc);
    proc.push({ type: "usage", turns: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.12 });
    proc.push({ type: "result", output: { ok: true } });
    proc.end();
    const result = await runtime.run(testTenant(), task());
    expect(result).toMatchObject({ output: { ok: true }, turns: 2, costCents: 12, model: "claude-test" });
    expect(requests[0]).toMatchObject({ allowedTools: ["read_asset"], maxTurns: 4, maxBudgetUsd: 0.5 });
    // The run has settled, so even declared tools are denied now.
    expect(await requests[0]!.canUseTool("read_asset", {})).toBe(false);
  });

  it("allows only declared tools while running", async () => {
    const proc = fakeProcess();
    const { runtime, requests } = setup(proc);
    const running = runtime.run(testTenant(), task());
    await started(requests);
    expect(await requests[0]!.canUseTool("read_asset", {})).toBe(true);
    expect(await requests[0]!.canUseTool("bash", {})).toBe(false);
    proc.push({ type: "result", output: { ok: 1 } });
    proc.end();
    await running;
  });

  it("stops the process mid-run when the budget is exceeded", async () => {
    const proc = fakeProcess();
    const { runtime } = setup(proc);
    proc.push({ type: "usage", turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.51 });
    await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(proc.state).toMatchObject({ interrupts: 1, closed: true });
  });

  it("stops the process when turns are exceeded", async () => {
    const proc = fakeProcess();
    const { runtime } = setup(proc);
    proc.push({ type: "usage", turns: 5, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
    expect(proc.state.closed).toBe(true);
  });

  it("interrupts on abort, denies tools afterwards, and settles only after the process closed", async () => {
    const proc = fakeProcess("interrupt");
    const { runtime, requests } = setup(proc);
    const controller = new AbortController();
    const running = runtime.run(testTenant(), task({ signal: controller.signal }));
    await started(requests);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(proc.state).toMatchObject({ interrupts: 1, closed: true });
    expect(await requests[0]!.canUseTool("read_asset", {})).toBe(false);
  });

  it("hard-kills a process that ignores interrupt", async () => {
    const proc = fakeProcess("kill");
    const { runtime, requests } = setup(proc);
    const controller = new AbortController();
    const running = runtime.run(testTenant(), task({ signal: controller.signal }));
    await started(requests);
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(proc.state.kills).toBeGreaterThanOrEqual(1);
    expect(proc.state.closed).toBe(true);
  });

  it("reports INTERNAL when the process survives a kill", async () => {
    const proc = fakeProcess("never");
    const { runtime } = setup(proc);
    const running = runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() + 20) }));
    await expect(running).rejects.toMatchObject({ code: "INTERNAL" });
    expect(proc.state.kills).toBeGreaterThanOrEqual(1);
  });

  it("times out on the deadline and interrupts", async () => {
    const proc = fakeProcess();
    const { runtime } = setup(proc);
    await expect(
      runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() + 20) })),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(proc.state.closed).toBe(true);
  });

  it("does not start a session for an already aborted signal or invalid task", async () => {
    const proc = fakeProcess();
    const { runtime, requests } = setup(proc);
    const controller = new AbortController();
    controller.abort();
    await expect(runtime.run(testTenant(), task({ signal: controller.signal }))).rejects.toMatchObject({
      code: "CANCELLED",
    });
    await expect(runtime.run(testTenant(), task({ maxTurns: 0 }))).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(requests).toHaveLength(0);
  });

  it("propagates credential errors without starting a session", async () => {
    const proc = fakeProcess();
    const { runtime, requests } = setup(proc, {
      credentials: {
        resolve: async () => {
          throw Object.assign(new Error("no key"), { name: "StudixError" });
        },
      },
    });
    await expect(runtime.run(testTenant(), task())).rejects.toThrow("no key");
    expect(requests).toHaveLength(0);
  });

  it("rejects invalid output and a missing result", async () => {
    const proc = fakeProcess();
    const { runtime } = setup(proc, {
      validateOutput: () => {
        throw new Error("bad IR");
      },
    });
    proc.push({ type: "result", output: { nope: 1 } });
    proc.end();
    await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "PROVIDER_ERROR" });

    const empty = fakeProcess();
    const second = setup(empty);
    empty.end();
    await expect(second.runtime.run(testTenant(), task())).rejects.toMatchObject({
      code: "PROVIDER_ERROR",
    });
  });

  it("maps upstream errors and never leaks keys", async () => {
    for (const [status, code] of [
      [401, "UNAUTHENTICATED"],
      [403, "FORBIDDEN"],
      [429, "RATE_LIMITED"],
      [500, "PROVIDER_ERROR"],
    ] as const) {
      const proc = fakeProcess();
      const { runtime } = setup(proc);
      proc.push({ type: "error", status, message: "boom sk-ant-api03-abc_DEF" });
      proc.end();
      await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ code });
    }
    expect(mapClaudeError(500, "key sk-ant-api03-abc_DEF").message).not.toContain("sk-ant");
  });
  it("aborts during a slow credential lookup without starting a session", async () => {
    const proc = fakeProcess();
    const { runtime, requests } = setup(proc, {
      credentials: { resolve: () => new Promise((r) => setTimeout(() => r("sk-ant-x"), 50)) },
    });
    const controller = new AbortController();
    const running = runtime.run(testTenant(), task({ signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    await expect(running).rejects.toMatchObject({ code: "CANCELLED" });
    expect(requests).toHaveLength(0);
  });

  it("ends the run on an error event even if the stream stays open", async () => {
    const proc = fakeProcess();
    const { runtime } = setup(proc);
    proc.push({ type: "error", status: 401, message: "bad key" });
    await expect(runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(proc.state.closed).toBe(true);
  });

  it("returns the result even if the stream stays open, then closes the process", async () => {
    const proc = fakeProcess();
    const { runtime } = setup(proc);
    proc.push({ type: "result", output: { ok: 1 } });
    await expect(runtime.run(testTenant(), task())).resolves.toMatchObject({ output: { ok: 1 } });
    expect(proc.state).toMatchObject({ interrupts: 1, closed: true });
  });

  it("maps errors thrown by the event stream and redacts keys", async () => {
    const proc = fakeProcess();
    const { runtime } = setup(proc);
    proc.session.events[Symbol.asyncIterator] = () => ({
      next: () => Promise.reject(new Error("401 invalid x-api-key sk-ant-api03-SECRET")),
    });
    const err = await runtime.run(testTenant(), task()).catch((e) => e);
    expect(err).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(String(err.message)).not.toContain("SECRET");
  });

  it("tolerates a rejecting closed promise", async () => {
    const proc = fakeProcess();
    const rejecting = {
      ...proc.session,
      closed: proc.session.closed.then(() => {
        throw new Error("exit code 143");
      }),
    };
    const { runtime } = setup({ ...proc, session: rejecting });
    const running = runtime.run(testTenant(), task({ deadlineAt: new Date(Date.now() + 20) }));
    await expect(running).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("never lets cumulative usage go down and rejects non-finite usage", async () => {
    const proc = fakeProcess();
    const { runtime } = setup(proc);
    proc.push({ type: "usage", turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.4 });
    proc.push({ type: "usage", turns: 1, inputTokens: 1, outputTokens: 1, costUsd: 0.1 });
    proc.push({ type: "result", output: 1 });
    await expect(runtime.run(testTenant(), task())).resolves.toMatchObject({ costCents: 40 });
    const bad = fakeProcess();
    const second = setup(bad);
    bad.push({ type: "usage", turns: Number.NaN, inputTokens: 1, outputTokens: 1, costUsd: 0 });
    await expect(second.runtime.run(testTenant(), task())).rejects.toMatchObject({ code: "PROVIDER_ERROR" });
  });
});
