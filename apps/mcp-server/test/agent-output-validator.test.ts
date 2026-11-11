import { describe, expect, it } from "vitest";
import { packStageOutputValidator } from "../src/compose-integrations.ts";

const storyboard = {
  styleProfile: "swiss-kinetic-editorial",
  beats: [
    { onScreen: "Hook", voiceover: "A hook line.", visual: "Big type", enter: "slide-left", weight: 1 },
    { onScreen: "Proof", voiceover: "A proof line.", visual: "Grid", enter: "pop", weight: 1.5 },
    { onScreen: "Act now", voiceover: "Act now.", visual: "Logo and CTA", enter: "scale", weight: 1 },
  ],
  music: null,
  rationale: "Swiss editorial suits a factual brand.",
};

describe("packStageOutputValidator", () => {
  const validate = packStageOutputValidator();

  it("accepts a host storyboard shaped like the outputSchema studix_get_agent_task advertises", () => {
    const check = validate("motion-graphic.storyboard", { storyboard });
    expect(check).toEqual({ ok: true, output: { source: "agent", storyboard } });
  });

  it("rejects a motion-graphic agent output without its storyboard", () => {
    const check = validate("motion-graphic.storyboard", {});
    expect(check.ok).toBe(false);
    expect(check.ok ? [] : check.issues.map((i) => i.path)).toContain("storyboard");
  });

  it("still accepts the template fallback the stage records itself", () => {
    expect(validate("motion-graphic.storyboard", { source: "template", fallbackReason: "no agent" })).toEqual(
      {
        ok: true,
        output: { source: "template", fallbackReason: "no agent" },
      },
    );
  });
});
