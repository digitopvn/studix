import { ShotLayout } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import { beatLayout } from "../src/motion-graphic/motion-graphic-layouts.ts";
import { MotionStoryboard } from "../src/motion-graphic/motion-graphic-storyboard.ts";
import { motionGraphicTemplate } from "../src/motion-graphic/motion-graphic-template.ts";

const beat = (onScreen: string, layout: string | null, items: string[] | null) => ({
  onScreen,
  voiceover: onScreen,
  visual: "card",
  enter: "fade",
  weight: 1,
  layout,
  items,
});

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

describe("beat layouts", () => {
  it("parses each layout's items, keeping Vietnamese text intact", () => {
    expect(beatLayout("counter", ["1,200+", "credit mỗi tháng"])).toEqual({
      kind: "counter",
      value: "1,200",
      suffix: "+",
      label: "credit mỗi tháng",
    });
    expect(beatLayout("checklist", ["Tạo job | Xong", "Duyệt"])).toEqual({
      kind: "checklist",
      items: [{ text: "Tạo job", status: "Xong" }, { text: "Duyệt" }],
    });
    expect(beatLayout("cards-row", ["Mở đầu", "> Ưu đãi", "Kết"])).toMatchObject({
      items: ["Mở đầu", "Ưu đãi", "Kết"],
      highlight: 1,
    });
    expect(beatLayout("chips", ["Studix", "Claude", "ChatGPT"])).toMatchObject({
      source: "Studix",
      items: ["Claude", "ChatGPT"],
    });
    // Brand roles with the same colour are shown once.
    expect(
      beatLayout("swatches", [], {
        primary: "#ff4d00",
        accent: "#ff4d00",
        foreground: "#fff",
        background: "#111",
      }),
    ).toMatchObject({ colors: [{ color: "primary" }, { color: "foreground" }, { color: "background" }] });
  });

  it("drops a layout whose items do not fit, instead of failing", () => {
    expect(beatLayout("counter", ["lots", "x"])).toBeUndefined();
    expect(beatLayout("chips", ["only source"])).toBeUndefined();
    expect(beatLayout(null, ["x"])).toBeUndefined();
  });

  it("maps storyboard layouts onto shots, falls back to the headline card and keeps one background", () => {
    const storyboard = MotionStoryboard.parse({
      styleProfile: "kinetic-typography",
      brandName: "Studix",
      music: null,
      rationale: "r",
      beats: [
        beat("Mở đầu", "prompt-box", ["Làm video giới thiệu"]),
        beat("Con số", "counter", ["không có số"]),
        beat("Đếm", "stat", ["3x", "nhanh hơn"]),
        beat("Thử ngay", "stat", ["9x"]),
      ],
    });
    const ir = motionGraphicTemplate(
      { prompt: "Giới thiệu Studix", aspectRatio: "16:9", durationMs: 15_000 },
      { storyboard },
    );
    const first = (i: number) =>
      ir.scenes[i]!.shots[0] as { layout?: { kind: string }; style?: { textStyle?: string } };
    expect(first(0).layout?.kind).toBe("prompt-box");
    expect(first(1).layout).toBeUndefined();
    expect(first(1).style?.textStyle).toBe("display");
    expect(first(2).layout?.kind).toBe("stat");
    expect(ir.scenes.slice(0, -1).every((s) => s.background?.color === "background")).toBe(true);
    expect(ir.scenes.at(-1)?.background?.color).toBe("primary");
  });
});
