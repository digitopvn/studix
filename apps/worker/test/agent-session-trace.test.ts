import { parseAgentTrace, summarizeAgentTrace } from "@studix/core";
import { testTenant } from "@studix/core/testing";
import { createLogger } from "@studix/shared";
import { describe, expect, it } from "vitest";
import { createAgentEventSink } from "../src/agent-event-sink.ts";
import { createAgentSessionTrace } from "../src/agent-session-trace.ts";

const logger = createLogger({}, { level: "error", write: () => {} });

function fakeClock() {
  let now = Date.parse("2026-11-12T06:05:00Z");
  return {
    now: () => new Date(now),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function memoryStorage() {
  const objects = new Map<string, string>();
  return {
    objects,
    put: async (_ctx: unknown, key: string, body: unknown) => {
      objects.set(key, new TextDecoder().decode(body as Uint8Array));
      return { key, bytes: 0, sha256: "", contentType: "application/x-ndjson" };
    },
  };
}

describe("agent session trace", () => {
  it("keeps one line per contiguous text or reasoning block and summarizes the final message", async () => {
    const storage = memoryStorage();
    const key = "traces/jobs/job_1/motion-graphic.direction/1/0.jsonl";
    const trace = createAgentSessionTrace({ storage, ctx: testTenant(), key, clock: fakeClock(), logger });
    for (let i = 0; i < 200; i++) trace.append({ type: "reasoning", delta: "think " });
    trace.append({ type: "message", delta: '{"direction":' });
    trace.append({ type: "message", delta: '{"concept":"x"}}' });
    trace.append({ type: "usage", turns: 1, inputTokens: 1, outputTokens: 1, costCents: 1 });
    await trace.close();
    const events = parseAgentTrace(storage.objects.get(key) ?? "");
    expect(events.map((e) => e.type)).toEqual(["reasoning", "message", "turn"]);
    expect(events[0]?.delta).toBe("think ".repeat(200));
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(summarizeAgentTrace(0, events).finalMessage).toBe('{"direction":{"concept":"x"}}');
  });

  it("stores redacted events with per-turn usage, tool durations and heartbeats while the run goes", async () => {
    const clock = fakeClock();
    const storage = memoryStorage();
    let touched = 0;
    const trace = createAgentSessionTrace({
      storage,
      ctx: testTenant(),
      key: "traces/jobs/job_1/skill-agent.run/1/0.jsonl",
      clock,
      logger,
      onActivity: () => touched++,
    });
    const sink = createAgentEventSink(undefined, testTenant(), { jobId: "job_1", stage: "s" }, logger, trace);
    sink.push({
      type: "tool_start",
      id: "t1",
      name: "bash",
      args: { command: "ls", apiKey: "sk-ant-secret-123456789" },
    });
    clock.advance(4_000);
    sink.push({ type: "tool_end", id: "t1", name: "bash", ok: false, result: "boom", exitCode: 2 });
    clock.advance(1_000);
    sink.push({ type: "usage", turns: 1, inputTokens: 100, outputTokens: 10, costCents: 0.5, model: "m" });
    clock.advance(2_000);
    sink.push({ type: "usage", turns: 2, inputTokens: 250, outputTokens: 30, costCents: 1.25, model: "m" });
    await sink.flush();
    clock.advance(30_000);
    // A heartbeat stores what is there so far, before the run ends.
    await trace.heartbeat();

    const text = storage.objects.get("traces/jobs/job_1/skill-agent.run/1/0.jsonl") ?? "";
    expect(text).not.toContain("sk-ant-secret-123456789");
    const events = parseAgentTrace(text);
    expect(events.map((e) => e.type)).toEqual(["tool_start", "tool_end", "turn", "turn", "heartbeat"]);
    expect(events.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4]);
    expect(events[1]).toMatchObject({ durationMs: 4_000, exitCode: 2 });
    expect(events[3]).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      costCents: 0.75,
      latencyMs: 2_000,
    });
    expect(events[4]).toMatchObject({ idleMs: 30_000 });
    expect(touched).toBe(4);

    const summary = summarizeAgentTrace(0, events);
    expect(summary).toMatchObject({
      turns: 2,
      inputTokens: 250,
      outputTokens: 30,
      toolCalls: 1,
      toolFailures: 1,
    });
    expect(summary.slowest[0]).toMatchObject({ type: "tool", name: "bash", durationMs: 4_000 });
    expect(summary.errors[0]?.message).toContain("exit 2");
  });

  it("caps the trace and says how much it dropped", async () => {
    const storage = memoryStorage();
    const trace = createAgentSessionTrace({
      storage,
      ctx: testTenant(),
      key: "k.jsonl",
      clock: fakeClock(),
      logger,
      maxEvents: 3,
    });
    // Alternating types, so no two deltas merge into one line.
    for (let i = 0; i < 6; i++) trace.append({ type: i % 2 ? "reasoning" : "message", delta: `m${i}` });
    await trace.close();
    const events = parseAgentTrace(storage.objects.get("k.jsonl") ?? "");
    expect(events.map((e) => e.type)).toEqual(["message", "reasoning", "truncated", "truncated"]);
    expect(events.at(-1)).toMatchObject({ dropped: 3 });
  });
});
