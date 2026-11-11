import { ShotLayout, validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import {
  motionGraphicStoryboardStage,
  StoredMotionStoryboardOutput,
} from "../src/motion-graphic/motion-graphic-storyboard.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";

describe("shot layout schema", () => {
  it("accepts small typed layouts and rejects oversized or out-of-range ones", () => {
    expect(ShotLayout.safeParse({ kind: "counter", value: "1,200", suffix: "+" }).success).toBe(true);
    expect(ShotLayout.safeParse({ kind: "counter", value: "nhiều" }).success).toBe(false);
    expect(ShotLayout.safeParse({ kind: "cards-row", items: ["a", "b"], highlight: 2 }).success).toBe(false);
    expect(
      ShotLayout.safeParse({ kind: "chips", source: "x", items: ["a", "b", "c", "d", "e", "f"] }).success,
    ).toBe(false);
  });
});

describe("stored storyboards", () => {
  const beat = (onScreen: string, layout: unknown, items?: string[]) => ({
    onScreen,
    voiceover: onScreen,
    visual: "card",
    enter: "fade",
    weight: 1,
    layout,
    ...(items ? { items } : {}),
  });

  it("reads a beat that named its layout kind as a string, keeping its words and dropping the device", () => {
    const stored = StoredMotionStoryboardOutput.parse({
      source: "agent",
      storyboard: {
        styleProfile: "kinetic-typography",
        brandName: "Studix",
        music: null,
        rationale: "r",
        beats: [
          beat("Mở đầu", "prompt-box", ["Làm video giới thiệu"]),
          beat("Đếm", { kind: "stat", value: "3x", label: "nhanh hơn" }),
          beat("Thử ngay", null),
        ],
      },
    });
    const beats = stored.storyboard?.beats ?? [];
    expect(beats.map((b) => b.onScreen)).toEqual(["Mở đầu", "Đếm", "Thử ngay"]);
    expect(beats[0]?.layout).toBeUndefined();
    expect(beats[1]?.layout).toEqual({ kind: "stat", value: "3x", label: "nhanh hơn" });

    const ir = motionGraphicTemplate(
      { prompt: "Giới thiệu Studix", aspectRatio: "16:9", durationMs: 15_000 },
      { storyboard: stored.storyboard },
    );
    expect(validateVideoIR(ir).ok).toBe(true);
    expect(ir.scenes[0]?.shots.some((s) => s.type === "layout")).toBe(false);
    expect(ir.scenes[1]?.shots.find((s) => s.type === "layout")).toMatchObject({ layout: { kind: "stat" } });
  });

  it("accepts a host hand-in that follows the earlier kind-and-items schema", () => {
    const parsed = motionGraphicStoryboardStage.hostOutputSchema?.safeParse({
      storyboard: {
        styleProfile: "kinetic-typography",
        brandName: null,
        music: null,
        rationale: "r",
        beats: [
          beat("Mở đầu", null),
          beat("Kết nối", "chips", ["Studix", "Claude", "Cursor"]),
          beat("Thử ngay", null),
        ],
      },
    });
    expect(parsed?.error?.issues ?? []).toEqual([]);
  });
});
