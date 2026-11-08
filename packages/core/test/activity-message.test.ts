import { describe, expect, it } from "vitest";
import { deriveActivityMessage } from "../src/entities/activity-message.ts";

describe("deriveActivityMessage", () => {
  it("describes agent stream events from their attributes", () => {
    expect(deriveActivityMessage({ type: "tool_start", id: "t1", name: "bash" })).toBe("tool bash started");
    expect(deriveActivityMessage({ type: "tool_end", id: "t1", name: "bash", ok: false })).toBe(
      "tool bash failed",
    );
    expect(
      deriveActivityMessage({ type: "status", status: "failed", runtime: "claude", error: "boom" }),
    ).toBe("agent failed (claude): boom");
    expect(deriveActivityMessage({ type: "artifact", name: "out.mp4" })).toBe("artifact out.mp4");
    expect(deriveActivityMessage({ type: "reasoning", delta: "private chain of thought" })).toBe(
      "agent reasoning",
    );
  });

  it("redacts secrets, collapses whitespace and bounds the length", () => {
    const secret = ["Bear", "er ", "abcdefgh", "ijklmnop"].join("");
    expect(deriveActivityMessage({ type: "message", delta: `call\n with ${secret}` })).toBe(
      "agent: call with Bearer [redacted]",
    );
    const long = deriveActivityMessage({ message: "x".repeat(1000) });
    expect(long?.length).toBeLessThanOrEqual(201);
  });

  it("reads plain message-like attributes and otherwise says nothing", () => {
    expect(deriveActivityMessage({ reason: "quota exceeded" })).toBe("quota exceeded");
    expect(deriveActivityMessage({ error: { message: "provider down" } })).toBe("provider down");
    expect(deriveActivityMessage({ count: 3 })).toBeUndefined();
    expect(deriveActivityMessage({})).toBeUndefined();
  });
});
