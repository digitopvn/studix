import { describe, expect, it } from "vitest";
import { packStageOutputValidator } from "../src/compose-integrations.ts";

const beat = (onScreen: string, enter: string) => ({
  onScreen,
  voiceover: `${onScreen}.`,
  visual: "Big type slides in",
  enter,
  weight: 1,
});

/** What a host agent returns for the motion-graphic storyboard: the `{ storyboard }` schema it was handed. */
const storyboard = {
  styleProfile: "swiss-kinetic-editorial",
  beats: [beat("Brief in", "slide-left"), beat("Video out", "pop"), beat("Try Studix", "scale")],
  music: null,
  rationale: "Swiss editorial suits a calm, factual product.",
};

describe("host agent output validation", () => {
  const validate = packStageOutputValidator();

  it("accepts a motion-graphic storyboard in the shape advertised to the host", () => {
    const check = validate("motion-graphic.storyboard", { storyboard });
    expect(check).toEqual({ ok: true, output: { source: "agent", storyboard } });
  });

  it("still rejects a storyboard that breaks the schema", () => {
    const check = validate("motion-graphic.storyboard", { storyboard: { ...storyboard, beats: [] } });
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.issues.map((i) => i.path)).toContain("storyboard.beats");
  });
});
