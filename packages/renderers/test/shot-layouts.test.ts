import { lintProject } from "@hyperframes/lint";
import { buildSequentialTimeline, type ShotLayout, type VideoIR, validateVideoIR } from "@studix/video-ir";
import { afterAll, describe, expect, it } from "vitest";
import { layoutTiming } from "../src/hyperframes/shot-layout-kit.ts";
import { buildComposition, writeComposition } from "../src/index.ts";
import { tempDir } from "./render-test-helpers.ts";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((c) => c()));
});

const layouts: ShotLayout[] = [
  { kind: "prompt-box", text: "Làm video giới thiệu quán cà phê" },
  { kind: "code", lines: ['{ "studix": true }', "}"], highlight: 0 },
  { kind: "chips", source: "Studix", items: ["Claude", "ChatGPT"] },
  { kind: "checklist", items: [{ text: "Tạo job", status: "Xong" }, { text: "Duyệt" }] },
  { kind: "counter", value: "1,200", suffix: "+", label: "credit" },
  { kind: "cards-row", items: ["Mở đầu", "Ưu đãi"], highlight: 1 },
  { kind: "swatches", colors: [{ color: "accent" }, { color: "#112233", label: "Đêm" }] },
  { kind: "stat", value: "3x", label: "nhanh hơn" },
];

function irWith(): VideoIR {
  const scenes = layouts.map((layout, i) => ({
    id: `s${i}`,
    role: "feature" as const,
    durationMs: 2000,
    shots: [
      {
        id: `t${i}`,
        type: "text" as const,
        startMs: 0,
        durationMs: 2000,
        text: `Tiêu đề ${i}`,
        layout,
        animation: { enter: "fade" as const, exit: "fade" as const, durationMs: 300 },
      },
    ],
  }));
  const ir = {
    schemaVersion: 1,
    title: "layouts",
    language: "vi",
    format: { aspectRatio: "16:9", width: 1920, height: 1080, fps: 30, durationMs: 16_000 },
    assets: [],
    scenes,
    timeline: buildSequentialTimeline(scenes),
  };
  const result = validateVideoIR(ir);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.value;
}

describe("layout devices", () => {
  it("renders every layout with scoped, seek-safe markup that passes the HyperFrames lint", async () => {
    const build = buildComposition(irWith(), { width: 960, height: 540 });
    const html = (i: number) => build.files.get(`compositions/s${i}.html`)!;
    expect(html(0)).toContain('class="lay lay-prompt-box"');
    // Typed a grapheme at a time: a Vietnamese letter keeps its marks.
    expect(html(0)).toMatch(/class="pb-g pb-g-\d+">ệ</);
    expect(html(4)).toContain("ct-strip");
    expect(html(7)).toContain(">3x<");
    for (let i = 0; i < layouts.length; i++) {
      expect(html(i)).not.toMatch(/Math\.random|Date\.now|repeat|onUpdate|https?:\/\//);
      expect(html(i)).toContain(`#s-s${i}__shot-t${i} > .lay-inner`);
    }
    const { dir, cleanup } = await tempDir("layouts");
    cleanups.push(cleanup);
    await writeComposition(build, dir);
    const result = await lintProject(dir);
    const errors = result.results.flatMap((r) => r.result.findings.filter((f) => f.severity === "error"));
    expect(errors).toEqual([]);
  });

  it("fills about 60% of a landscape frame and keeps captions readable", () => {
    const ir = irWith();
    const cue = { startMs: 0, endMs: 1500, text: "Một dòng" };
    const build = buildComposition(
      { ...ir, captions: { language: "vi", mode: "burned", position: "bottom", cues: [cue] } },
      { width: 1920, height: 1080 },
    );
    const html = (i: number) => build.files.get(`compositions/s${i}.html`)!;
    const px = (css: string, rule: RegExp) => Number(css.match(rule)?.[1]);
    // The checklist takes the landscape width share (62% of 1920), not a portrait-sized box.
    expect(px(html(3), /\.lay-checklist \{[^}]*?width: (\d+)px/)).toBe(1190);
    // Swatches grow with the frame's aspect rather than staying at their 1080-edge size.
    expect(px(html(6), /\.sw-dot \{[^}]*?width: (\d+)px/)).toBeGreaterThan(200);
    expect(px(html(0), /\.cue \{[^}]*?font-size: (\d+)px/)).toBeGreaterThanOrEqual(36);
  });

  it("starts the device at the cue the shot names, keeping the shortest choreography before the exit", () => {
    // Default lead: 10% of a 4 s shot.
    expect(layoutTiming(1000, 4000, 300).t0).toBe(1.35);
    // A cue 1.2 s in starts the device there.
    expect(layoutTiming(1000, 4000, 300, 1200)).toMatchObject({ t0: 2.2, holdEnd: 4.7 });
    // A late cue moves earlier so 0.5 s still fits before the exit; a cue past a tiny shot starts at the shot.
    const late = layoutTiming(1000, 4000, 300, 3900);
    expect(late.t0).toBe(4.2);
    expect(late.holdStart).toBeLessThanOrEqual(late.holdEnd);
    expect(layoutTiming(1000, 400, 0, 300).t0).toBe(1);
  });
});
