import { validateVideoIR } from "@studix/video-ir";
import { describe, expect, it } from "vitest";
import {
  MOTION_STYLE_PROFILES,
  type MotionStyleProfile,
  motionDepthFor,
  motionGraphicTemplate,
  planCameras,
  planTransitions,
} from "../src/index.ts";

const style = (id: string) => MOTION_STYLE_PROFILES.find((p) => p.id === id) as MotionStyleProfile;

describe("motion-graphic camera grammar", () => {
  it("never gives adjacent cards the same camera move, keeping the storyboard's other picks", () => {
    const kinetic = style("kinetic-typography");
    const picks = planCameras(["parallax", "parallax", null, "static", "static", "pan-left"], kinetic);
    expect(picks[0]).toBe("parallax");
    expect(picks[3]).toBe("static");
    expect(picks[5]).toBe("pan-left");
    for (let i = 1; i < picks.length; i++) expect(picks[i]).not.toBe(picks[i - 1]);
    // An open card yields to its neighbour's explicit pick, even when the style's cycle starts there.
    expect(planCameras([null, "push-in"], kinetic)).toEqual(["pan-left", "push-in"]);
    for (const s of MOTION_STYLE_PROFILES) {
      const moves = planCameras(Array(12).fill(undefined), s);
      for (let i = 1; i < moves.length; i++) expect(moves[i]).not.toBe(moves[i - 1]);
    }
  });

  it("draws depth planes and a motif that fit the style's look and surface", () => {
    const dark = motionDepthFor(style("kinetic-typography"), "#1c1c1c");
    expect(dark.depth.background).toContain("glow");
    expect(dark.depth.foreground).toEqual(["corners"]);
    expect(motionDepthFor(style("blueprint-engineering"), "#0d3b6e").depth.background).toContain("grid");
    const poster = motionDepthFor(style("constructivist-poster"), "#efe6d2");
    expect(poster.depth.background).toEqual(["grain"]);
    expect(poster.motif.shape).toBe("square");
  });

  it("opens on a match cut, signs into the call to action and varies the cuts between", () => {
    const cuts = planTransitions(6, style("saas-bento"));
    expect(cuts.map((t) => t.kind)).toEqual(["match-cut", "wipe", "iris", "wipe", "slide"]);
    expect(planTransitions(2, style("saas-bento")).map((t) => t.kind)).toEqual(["slide"]);
  });

  it("puts the grammar on every card of the template's graphic", () => {
    const ir = motionGraphicTemplate({
      prompt: "A launch video introducing Studix",
      language: "en",
      durationMs: 20_000,
      keyMessages: ["One brief in", "A finished video out", "Edit it with your agent"],
    });
    expect(validateVideoIR(ir).ok).toBe(true);
    const cameras = ir.scenes.map((s) => s.camera);
    expect(cameras.every(Boolean)).toBe(true);
    for (let i = 1; i < cameras.length; i++) expect(cameras[i]).not.toBe(cameras[i - 1]);
    expect(ir.scenes.every((s) => s.motif && s.depth)).toBe(true);
    expect(ir.scenes[0]?.transitionOut).toEqual({ kind: "match-cut", durationMs: 0 });
    expect(ir.scenes.at(-1)?.transitionOut).toBeUndefined();
  });
});
