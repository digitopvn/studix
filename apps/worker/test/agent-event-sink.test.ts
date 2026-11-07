import { createInMemoryActivityRepository, testTenant } from "@studix/core/testing";
import { createLogger, systemClock } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { AGENT_EVENT_ACTIVITY, createAgentEventSink } from "../src/agent-event-sink.ts";

const logger = createLogger({}, { level: "error", write: () => {} });

describe("agent event sink", () => {
  it("merges deltas, keeps order and replays strictly after an offset", async () => {
    const activity = createInMemoryActivityRepository(systemClock);
    const ctx = testTenant();
    const sink = createAgentEventSink(activity, ctx, { jobId: "job_1", stage: "skill-agent.run" }, logger);
    sink.push({ type: "status", status: "running", runtime: "pi" });
    sink.push({ type: "message", delta: "Hel" });
    sink.push({ type: "message", delta: "lo" });
    sink.push({ type: "tool_start", id: "t1", name: "bash", args: { command: "ls" } });
    sink.push({ type: "reasoning", delta: "think" });
    await sink.flush();

    const rows = await activity.listAfter(ctx, { jobId: "job_1", name: AGENT_EVENT_ACTIVITY });
    expect(rows.map((r) => r.attributes)).toEqual([
      { type: "status", status: "running", runtime: "pi" },
      { type: "message", delta: "Hello" },
      { type: "tool_start", id: "t1", name: "bash", args: { command: "ls" } },
      { type: "reasoning", delta: "think" },
    ]);
    const after = await activity.listAfter(ctx, {
      jobId: "job_1",
      name: AGENT_EVENT_ACTIVITY,
      afterId: rows[1]?.id,
    });
    expect(after.map((r) => r.attributes.type)).toEqual(["tool_start", "reasoning"]);
  });

  it("keeps only a preview of large tool arguments and redacts secrets", async () => {
    const activity = createInMemoryActivityRepository(systemClock);
    const ctx = testTenant();
    const sink = createAgentEventSink(activity, ctx, { jobId: "job_2", stage: "s" }, logger);
    sink.push({ type: "tool_start", id: "t", name: "write", args: { content: "y".repeat(5000) } });
    sink.push({ type: "tool_start", id: "u", name: "bash", args: { apiKey: "sk-ant-secret-value-123456" } });
    await sink.flush();
    const [big, secret] = await activity.listAfter(ctx, { jobId: "job_2", name: AGENT_EVENT_ACTIVITY });
    expect(JSON.stringify(big?.attributes.args).length).toBeLessThan(2100);
    expect(JSON.stringify(secret?.attributes)).not.toContain("sk-ant-secret-value-123456");
  });
});
