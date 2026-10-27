import { describe, expect, it } from "vitest";
import { renderDimensions, resolveRenderSpec } from "../src/index.ts";

describe("render specs", () => {
  it("resolves presets with validated overrides", () => {
    expect(resolveRenderSpec("preview")).toMatchObject({ preset: "preview", scale: 0.5 });
    expect(resolveRenderSpec("final", { fps: 60 })).toMatchObject({ preset: "final", scale: 1, fps: 60 });
    expect(() => resolveRenderSpec("final", { scale: 2 })).toThrow();
  });

  it("computes even output dimensions", () => {
    expect(renderDimensions({ width: 1080, height: 1920 }, { scale: 0.5 })).toEqual({
      width: 540,
      height: 960,
    });
    expect(renderDimensions({ width: 1080, height: 1920 }, { scale: 0.33 })).toEqual({
      width: 356,
      height: 632,
    });
  });
});
