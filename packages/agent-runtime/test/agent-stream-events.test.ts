import type { AgentStreamEvent } from "@studix/core";
import { describe, expect, it } from "vitest";
import { claudeStreamEventsOf, codexStreamEventsOf, emitAgentEvent, eventText } from "../src/index.ts";

describe("Claude Code stream-json events", () => {
  it("turns text, thinking, tool_use and tool_result blocks into normalized events", () => {
    const names = new Map<string, string>();
    const assistant = JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Plan the intro." },
          { type: "text", text: "Rendering now." },
          { type: "tool_use", id: "t1", name: "Bash", input: { command: "npx hyperframes render" } },
        ],
      },
    });
    const user = JSON.stringify({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "ok" }] }],
      },
    });
    expect(claudeStreamEventsOf(assistant, names)).toEqual([
      { type: "reasoning", delta: "Plan the intro." },
      { type: "message", delta: "Rendering now." },
      { type: "tool_start", id: "t1", name: "Bash", args: { command: "npx hyperframes render" } },
    ]);
    expect(claudeStreamEventsOf(user, names)).toEqual([
      { type: "tool_end", id: "t1", name: "Bash", ok: true, result: "ok" },
    ]);
  });

  it("ignores lines that are not JSON or carry no content", () => {
    expect(claudeStreamEventsOf("not json", new Map())).toEqual([]);
    expect(claudeStreamEventsOf(JSON.stringify({ type: "system" }), new Map())).toEqual([]);
  });
});

describe("Codex exec --json events", () => {
  it("maps command items to tool start and end, messages and reasoning to deltas", () => {
    const item = { id: "i1", type: "command_execution", command: "ffmpeg -i a.mp4" };
    expect(codexStreamEventsOf(JSON.stringify({ type: "item.started", item }))).toEqual([
      { type: "tool_start", id: "i1", name: "bash", args: { command: "ffmpeg -i a.mp4" } },
    ]);
    const done = { ...item, aggregated_output: "done", exit_code: 1, status: "failed" };
    expect(codexStreamEventsOf(JSON.stringify({ type: "item.completed", item: done }))[1]).toEqual({
      type: "tool_end",
      id: "i1",
      name: "bash",
      ok: false,
      result: "done",
      exitCode: 1,
    });
    expect(
      codexStreamEventsOf(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Hi" } }),
      ),
    ).toEqual([{ type: "message", delta: "Hi" }]);
    expect(
      codexStreamEventsOf(
        JSON.stringify({ type: "item.completed", item: { type: "reasoning", text: "Hmm" } }),
      ),
    ).toEqual([{ type: "reasoning", delta: "Hmm" }]);
  });
});

describe("emitAgentEvent", () => {
  it("never lets a failing listener break the run", () => {
    const seen: AgentStreamEvent[] = [];
    emitAgentEvent({ onEvent: (e) => seen.push(e) }, { type: "message", delta: "a" });
    expect(seen).toHaveLength(1);
    expect(() =>
      emitAgentEvent(
        {
          onEvent: () => {
            throw new Error("boom");
          },
        },
        { type: "message", delta: "a" },
      ),
    ).not.toThrow();
  });

  it("shortens long tool results", () => {
    expect(eventText("x".repeat(700)).length).toBe(601);
  });
});
