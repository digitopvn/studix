import { describe, expect, it } from "vitest";
import { findPiModel, listPiCatalog } from "../src/index.ts";

describe("pi anthropic catalog", () => {
  it("offers the current Claude family, newest first, and validates its ids", () => {
    const anthropic = listPiCatalog().find((p) => p.id === "anthropic");
    const ids = anthropic?.models.map((m) => m.id) ?? [];
    expect(ids.slice(0, 4)).toEqual([
      "claude-fable-5-1",
      "claude-opus-5-5",
      "claude-sonnet-5-5",
      "claude-haiku-5-5",
    ]);
    expect(ids.some((id) => id.startsWith("claude-3"))).toBe(false);
    expect(findPiModel("anthropic", "claude-opus-5-5")).toBeTruthy();
    expect(anthropic?.models.find((m) => m.id === "claude-opus-5-5")?.cost).toEqual({ input: 4, output: 20 });
  });
});
